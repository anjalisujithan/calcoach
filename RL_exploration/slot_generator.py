"""
slot_generator.py

Validates and filters LLM-suggested scheduling candidates against a user's real calendar.

Architecture:
  LLM layer         → extracts TaskRequest + generates K creative CandidateSchedule suggestions
  ScheduleValidator → filters out any candidates that violate hard constraints
  Contextual bandit → ranks the valid survivors for this specific user

Input contract (from the Google Calendar integration module):
  calendar_json: Dict[str, List[str]]
    Keys are weekday names: "Monday" … "Sunday"
    Values are lists of busy time ranges in military-time format: "0800-0930"
    Example:
      {
        "Monday":    ["0800-0930", "1200-1300"],
        "Tuesday":   ["0900-1100"],
        "Wednesday": [],
      }

Output:
  List[CandidateSchedule] — only the LLM suggestions that pass all hard constraints.
"""

from __future__ import annotations

from datetime import time
from typing import Dict, List, Tuple

from calcoach.user_profile import UserPreferences
from calcoach.models import (
    Block,
    CandidateSchedule,
    DAY_ORDER,
    MIN_VIABLE_CHUNK_MINUTES,
    TaskRequest,
)


# ---------------------------------------------------------------------------
# Time parsing helpers (using built-in Python time library)
# ---------------------------------------------------------------------------

def _parse_hhmm(t: str) -> time:
    """Parse "HHMM" or "HH:MM" into a time object. E.g. "0830" → time(8, 30)."""
    t = t.replace(":", "").strip()
    if len(t) != 4 or not t.isdigit():
        raise ValueError(f"Cannot parse time string: '{t}'. Expected HHMM format.")
    return time(int(t[:2]), int(t[2:]))


def _parse_busy_slot(slot_str: str) -> Tuple[time, time]:
    """Parse "0800-0930" into (time(8,0), time(9,30))."""
    parts = slot_str.strip().split("-")
    if len(parts) != 2:
        raise ValueError(f"Cannot parse busy slot: '{slot_str}'. Expected 'HHMM-HHMM'.")
    start = _parse_hhmm(parts[0])
    end = _parse_hhmm(parts[1])
    if end <= start:
        raise ValueError(f"Busy slot end must be after start in '{slot_str}'.")
    return start, end


def _to_minutes(t: time) -> int:
    return t.hour * 60 + t.minute


def _to_time(minutes: int) -> time:
    minutes = max(0, min(minutes, 23 * 60 + 59))
    return time(minutes // 60, minutes % 60)


def _free_windows_for_day(
    busy_slots: List[Tuple[time, time]],
    work_start: time,
    work_end: time,
    buffer_minutes: int,
) -> List[Tuple[time, time]]:
    """
    Given busy slots for a single day, return free windows within work hours.

    Steps:
      1. Expand each busy slot by buffer_minutes on each side
      2. Clamp to [work_start, work_end]
      3. Merge overlapping blocked intervals
      4. Return the gaps
    """
    ws = _to_minutes(work_start)
    we = _to_minutes(work_end)

    blocked: List[List[int]] = []
    for start, end in busy_slots:
        s = max(ws, _to_minutes(start) - buffer_minutes)
        e = min(we, _to_minutes(end) + buffer_minutes)
        if s < e:
            blocked.append([s, e])

    blocked.sort(key=lambda x: x[0])
    merged: List[List[int]] = []
    for s, e in blocked:
        if merged and s <= merged[-1][1]:
            merged[-1][1] = max(merged[-1][1], e)
        else:
            merged.append([s, e])

    free: List[Tuple[time, time]] = []
    cursor = ws
    for s, e in merged:
        if cursor < s and (s - cursor) >= MIN_VIABLE_CHUNK_MINUTES:
            free.append((_to_time(cursor), _to_time(s)))
        cursor = max(cursor, e)
    if cursor < we and (we - cursor) >= MIN_VIABLE_CHUNK_MINUTES:
        free.append((_to_time(cursor), _to_time(we)))

    return free


# ---------------------------------------------------------------------------
# ScheduleValidator
# ---------------------------------------------------------------------------

class ScheduleValidator:
    """
    Validates LLM-proposed CandidateSchedules against the user's real calendar.

    Usage:
        validator = ScheduleValidator(preferences)
        valid_candidates = validator.filter_candidates(llm_candidates, calendar_json, task)
    """

    def __init__(self, preferences: UserPreferences) -> None:
        self.prefs = preferences

    def get_all_free_windows(
        self, calendar_json: Dict[str, List[str]]
    ) -> Dict[str, List[Tuple[time, time]]]:
        """
        Parse the busy calendar JSON and return free windows per day.
        Days absent from calendar_json are treated as fully free (within work hours).
        Days in avoid_days return empty windows regardless.
        """
        work_start = _parse_hhmm(self.prefs.work_start)
        work_end = _parse_hhmm(self.prefs.work_end)

        result: Dict[str, List[Tuple[time, time]]] = {}
        for day in DAY_ORDER:
            if day in self.prefs.avoid_days:
                result[day] = []
                continue
            busy_strs = calendar_json.get(day, [])
            busy_slots = [_parse_busy_slot(s) for s in busy_strs]
            result[day] = _free_windows_for_day(
                busy_slots, work_start, work_end, self.prefs.buffer_minutes
            )
        return result

    def validate_block(
        self,
        block: Block,
        free_windows: Dict[str, List[Tuple[time, time]]],
        deadline_day: str,
        min_chunk_minutes: int = MIN_VIABLE_CHUNK_MINUTES,
    ) -> Tuple[bool, str]:
        """
        Check whether a single Block satisfies all hard constraints.

        Returns:
            (True, "") if valid
            (False, reason) if invalid — reason explains which constraint failed
        """
        if block.day in self.prefs.avoid_days:
            return False, f"{block.day} is in avoid_days"

        if block.day not in DAY_ORDER:
            return False, f"Unknown day: {block.day}"

        deadline_idx = DAY_ORDER.index(deadline_day) if deadline_day in DAY_ORDER else len(DAY_ORDER) - 1
        if DAY_ORDER.index(block.day) > deadline_idx:
            return False, f"{block.day} is after deadline {deadline_day}"

        if block.duration_minutes < min_chunk_minutes:
            return False, f"Block duration {block.duration_minutes}min < minimum {min_chunk_minutes}min"

        day_windows = free_windows.get(block.day, [])
        for w_start, w_end in day_windows:
            if block.start >= w_start and block.end <= w_end:
                return True, ""

        return False, (
            f"{block} does not fit in any free window on {block.day}. "
            f"Free windows: {[(w[0].strftime('%H%M'), w[1].strftime('%H%M')) for w in day_windows]}"
        )

    def validate_candidate(
        self,
        candidate: CandidateSchedule,
        free_windows: Dict[str, List[Tuple[time, time]]],
        task: TaskRequest,
    ) -> Tuple[bool, str]:
        """
        Check whether a full CandidateSchedule satisfies all hard constraints.

        Checks (in order):
          1. Every block passes validate_block
          2. No two blocks overlap on the same day
          3. Daily workload cap not exceeded
          4. Total duration covers the task requirement
        """
        if not candidate.blocks:
            return False, "Candidate has no blocks"

        for block in candidate.blocks:
            ok, reason = self.validate_block(block, free_windows, task.deadline_day, task.min_chunk_minutes)
            if not ok:
                return False, reason

        by_day: Dict[str, List[Block]] = {}
        for block in candidate.blocks:
            by_day.setdefault(block.day, []).append(block)

        for day, blocks in by_day.items():
            sorted_blocks = sorted(blocks, key=lambda b: b.start)
            for i in range(len(sorted_blocks) - 1):
                if sorted_blocks[i].end > sorted_blocks[i + 1].start:
                    return False, (
                        f"Overlapping blocks on {day}: "
                        f"{sorted_blocks[i]} and {sorted_blocks[i+1]}"
                    )

        for day, blocks in by_day.items():
            day_total = sum(b.duration_minutes for b in blocks)
            if day_total > self.prefs.max_daily_work_minutes:
                return False, (
                    f"{day} total {day_total}min exceeds daily cap "
                    f"{self.prefs.max_daily_work_minutes}min"
                )

        if candidate.total_minutes < task.total_duration_minutes:
            return False, (
                f"Candidate covers {candidate.total_minutes}min but task needs "
                f"{task.total_duration_minutes}min"
            )

        return True, ""

    def filter_candidates(
        self,
        candidates: List[CandidateSchedule],
        calendar_json: Dict[str, List[str]],
        task: TaskRequest,
    ) -> List[CandidateSchedule]:
        """
        Filter LLM-proposed candidates, returning only those that pass all hard constraints.
        Returns an empty list if none are valid (caller should ask LLM to retry).
        """
        free_windows = self.get_all_free_windows(calendar_json)
        return [c for c in candidates if self.validate_candidate(c, free_windows, task)[0]]

    def filter_candidates_with_reasons(
        self,
        candidates: List[CandidateSchedule],
        calendar_json: Dict[str, List[str]],
        task: TaskRequest,
    ) -> List[Tuple[CandidateSchedule, bool, str]]:
        """
        Same as filter_candidates but returns (candidate, is_valid, reason) for every input.
        Useful for debugging LLM output quality or feeding rejection reasons back to the LLM.
        """
        free_windows = self.get_all_free_windows(calendar_json)
        return [
            (c, *self.validate_candidate(c, free_windows, task))
            for c in candidates
        ]
