#!/usr/bin/env python3
"""
Run a Claude scheduling pipeline on sample schedules.

Usage:
  export ANTHROPIC_API_KEY="..."
  python run_claude_schedule_pipeline.py --intended-task "Write my CS61C lab report"
"""

from __future__ import annotations

import argparse
import json
import os
from dataclasses import dataclass
from datetime import datetime, timezone
from pathlib import Path
from typing import Any, Dict, List, Optional
from urllib import error, request


API_URL = "https://api.anthropic.com/v1/messages"
DEFAULT_MODEL = "claude-opus-4-6"
MAX_TOKENS = 1800
TEMPERATURE = 0.2

SYSTEM_PROMPT = """
You are an expert in scheduling and optimizing weekly plans.
You are given a user's schedule and an intended task to complete, with optional
time needed and other context.

If exact time needed is missing or unclear, estimate a reasonable total duration
and explain the assumption briefly.

Find the best possible schedule slots to complete the task across the week.
Use the user's constraints (busy blocks, work hours, avoid days/preferences,
buffer expectations, and request window when present).

Return ONLY valid JSON matching this structure:
{
  "task_summary": {
    "task_name": "string",
    "assumed_total_minutes": 0,
    "assumption_notes": "string"
  },
  "suggested_slots": [
    {
      "day": "Monday",
      "start": "YYYY-MM-DDTHH:MM:SS±HH:MM",
      "end": "YYYY-MM-DDTHH:MM:SS±HH:MM",
      "duration_minutes": 0,
      "confidence": 0.0,
      "reason": "string"
    }
  ],
  "weekly_plan_notes": "string"
}

Rules:
- Output JSON only (no markdown, no prose outside JSON).
- Ensure times do not overlap known busy intervals.
- Keep slot durations realistic and positive.
- Keep confidence between 0.0 and 1.0.
""".strip()


@dataclass
class RunPaths:
    run_dir: Path
    raw_jsonl: Path
    parsed_json: Path
    errors_jsonl: Path


def now_utc_iso() -> str:
    return datetime.now(timezone.utc).isoformat()


def ensure_run_paths(base_dir: Path) -> RunPaths:
    timestamp = datetime.now().strftime("%Y%m%d_%H%M%S")
    run_dir = base_dir / f"claude_schedule_run_{timestamp}"
    run_dir.mkdir(parents=True, exist_ok=True)
    return RunPaths(
        run_dir=run_dir,
        raw_jsonl=run_dir / "raw_responses.jsonl",
        parsed_json=run_dir / "parsed_results.json",
        errors_jsonl=run_dir / "errors.jsonl",
    )


def call_claude(
    api_key: str,
    schedule_payload: Dict[str, Any],
    model: str,
    intended_task: str,
) -> Dict[str, Any]:
    user_prompt = {
        "input_schedule": schedule_payload,
        "intended_task": intended_task,
        "instruction": (
            "Generate an optimized set of weekly slots for the intended task. "
            "If needed, infer total time and split into practical sessions."
        ),
    }

    body = {
        "model": model,
        "max_tokens": MAX_TOKENS,
        "temperature": TEMPERATURE,
        "system": SYSTEM_PROMPT,
        "messages": [
            {
                "role": "user",
                "content": json.dumps(user_prompt, ensure_ascii=True),
            }
        ],
    }
    data = json.dumps(body).encode("utf-8")
    req = request.Request(
        API_URL,
        data=data,
        method="POST",
        headers={
            "content-type": "application/json",
            "x-api-key": api_key,
            "anthropic-version": "2023-06-01",
        },
    )

    try:
        with request.urlopen(req, timeout=90) as resp:
            return json.loads(resp.read().decode("utf-8"))
    except error.HTTPError as e:
        detail = e.read().decode("utf-8", errors="replace")
        raise RuntimeError(f"Anthropic HTTP {e.code}: {detail}") from e
    except error.URLError as e:
        raise RuntimeError(f"Network/API error: {e}") from e


def extract_text_content(response_json: Dict[str, Any]) -> str:
    content = response_json.get("content", [])
    text_chunks: List[str] = []
    for chunk in content:
        if isinstance(chunk, dict) and chunk.get("type") == "text":
            text_chunks.append(chunk.get("text", ""))
    return "\n".join(text_chunks).strip()


def parse_model_json(text: str) -> Dict[str, Any]:
    # Prefer direct JSON parse. If model wraps it, recover from the first object.
    try:
        return json.loads(text)
    except json.JSONDecodeError:
        first = text.find("{")
        last = text.rfind("}")
        if first == -1 or last == -1 or last <= first:
            raise
        return json.loads(text[first : last + 1])


def validate_result_shape(result: Dict[str, Any]) -> None:
    required_top = ["task_summary", "suggested_slots", "weekly_plan_notes"]
    for key in required_top:
        if key not in result:
            raise ValueError(f"Missing required key: {key}")
    if not isinstance(result["suggested_slots"], list):
        raise ValueError("suggested_slots must be a list")


def run_pipeline(
    input_path: Path,
    output_base_dir: Path,
    api_key: str,
    model: str,
    intended_task: str,
    limit: Optional[int] = None,
) -> RunPaths:
    schedules = json.loads(input_path.read_text(encoding="utf-8"))
    if not isinstance(schedules, list):
        raise ValueError("Expected input JSON to be a list of schedules.")

    if limit is not None:
        schedules = schedules[:limit]

    paths = ensure_run_paths(output_base_dir)
    parsed_results: List[Dict[str, Any]] = []

    for idx, schedule in enumerate(schedules, start=1):
        student_id = (
            schedule.get("studentProfile", {}).get("id", f"student_{idx}")
            if isinstance(schedule, dict)
            else f"student_{idx}"
        )
        row_base = {
            "timestamp_utc": now_utc_iso(),
            "index": idx,
            "student_id": student_id,
        }
        try:
            api_response = call_claude(
                api_key=api_key,
                schedule_payload=schedule,
                model=model,
                intended_task=intended_task,
            )
            text = extract_text_content(api_response)
            parsed = parse_model_json(text)
            validate_result_shape(parsed)

            parsed_row = {**row_base, "result": parsed}
            parsed_results.append(parsed_row)

            raw_row = {
                **row_base,
                "raw_api_response": api_response,
                "extracted_text": text,
            }
            with paths.raw_jsonl.open("a", encoding="utf-8") as f:
                f.write(json.dumps(raw_row, ensure_ascii=True) + "\n")
            print(f"[OK] {idx} {student_id}")
        except Exception as exc:
            error_row = {**row_base, "error": str(exc)}
            with paths.errors_jsonl.open("a", encoding="utf-8") as f:
                f.write(json.dumps(error_row, ensure_ascii=True) + "\n")
            print(f"[ERROR] {idx} {student_id}: {exc}")

    paths.parsed_json.write_text(
        json.dumps(parsed_results, indent=2, ensure_ascii=True),
        encoding="utf-8",
    )
    return paths


def main() -> None:
    parser = argparse.ArgumentParser(
        description=(
            "Run Claude on sample schedules and generate structured JSON "
            "slot suggestions."
        )
    )
    parser.add_argument(
        "--intended-task",
        required=True,
        help=(
            "Task description to optimize for (for example: "
            "'Prepare biology midterm study plan')."
        ),
    )
    args = parser.parse_args()

    repo_root = Path(__file__).resolve().parent
    input_path = repo_root / "sample_schedules.json"
    output_base_dir = repo_root / "logs"
    output_base_dir.mkdir(parents=True, exist_ok=True)

    api_key = os.environ.get("ANTHROPIC_API_KEY")
    if not api_key:
        raise SystemExit(
            "Missing ANTHROPIC_API_KEY. "
            "Set it first: export ANTHROPIC_API_KEY='your-key'"
        )

    limit_str = os.environ.get("SCHEDULE_LIMIT")
    limit = int(limit_str) if limit_str else None
    model = os.environ.get("CLAUDE_MODEL", DEFAULT_MODEL)
    paths = run_pipeline(
        input_path=input_path,
        output_base_dir=output_base_dir,
        api_key=api_key,
        model=model,
        intended_task=args.intended_task,
        limit=limit,
    )
    print(f"Model: {model}")
    print(f"Intended task: {args.intended_task}")
    print(f"Run complete. Logs written to: {paths.run_dir}")
    print(f"- Parsed results: {paths.parsed_json}")
    print(f"- Raw responses: {paths.raw_jsonl}")
    print(f"- Errors: {paths.errors_jsonl}")


if __name__ == "__main__":
    main()
