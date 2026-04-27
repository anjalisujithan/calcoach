"""
feature_extractor.py

Converts a CandidateSchedule into a fixed-size numeric context vector
for use by the LinUCB contextual bandit.

CONTEXT_DIM = 17  (do not change without reinitializing all users' bandit state)

Feature breakdown:
  Index   Name                        Range    Description
  -----   ----                        -----    -----------
  [0]     avg_start_hour_norm         0–1      mean start hour of blocks / 24
  [1]     span_days_norm              0–1      number of distinct days used / 7
  [2]     avg_block_duration_norm     0–1      mean block length / max_chunk_minutes
  [3]     deadline_distance_norm      0–1      days of lead time before deadline / deadline_idx
  [4]     calendar_density            0–1      fraction of work hours on candidate days already busy
  [5]     task_type: reading          0 or 1   one-hot
  [6]     task_type: problem_set      0 or 1
  [7]     task_type: writing          0 or 1
  [8]     task_type: other            0 or 1
  [9]     personality: rusher         0–1      soft weight from UserProfile
  [10]    personality: planner        0–1
  [11]    personality: context_switcher 0–1
  [12]    personality: night_owl      0–1
  [13]    personality: inconsistent   0–1
  [14]    time_of_day: morning        0 or 1   one-hot  (avg start < 12:00)
  [15]    time_of_day: afternoon      0 or 1             (12:00 – 17:00)
  [16]    time_of_day: evening        0 or 1             (>= 17:00)
"""

from __future__ import annotations

from typing import Dict, List

import numpy as np

from models import CandidateSchedule, DAY_ORDER, TaskRequest
from user_profile import UserProfile
from RL_exploration.slot_generator import _parse_busy_slot, _parse_hhmm, _to_minutes


# ---------------------------------------------------------------------------
# Constants
# ---------------------------------------------------------------------------

CONTEXT_DIM: int = 17

TASK_TYPES: List[str] = ["reading", "problem_set", "writing", "other"]

# Human-readable names — useful for inspecting what the bandit has learned
FEATURE_NAMES: List[str] = [
    "avg_start_hour_norm",
    "span_days_norm",
    "avg_block_duration_norm",
    "deadline_distance_norm",
    "calendar_density",
    "task_reading",
    "task_problem_set",
    "task_writing",
    "task_other",
    "personality_rusher",
    "personality_planner",
    "personality_context_switcher",
    "personality_night_owl",
    "personality_inconsistent",
    "time_morning",
    "time_afternoon",
    "time_evening",
]


# ---------------------------------------------------------------------------
# Private helpers
# ---------------------------------------------------------------------------

def _calendar_density(
    candidate: CandidateSchedule,
    calendar_json: Dict[str, List[str]],
    work_start: str,
    work_end: str,
) -> float:
    """
    Fraction of total work minutes (on candidate's days) that are already busy.
    Gives the bandit a signal for how congested the surrounding schedule is.
    A dense calendar → candidate is squeezed in; sparse → plenty of breathing room.
    """
    candidate_days = {b.day for b in candidate.blocks}
    ws = _to_minutes(_parse_hhmm(work_start))
    we = _to_minutes(_parse_hhmm(work_end))
    work_minutes_per_day = we - ws

    total_work = len(candidate_days) * work_minutes_per_day
    if total_work == 0:
        return 0.0

    total_busy = 0
    for day in candidate_days:
        for slot_str in calendar_json.get(day, []):
            try:
                start, end = _parse_busy_slot(slot_str)
                # Clamp to work hours before summing
                s = max(ws, _to_minutes(start))
                e = min(we, _to_minutes(end))
                if e > s:
                    total_busy += (e - s)
            except ValueError:
                continue

    return min(1.0, total_busy / total_work)


def _one_hot(value: str, categories: List[str]) -> List[float]:
    return [1.0 if value == c else 0.0 for c in categories]


def _time_of_day_bucket(avg_start_hour: float) -> List[float]:
    """One-hot encode average start hour into morning / afternoon / evening."""
    if avg_start_hour < 12.0:
        return [1.0, 0.0, 0.0]   # morning
    elif avg_start_hour < 17.0:
        return [0.0, 1.0, 0.0]   # afternoon
    else:
        return [0.0, 0.0, 1.0]   # evening


# ---------------------------------------------------------------------------
# Main function
# ---------------------------------------------------------------------------

def extract(
    candidate: CandidateSchedule,
    user_profile: UserProfile,
    task: TaskRequest,
    calendar_json: Dict[str, List[str]],
) -> np.ndarray:
    """
    Build the context vector for a CandidateSchedule.

    Args:
        candidate:     A CandidateSchedule that has already passed ScheduleValidator
        user_profile:  The current user's profile (preferences + personality weights)
        task:          The TaskRequest being scheduled
        calendar_json: Raw busy-calendar JSON (same format as ScheduleValidator input)

    Returns:
        numpy array of shape (CONTEXT_DIM,) = (17,), dtype float64
    """
    avg_start = candidate.avg_start_hour

    # --- Scalar features (each normalized to 0–1) ---

    avg_start_norm = avg_start / 24.0

    span_norm = candidate.span_days / 7.0

    # Normalize block duration relative to the task's max allowed chunk
    avg_dur_norm = min(1.0, candidate.avg_block_duration / task.max_chunk_minutes)

    # Deadline distance: how much lead time does this candidate give?
    # 0.0 = first block is on the deadline day (last minute)
    # 1.0 = first block is as far from the deadline as possible
    deadline_idx = DAY_ORDER.index(task.deadline_day) if task.deadline_day in DAY_ORDER else 6
    earliest_idx = candidate.earliest_day_index
    if deadline_idx > 0:
        deadline_dist = max(0.0, min(1.0, (deadline_idx - earliest_idx) / deadline_idx))
    else:
        deadline_dist = 0.0

    density = _calendar_density(
        candidate, calendar_json,
        user_profile.preferences.work_start,
        user_profile.preferences.work_end,
    )

    # --- Categorical features (one-hot) ---

    task_type = task.task_type if task.task_type in TASK_TYPES else "other"
    task_oh = _one_hot(task_type, TASK_TYPES)

    # --- User personality weights (already sum to 1.0) ---

    personality = user_profile.personality_weights.to_vector()

    # --- Time of day (one-hot based on average start hour) ---

    tod_oh = _time_of_day_bucket(avg_start)

    # --- Assemble ---

    vec = [
        avg_start_norm,
        span_norm,
        avg_dur_norm,
        deadline_dist,
        density,
        *task_oh,        # 4 values → indices 5–8
        *personality,    # 5 values → indices 9–13
        *tod_oh,         # 3 values → indices 14–16
    ]

    assert len(vec) == CONTEXT_DIM, (
        f"Feature vector length mismatch: expected {CONTEXT_DIM}, got {len(vec)}. "
        f"Update CONTEXT_DIM and FEATURE_NAMES if you add/remove features."
    )

    return np.array(vec, dtype=np.float64)
