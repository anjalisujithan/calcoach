"""
slot_generator.py

Generates feasible scheduling candidate sets from a user's busy calendar.

Input contract (from the Google Calendar integration module):
  calendar_json: Dict[str, List[str]]
    Keys are weekday names: "Monday" … "Sunday"
    Values are lists of busy time ranges in military-time format: "0800-0930"
    Example:
      {
        "Monday":    ["0800-0930", "1200-1300", "2300-2330"],
        "Tuesday":   ["0900-1100", "1800-1930"],
        "Wednesday": [],
        "Thursday":  ["1400-1530"],
        "Friday":    [],
      }

Output:
  List[CandidateSchedule] — up to K diverse complete schedules, each
  consisting of one or more non-overlapping Blocks that together cover
  a task's total required duration.

Pure deterministic constraint-enforcing logic.
The contextual bandit (contextual_bandit.py) ranks these candidates;
this module only ensures they are all feasible.
"""

from __future__ import annotations

from dataclasses import dataclass, field
from datetime import time
from typing import Dict, List, Optional, Tuple

from calcoach.user_profile import UserPreferences


# ---------------------------------------------------------------------------
# Constants
# ---------------------------------------------------------------------------

DAY_ORDER: List[str] = [
    "Monday", "Tuesday", "Wednesday", "Thursday",
    "Friday", "Saturday", "Sunday",
]

# Never create a block shorter than this — avoids tiny unusable slivers
MIN_VIABLE_CHUNK_MINUTES: int = 20


# ---------------------------------------------------------------------------
# Shared data classes (used by feature_extractor and contextual_bandit too)
# ---------------------------------------------------------------------------

@dataclass
class Block:
    """A single scheduled time block on a specific day."""
    day: str
    start: time
    end: time
    duration_minutes: int

    def __repr__(self) -> str:
        return (
            f"Block({self.day} "
            f"{self.start.strftime('%H%M')}–{self.end.strftime('%H%M')}, "
            f"{self.duration_minutes}min)"
        )

    def __eq__(self, other: object) -> bool:
        if not isinstance(other, Block):
            return NotImplemented
        return (self.day, self.start, self.end) == (other.day, other.start, other.end)

    def __hash__(self) -> int:
        return hash((self.day, self.start, self.end))


@dataclass
class CandidateSchedule:
    """
    A complete schedule option: one or more Blocks that together cover a task.
    The 'strategy' label is carried through for feature extraction and debugging.
    """
    blocks: List[Block]
    total_minutes: int
    strategy: str

    # --- Derived properties used by FeatureExtractor ---

    @property
    def span_days(self) -> int:
        """Number of distinct days across all blocks."""
        return len({b.day for b in self.blocks})

    @property
    def earliest_day_index(self) -> int:
        """Index into DAY_ORDER of the earliest day in this schedule."""
        return min(
            DAY_ORDER.index(b.day) for b in self.blocks if b.day in DAY_ORDER
        )

    @property
    def latest_day_index(self) -> int:
        """Index into DAY_ORDER of the latest day in this schedule."""
        return max(
            DAY_ORDER.index(b.day) for b in self.blocks if b.day in DAY_ORDER
        )

    @property
    def avg_start_hour(self) -> float:
        """Mean start hour across all blocks (decimal, 0–24)."""
        return sum(b.start.hour + b.start.minute / 60 for b in self.blocks) / len(self.blocks)

    @property
    def avg_block_duration(self) -> float:
        """Mean block duration in minutes."""
        return sum(b.duration_minutes for b in self.blocks) / len(self.blocks)

    def fingerprint(self) -> frozenset:
        """
        Order-independent identity key for deduplication.
        Two candidates are considered duplicates if they contain exactly the same blocks.
        """
        return frozenset((b.day, b.start, b.end) for b in self.blocks)

    def __repr__(self) -> str:
        blocks_str = ", ".join(repr(b) for b in self.blocks)
        return f"CandidateSchedule([{blocks_str}], strategy='{self.strategy}')"


@dataclass
class TaskRequest:
    """
    Specifies what the user wants to schedule.
    Produced by the LLM layer from natural-language input.
    """
    task_name: str
    total_duration_minutes: int           # total work time needed
    task_type: str                        # "reading" | "problem_set" | "writing" | "other"
    deadline_day: str                     # "Thursday" — the last valid day for any block
    preferred_chunk_minutes: Optional[int] = None  # overrides UserPreferences default
    min_chunk_minutes: int = MIN_VIABLE_CHUNK_MINUTES
    max_chunk_minutes: int = 120


# ---------------------------------------------------------------------------
# Internal helpers
# ---------------------------------------------------------------------------
# using built in python time library 

def _parse_hhmm(t: str) -> time:
    """
    Parse a time string in "HHMM" or "HH:MM" format into a datetime.time.
    Examples: "0830" → time(8, 30),  "14:00" → time(14, 0)
    """
    t = t.replace(":", "").strip()
    if len(t) != 4 or not t.isdigit():
        raise ValueError(f"Cannot parse time string: '{t}'. Expected HHMM format.")
    return time(int(t[:2]), int(t[2:]))


def _parse_busy_slot(slot_str: str) -> Tuple[time, time]:
    """
    Parse a busy-slot string "0800-0930" into (time(8,0), time(9,30)).
    Raises ValueError if the format is wrong or end <= start.
    """
    parts = slot_str.strip().split("-")
    if len(parts) != 2:
        raise ValueError(f"Cannot parse busy slot: '{slot_str}'. Expected 'HHMM-HHMM'.")
    start = _parse_hhmm(parts[0])
    end = _parse_hhmm(parts[1])
    if end <= start:
        raise ValueError(
            f"Busy slot end ({end}) must be after start ({start}) in '{slot_str}'."
        )
    return start, end


def _to_minutes(t: time) -> int:
    """Convert a time to total minutes since midnight."""
    return t.hour * 60 + t.minute


def _to_time(minutes: int) -> time:
    """Convert total minutes since midnight to a time object."""
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

    Algorithm:
      1. Expand each busy slot by buffer_minutes on each side
      2. Clamp expanded intervals to [work_start, work_end]
      3. Merge overlapping blocked intervals
      4. Return the gaps (free windows)

    Args:
        busy_slots:      List of (start, end) tuples for the day's busy periods
        work_start:      Earliest allowed scheduling time
        work_end:        Latest allowed scheduling time
        buffer_minutes:  Required gap before and after each busy event

    Returns:
        List of (start, end) free-window tuples, each guaranteed to be
        at least MIN_VIABLE_CHUNK_MINUTES wide.
    """
    ws = _to_minutes(work_start)
    we = _to_minutes(work_end)
    buf = buffer_minutes

    # Expand each busy slot by the buffer and clamp to work hours
    blocked: List[List[int]] = []
    for start, end in busy_slots:
        s = max(ws, _to_minutes(start) - buf)
        e = min(we, _to_minutes(end) + buf)
        if s < e:
            blocked.append([s, e])

    # Sort and merge overlapping blocked intervals
    blocked.sort(key=lambda x: x[0])
    merged: List[List[int]] = []
    for s, e in blocked:
        if merged and s <= merged[-1][1]:
            merged[-1][1] = max(merged[-1][1], e)
        else:
            merged.append([s, e])

    # Collect free windows = gaps between blocked intervals within work hours
    free: List[Tuple[time, time]] = []
    cursor = ws
    for s, e in merged:
        if cursor < s and (s - cursor) >= MIN_VIABLE_CHUNK_MINUTES:
            free.append((_to_time(cursor), _to_time(s)))
        cursor = max(cursor, e)
    if cursor < we and (we - cursor) >= MIN_VIABLE_CHUNK_MINUTES:
        free.append((_to_time(cursor), _to_time(we)))

    return free


def _placements_in_window(
    day: str, window_start: time, window_end: time, chunk_minutes: int
) -> List[Block]:
    """
    Return all non-overlapping block placements of `chunk_minutes` duration
    that fit within [window_start, window_end].

    Uses a step equal to chunk_minutes (non-overlapping tiling).
    The last placement may be shorter if the remaining window is smaller
    than chunk_minutes but >= MIN_VIABLE_CHUNK_MINUTES.
    """
    ws = _to_minutes(window_start)
    we = _to_minutes(window_end)
    blocks: List[Block] = []
    cursor = ws
    while cursor < we:
        available = we - cursor
        if available < MIN_VIABLE_CHUNK_MINUTES:
            break
        duration = min(chunk_minutes, available)
        blocks.append(Block(
            day=day,
            start=_to_time(cursor),
            end=_to_time(cursor + duration),
            duration_minutes=duration,
        ))
        cursor += chunk_minutes  # non-overlapping: advance by full chunk_minutes
    return blocks


# ---------------------------------------------------------------------------
# SlotGenerator
# ---------------------------------------------------------------------------

class SlotGenerator:
    """
    Generates feasible scheduling candidates from a busy-calendar JSON.

    Usage:
        gen = SlotGenerator(preferences)
        candidates = gen.generate_candidates(calendar_json, task, K=5)
    """

    def __init__(self, preferences: UserPreferences) -> None:
        self.prefs = preferences

    # ------------------------------------------------------------------
    # Public: free windows
    # ------------------------------------------------------------------

    def get_all_free_windows(
        self, calendar_json: Dict[str, List[str]]
    ) -> Dict[str, List[Tuple[time, time]]]:
        """
        Parse the busy calendar JSON and return free windows per day.

        Days absent from calendar_json are treated as fully free (within work hours).
        Days in avoid_days get empty free windows regardless of input.

        Returns:
            Dict mapping each day name in DAY_ORDER to its free windows.
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

    # ------------------------------------------------------------------
    # Public: block placements
    # ------------------------------------------------------------------

    def get_all_placements(
        self,
        free_windows: Dict[str, List[Tuple[time, time]]],
        chunk_minutes: int,
        deadline_day: str,
    ) -> Dict[str, List[Block]]:
        """
        For each day up to and including deadline_day, return all valid
        non-overlapping block placements of `chunk_minutes`.

        Respects the user's daily workload cap (max_daily_work_minutes).

        Args:
            free_windows:  Output of get_all_free_windows()
            chunk_minutes: Desired block duration
            deadline_day:  No blocks may be placed after this day

        Returns:
            Dict mapping day names to their available Block placements.
        """
        deadline_idx = (
            DAY_ORDER.index(deadline_day) if deadline_day in DAY_ORDER else len(DAY_ORDER) - 1
        )
        cap = self.prefs.max_daily_work_minutes

        result: Dict[str, List[Block]] = {}
        for day, windows in free_windows.items():
            if day not in DAY_ORDER:
                continue
            if DAY_ORDER.index(day) > deadline_idx:
                continue  # past deadline

            day_blocks: List[Block] = []
            day_minutes_used = 0
            for w_start, w_end in windows:
                for block in _placements_in_window(day, w_start, w_end, chunk_minutes):
                    if day_minutes_used + block.duration_minutes > cap:
                        break
                    day_blocks.append(block)
                    day_minutes_used += block.duration_minutes

            result[day] = day_blocks
        return result

    # ------------------------------------------------------------------
    # Public: main entry point
    # ------------------------------------------------------------------

    def generate_candidates(
        self,
        calendar_json: Dict[str, List[str]],
        task: TaskRequest,
        K: int = 5,
    ) -> List[CandidateSchedule]:
        """
        Generate up to K diverse, feasible CandidateSchedules for a task.

        Each candidate covers task.total_duration_minutes using non-overlapping
        blocks that fit within the user's free windows, respect all constraints,
        and fall at or before task.deadline_day.

        Strategy matrix (tried in order, duplicates discarded):
          1. preferred_chunk / chronological / morning-first   → "spread_morning"
          2. preferred_chunk / chronological / evening-first   → "spread_evening"
          3. preferred_chunk / reverse (deadline-adjacent)     → "deadline_adjacent"
          4. larger chunks  / chronological / morning-first    → "large_chunks"
          5. smaller chunks / chronological / morning-first    → "small_chunks"
          6. preferred_chunk / first 2 days only               → "concentrated"

        Returns an empty list if no feasible schedule exists (not enough free time).
        """
        chunk_pref = task.preferred_chunk_minutes or self.prefs.preferred_chunk_minutes
        chunk_large = min(task.max_chunk_minutes, chunk_pref + 30)
        chunk_small = max(task.min_chunk_minutes, chunk_pref - 15)

        free_windows = self.get_all_free_windows(calendar_json)

        # Valid days: not avoided, not past deadline, in calendar order
        deadline_idx = (
            DAY_ORDER.index(task.deadline_day)
            if task.deadline_day in DAY_ORDER
            else len(DAY_ORDER) - 1
        )
        valid_days = [
            d for d in DAY_ORDER
            if d not in self.prefs.avoid_days
            and DAY_ORDER.index(d) <= deadline_idx
        ]

        # Strategies: (chunk_size, day_order, prefer_early_in_day, max_per_day, label)
        # max_per_day=None means "fill up the day cap"; max_per_day=1 forces spread
        strategies: List[Tuple] = [
            (chunk_pref,  valid_days,              True,  None, "spread_morning"),
            (chunk_pref,  valid_days,              False, None, "spread_evening"),
            (chunk_pref,  list(reversed(valid_days)), True, None, "deadline_adjacent"),
            (chunk_large, valid_days,              True,  None, "large_chunks"),
            (chunk_small, valid_days,              True,  None, "small_chunks"),
            (chunk_pref,  valid_days[:2] if len(valid_days) >= 2 else valid_days,
                          True, None, "concentrated"),
        ]

        candidates: List[CandidateSchedule] = []
        seen_fingerprints: set = set()

        for chunk_size, day_order, prefer_early, max_per_day, label in strategies:
            if len(candidates) >= K:
                break

            placements = self.get_all_placements(free_windows, chunk_size, task.deadline_day)
            blocks = self._fill_greedy(
                placements,
                task.total_duration_minutes,
                day_order,
                prefer_early=prefer_early,
                max_blocks_per_day=max_per_day,
            )

            if blocks is None:
                continue  # not enough free time with this strategy

            fp = frozenset((b.day, b.start, b.end) for b in blocks)
            if fp in seen_fingerprints:
                continue
            seen_fingerprints.add(fp)

            candidates.append(CandidateSchedule(
                blocks=blocks,
                total_minutes=sum(b.duration_minutes for b in blocks),
                strategy=label,
            ))

        return candidates

    # ------------------------------------------------------------------
    # Private: greedy fill
    # ------------------------------------------------------------------

    def _fill_greedy(
        self,
        all_placements: Dict[str, List[Block]],
        total_minutes: int,
        day_order: List[str],
        prefer_early: bool = True,
        max_blocks_per_day: Optional[int] = None,
    ) -> Optional[List[Block]]:
        """
        Greedily select blocks across days until total_minutes is covered.

        Iterates `day_order` in sequence. Within each day, sorts blocks by
        start time (ascending if prefer_early, descending otherwise) and
        takes up to max_blocks_per_day blocks (or as many as needed).

        Returns:
            List of selected Blocks if total_minutes can be covered, else None.
        """
        schedule: List[Block] = []
        remaining = total_minutes

        for day in day_order:
            if remaining <= 0:
                break

            blocks = all_placements.get(day, [])
            if not blocks:
                continue

            blocks = sorted(blocks, key=lambda b: b.start, reverse=not prefer_early)

            day_count = 0
            for block in blocks:
                if remaining <= 0:
                    break
                if max_blocks_per_day is not None and day_count >= max_blocks_per_day:
                    break

                schedule.append(block)
                remaining -= block.duration_minutes
                day_count += 1

        return schedule if remaining <= 0 else None


# ---------------------------------------------------------------------------
# Quick smoke test (run directly: python slot_generator.py)
# ---------------------------------------------------------------------------

if __name__ == "__main__":
    from calcoach.user_profile import UserPreferences

    prefs = UserPreferences(
        work_start="09:00",
        work_end="18:00",
        buffer_minutes=10,
        preferred_chunk_minutes=45,
        max_daily_work_minutes=240,
        avoid_days=["Saturday", "Sunday"],
    )

    calendar = {
        "Monday":    ["0800-0930", "1200-1300"],
        "Tuesday":   ["0900-1030", "1500-1600"],
        "Wednesday": ["1100-1200"],
        "Thursday":  ["0800-0900", "1300-1400"],
        "Friday":    [],
    }

    task = TaskRequest(
        task_name="61A HW6",
        total_duration_minutes=150,   # 2h30m
        task_type="problem_set",
        deadline_day="Thursday",
        preferred_chunk_minutes=45,
    )

    gen = SlotGenerator(prefs)

    print("=== Free windows ===")
    for day, windows in gen.get_all_free_windows(calendar).items():
        if windows:
            print(f"  {day}: {[(w[0].strftime('%H%M'), w[1].strftime('%H%M')) for w in windows]}")

    print("\n=== Candidates ===")
    candidates = gen.generate_candidates(calendar, task, K=6)
    if not candidates:
        print("  No feasible schedule found.")
    for i, cand in enumerate(candidates):
        print(f"\n  [{i+1}] strategy='{cand.strategy}' total={cand.total_minutes}min "
              f"span={cand.span_days}days avg_start={cand.avg_start_hour:.1f}h")
        for block in cand.blocks:
            print(f"       {block}")
