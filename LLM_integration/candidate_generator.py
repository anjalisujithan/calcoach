"""
candidate_generator.py

Calls Claude to generate diverse CandidateSchedule proposals given:
  - A structured TaskRequest (produced by task_extractor.py)
  - The user's free windows per day (produced by ScheduleValidator.get_all_free_windows)

These candidates are then passed to ScheduleValidator.filter_candidates() to
remove any that violate hard constraints, and finally to LinUCBBandit.rank()
to produce a personalised ordering.

Usage:
    generator = CandidateGenerator()
    candidates = generator.generate(task, free_windows, n_candidates=5)
"""

from __future__ import annotations

import json
import os
from datetime import time
from typing import Dict, List, Optional, Tuple

import anthropic

from calcoach.models import Block, CandidateSchedule, DAY_ORDER, TaskRequest


# ---------------------------------------------------------------------------
# Helpers
# ---------------------------------------------------------------------------

def _format_free_windows(free_windows: Dict[str, List[Tuple[time, time]]]) -> str:
    """Serialise free windows into a compact string for the prompt."""
    lines = []
    for day in DAY_ORDER:
        windows = free_windows.get(day, [])
        if windows:
            window_strs = [
                f"{w[0].strftime('%H%M')}-{w[1].strftime('%H%M')}" for w in windows
            ]
            lines.append(f"  {day}: {', '.join(window_strs)}")
        else:
            lines.append(f"  {day}: (no free time)")
    return "\n".join(lines)


def _parse_time(t: str) -> time:
    """Parse 'HHMM' → time."""
    t = t.replace(":", "").strip()
    return time(int(t[:2]), int(t[2:]))


def _parse_candidate(raw: dict) -> Optional[CandidateSchedule]:
    """Parse a single candidate dict from Claude's JSON output."""
    try:
        blocks = []
        for b in raw["blocks"]:
            start = _parse_time(b["start"])
            end = _parse_time(b["end"])
            duration = (end.hour * 60 + end.minute) - (start.hour * 60 + start.minute)
            blocks.append(Block(
                day=b["day"],
                start=start,
                end=end,
                duration_minutes=duration,
            ))
        total = sum(b.duration_minutes for b in blocks)
        return CandidateSchedule(
            blocks=blocks,
            total_minutes=total,
            strategy=raw.get("strategy", "unspecified"),
        )
    except (KeyError, ValueError):
        return None


# ---------------------------------------------------------------------------
# Prompt
# ---------------------------------------------------------------------------

_SYSTEM_PROMPT = """\
You are CalCoach, an AI scheduling assistant.
Your job is to propose {n} diverse study schedule options for the given task.

Each option is a "candidate schedule" — a set of study blocks spread across the week.
You will be told which time windows are free. You MUST only place blocks inside those windows.

Strategies to consider (use different ones for variety):
  - "spread_across_week"   : small chunks spread over multiple days
  - "morning_focus"        : prefer early morning slots
  - "evening_focus"        : prefer evening slots
  - "deadline_adjacent"    : concentrate blocks close to the deadline
  - "long_sessions"        : fewer, longer blocks
  - "short_bursts"         : many short sessions

Respond ONLY with a JSON array of {n} candidate objects. No prose, no markdown fences.
Each candidate object must have:
  "strategy" : string label from the list above
  "blocks"   : array of block objects, each with:
    "day"   : weekday string (e.g. "Monday")
    "start" : time in "HHMM" format (e.g. "0900")
    "end"   : time in "HHMM" format (e.g. "1030")

Constraints you MUST obey:
  - Every block must fall fully inside one of the free windows listed below
  - No block may be scheduled after the deadline day
  - Each block must be between {min_chunk}–{max_chunk} minutes
  - Total time across all blocks must be at least {total_minutes} minutes
  - No two blocks in the same candidate may overlap on the same day
"""

_USER_TEMPLATE = """\
Task: {task_name}
Type: {task_type}
Total time needed: {total_minutes} minutes
Deadline: {deadline_day}
Preferred session length: {preferred} minutes

Free windows this week:
{windows}
"""


# ---------------------------------------------------------------------------
# CandidateGenerator
# ---------------------------------------------------------------------------

class CandidateGenerator:
    """
    Generates diverse CandidateSchedule proposals using Claude.
    """

    def __init__(self, model: str = "claude-opus-4-6") -> None:
        self._client = anthropic.Anthropic(api_key=os.environ["ANTHROPIC_API_KEY"])
        self._model = model

    def generate(
        self,
        task: TaskRequest,
        free_windows: Dict[str, List[Tuple[time, time]]],
        n_candidates: int = 5,
    ) -> List[CandidateSchedule]:
        """
        Ask Claude to propose n_candidates diverse schedules for the given task.

        Args:
            task: structured task info from TaskExtractor
            free_windows: per-day free windows from ScheduleValidator.get_all_free_windows()
            n_candidates: how many options to request (Claude may return fewer if constrained)

        Returns:
            List of CandidateSchedule objects (may be fewer than n_candidates if
            Claude's output was partially unparseable — caller should validate with
            ScheduleValidator before passing to the bandit).
        """
        system = _SYSTEM_PROMPT.format(
            n=n_candidates,
            min_chunk=task.min_chunk_minutes,
            max_chunk=task.max_chunk_minutes,
            total_minutes=task.total_duration_minutes,
        )

        preferred_str = (
            str(task.preferred_chunk_minutes)
            if task.preferred_chunk_minutes is not None
            else "flexible"
        )
        user_msg = _USER_TEMPLATE.format(
            task_name=task.task_name,
            task_type=task.task_type,
            total_minutes=task.total_duration_minutes,
            deadline_day=task.deadline_day,
            preferred=preferred_str,
            windows=_format_free_windows(free_windows),
        )

        response = self._client.messages.create(
            model=self._model,
            max_tokens=2048,
            system=system,
            messages=[{"role": "user", "content": user_msg}],
        )

        raw = response.content[0].text.strip()
        if raw.startswith("```"):
            raw = raw.split("```")[1]
            if raw.startswith("json"):
                raw = raw[4:]
        raw = raw.strip()

        try:
            data = json.loads(raw)
        except json.JSONDecodeError as e:
            raise ValueError(
                f"Claude returned invalid JSON for candidates: {e}\n---\n{raw}"
            ) from e

        if not isinstance(data, list):
            raise ValueError(f"Expected a JSON array, got: {type(data)}")

        candidates = []
        for item in data:
            c = _parse_candidate(item)
            if c is not None:
                candidates.append(c)

        return candidates
