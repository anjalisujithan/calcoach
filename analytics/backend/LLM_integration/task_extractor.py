"""
task_extractor.py

Calls Claude to convert a natural-language task description into a structured
TaskRequest object.

Usage:
    extractor = TaskExtractor()
    task = extractor.extract("I need to study for my CS midterm, probably 3 hours, due Thursday")
"""

from __future__ import annotations

import json
import os
from datetime import datetime

import anthropic

from models import TaskRequest, DAY_ORDER, MIN_VIABLE_CHUNK_MINUTES

_SYSTEM_PROMPT = """\
You are CalCoach, an AI scheduling assistant for students.
Your job is to extract structured scheduling information from a student's natural language request.

Today's weekday is {today_day}.

Respond ONLY with a single valid JSON object — no prose, no markdown fences.
The JSON must have exactly these keys:
  "task_name"               : string — short name for the task
  "total_duration_minutes"  : integer — total time needed in minutes
  "task_type"               : one of "reading" | "problem_set" | "writing" | "project" | "other"
  "deadline_day"            : one of {day_list} — the latest day a block can be scheduled
  "preferred_chunk_minutes" : integer or null — preferred single session length in minutes
  "min_chunk_minutes"       : integer — minimum useful session length (default 20)
  "max_chunk_minutes"       : integer — maximum single session before a break is needed (default 120)

Rules:
- If the student says "2 hours" → total_duration_minutes = 120
- If no deadline is mentioned, default to "Sunday"
- If no chunk preference, set preferred_chunk_minutes to null
- Be generous: if unsure of duration, round up
"""


class TaskExtractor:
    """
    Converts free-text task descriptions into structured TaskRequest objects
    using Claude.
    """

    def __init__(self, model: str = "claude-haiku-4-5-20251001") -> None:
        self._client = anthropic.Anthropic(api_key=os.environ["ANTHROPIC_API_KEY"])
        self._model = model

    def extract(self, user_text: str) -> TaskRequest:
        """
        Parse a natural-language task description and return a TaskRequest.

        Args:
            user_text: e.g. "Study for CS midterm, about 3 hours total, due Thursday"

        Returns:
            TaskRequest with structured fields populated by Claude.

        Raises:
            ValueError: if Claude returns invalid JSON or missing required fields.
        """
        today_day = datetime.today().strftime("%A")
        system = _SYSTEM_PROMPT.format(
            today_day=today_day,
            day_list=", ".join(f'"{d}"' for d in DAY_ORDER),
        )

        response = self._client.messages.create(
            model=self._model,
            max_tokens=512,
            system=system,
            messages=[{"role": "user", "content": user_text}],
        )

        raw = response.content[0].text.strip()
        # Strip markdown fences if Claude adds them despite instructions
        if raw.startswith("```"):
            raw = raw.split("```")[1]
            if raw.startswith("json"):
                raw = raw[4:]
        raw = raw.strip()

        try:
            data = json.loads(raw)
        except json.JSONDecodeError as e:
            raise ValueError(f"Claude returned invalid JSON: {e}\n---\n{raw}") from e

        # Validate deadline_day is a known day
        deadline = data.get("deadline_day", "Sunday")
        if deadline not in DAY_ORDER:
            deadline = "Sunday"

        return TaskRequest(
            task_name=data["task_name"],
            total_duration_minutes=int(data["total_duration_minutes"]),
            task_type=data.get("task_type", "other"),
            deadline_day=deadline,
            preferred_chunk_minutes=(
                int(data["preferred_chunk_minutes"])
                if data.get("preferred_chunk_minutes") is not None
                else None
            ),
            min_chunk_minutes=int(data.get("min_chunk_minutes", MIN_VIABLE_CHUNK_MINUTES)),
            max_chunk_minutes=int(data.get("max_chunk_minutes", 120)),
        )
