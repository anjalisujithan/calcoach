"""
user_profile.py

Data classes for a CalCoach user profile.

These are designed to be serialized to / deserialized from a PostgreSQL database.
The to_dict() / from_dict() methods provide JSON-compatible representations
that map cleanly to database columns or JSONB fields.

Suggested PostgreSQL schema:
  users               — user_id (UUID PK), name, created_at, updated_at
  user_preferences    — user_id (FK), work_start, work_end, buffer_minutes, ...
  personality_weights — user_id (FK), rusher, planner, context_switcher, night_owl, inconsistent
  calibration_params  — user_id (FK), task_type, correction_factor, n_samples
  bandit_state        — user_id (FK), A (JSONB), b (JSONB), n_updates, last_updated
  behavioral_stats    — user_id (FK), avg_time_delta, lead_time_days, ...

All sub-objects expose to_dict() / from_dict() for easy ORM mapping or
direct psycopg2 / asyncpg serialization.
"""

from __future__ import annotations

from dataclasses import dataclass, field
from datetime import datetime
from typing import Dict, List, Optional


# ---------------------------------------------------------------------------
# UserPreferences
# ---------------------------------------------------------------------------

@dataclass
class UserPreferences:
    """
    Scheduling constraints collected during onboarding.

    DB mapping: user_preferences table, one row per user.
    """
    work_start: str = "09:00"             # HH:MM — earliest allowed block start
    work_end: str = "18:00"               # HH:MM — latest allowed block end
    sleep_start: str = "23:00"            # HH:MM — never schedule after this
    wake_time: str = "08:00"              # HH:MM — never schedule before this
    buffer_minutes: int = 10              # gap required before/after existing events
    preferred_chunk_minutes: int = 45     # default work-block length
    max_daily_work_minutes: int = 240     # daily workload cap (4 hours)
    avoid_days: List[str] = field(
        default_factory=lambda: ["Saturday", "Sunday"]
    )

    def to_dict(self) -> dict:
        return {
            "work_start": self.work_start,
            "work_end": self.work_end,
            "sleep_start": self.sleep_start,
            "wake_time": self.wake_time,
            "buffer_minutes": self.buffer_minutes,
            "preferred_chunk_minutes": self.preferred_chunk_minutes,
            "max_daily_work_minutes": self.max_daily_work_minutes,
            "avoid_days": self.avoid_days,
        }

    @classmethod
    def from_dict(cls, d: dict) -> UserPreferences:
        return cls(**d)


# ---------------------------------------------------------------------------
# PersonalityWeights
# ---------------------------------------------------------------------------

@dataclass
class PersonalityWeights:
    """
    Soft 5-dimensional personality vector. Values should sum to 1.0.

    Initialized from onboarding survey answers (cold start).
    Updated weekly using observed behavioral stats.

    Types:
      Type 1 — Rusher:           bursts close to deadlines, underestimates time
      Type 2 — Planner:          schedules far ahead, overestimates, craves predictability
      Type 3 — Context-Switcher: prefers variety within a day over long deep-focus blocks
      Type 4 — Night Owl:        strong time-of-day preference (morning or late-night cluster)
      Type 5 — Inconsistent:     no strong pattern yet; needs more exploration data

    DB mapping: personality_weights table, one row per user.
    """
    rusher: float = 0.20
    planner: float = 0.20
    context_switcher: float = 0.20
    night_owl: float = 0.20
    inconsistent: float = 0.20

    def to_vector(self) -> List[float]:
        """Ordered list for direct use as bandit context features."""
        return [
            self.rusher,
            self.planner,
            self.context_switcher,
            self.night_owl,
            self.inconsistent,
        ]

    def normalize(self) -> PersonalityWeights:
        """Return a new instance where all weights sum to 1.0."""
        total = (
            self.rusher + self.planner + self.context_switcher
            + self.night_owl + self.inconsistent
        )
        if total == 0:
            return PersonalityWeights()
        return PersonalityWeights(
            rusher=self.rusher / total,
            planner=self.planner / total,
            context_switcher=self.context_switcher / total,
            night_owl=self.night_owl / total,
            inconsistent=self.inconsistent / total,
        )

    def dominant_type(self) -> str:
        """Name of the highest-weight personality type."""
        types = {
            "rusher": self.rusher,
            "planner": self.planner,
            "context_switcher": self.context_switcher,
            "night_owl": self.night_owl,
            "inconsistent": self.inconsistent,
        }
        return max(types, key=lambda k: types[k])

    def to_dict(self) -> dict:
        return {
            "rusher": self.rusher,
            "planner": self.planner,
            "context_switcher": self.context_switcher,
            "night_owl": self.night_owl,
            "inconsistent": self.inconsistent,
        }

    @classmethod
    def from_dict(cls, d: dict) -> PersonalityWeights:
        return cls(**d)

    @classmethod
    def from_survey(cls, answers: dict) -> PersonalityWeights:
        """
        Cold-start initialization from onboarding survey answers.

        Expected keys in `answers` (all optional, unknown values are ignored):
          planning_horizon : "day_of" | "day_before" | "days_ahead" | "week_ahead"
          work_style       : "burst" | "steady" | "variety" | "deep_focus"
          time_preference  : "morning" | "afternoon" | "evening" | "no_preference"
          chunk_preference : "short" | "medium" | "long"

        Returns a normalized soft weight vector.
        """
        # Start with a slight Inconsistent bias (we don't know much yet)
        w = PersonalityWeights(
            rusher=0.10,
            planner=0.10,
            context_switcher=0.10,
            night_owl=0.10,
            inconsistent=0.60,
        )

        horizon = answers.get("planning_horizon", "")
        if horizon in ("day_of", "day_before"):
            w.rusher += 0.30
            w.inconsistent -= 0.15
        elif horizon in ("days_ahead", "week_ahead"):
            w.planner += 0.30
            w.inconsistent -= 0.15

        style = answers.get("work_style", "")
        if style == "burst":
            w.rusher += 0.20
        elif style == "steady":
            w.planner += 0.20
        elif style == "variety":
            w.context_switcher += 0.30
            w.inconsistent -= 0.10
        elif style == "deep_focus":
            w.planner += 0.15

        time_pref = answers.get("time_preference", "")
        if time_pref in ("morning", "evening"):
            w.night_owl += 0.25
            w.inconsistent -= 0.10
        elif time_pref == "afternoon":
            w.context_switcher += 0.10

        chunk = answers.get("chunk_preference", "")
        if chunk == "short":
            w.context_switcher += 0.10
        elif chunk == "long":
            w.planner += 0.10

        # Ensure no negative weights before normalizing
        w.rusher = max(0.0, w.rusher)
        w.planner = max(0.0, w.planner)
        w.context_switcher = max(0.0, w.context_switcher)
        w.night_owl = max(0.0, w.night_owl)
        w.inconsistent = max(0.05, w.inconsistent)  # keep a floor — always some uncertainty

        return w.normalize()


# ---------------------------------------------------------------------------
# CalibrationParams
# ---------------------------------------------------------------------------

@dataclass
class CalibrationParams:
    """
    Per-user, per-task-type duration correction factors.

    Interpretation:
      predicted_duration = global_estimate * correction_factor[task_type]
      factor > 1.0 → user consistently underestimates (Rusher tendency)
      factor < 1.0 → user consistently overestimates (Planner tendency)

    Updated via exponential moving average after each completed session.

    DB mapping: calibration_params table, one row per (user_id, task_type).
    """
    correction_by_type: Dict[str, float] = field(default_factory=dict)
    n_samples_by_type: Dict[str, int] = field(default_factory=dict)

    def get_correction(self, task_type: str) -> float:
        """Returns correction factor for task_type; defaults to 1.0 (no correction)."""
        return self.correction_by_type.get(task_type, 1.0)

    def update(
        self, task_type: str, estimated_minutes: float, actual_minutes: float
    ) -> None:
        """
        Online update using exponential moving average (alpha=0.3).
        Call this after a session is marked complete with an actual duration.
        """
        if estimated_minutes <= 0:
            return
        ratio = actual_minutes / estimated_minutes
        alpha = 0.3
        current = self.correction_by_type.get(task_type, 1.0)
        self.correction_by_type[task_type] = (1 - alpha) * current + alpha * ratio
        self.n_samples_by_type[task_type] = (
            self.n_samples_by_type.get(task_type, 0) + 1
        )

    def to_dict(self) -> dict:
        return {
            "correction_by_type": self.correction_by_type,
            "n_samples_by_type": self.n_samples_by_type,
        }

    @classmethod
    def from_dict(cls, d: dict) -> CalibrationParams:
        return cls(**d)


# ---------------------------------------------------------------------------
# BanditState
# ---------------------------------------------------------------------------

@dataclass
class BanditState:
    """
    Per-user LinUCB state: A matrix (d×d) and b vector (d,).
    d = context vector dimension, fixed by FeatureExtractor.

    A and b are stored as nested Python lists for JSON / JSONB compatibility.
    They are lazily initialized in contextual_bandit.py once d is known.

    DB mapping: bandit_state table, one row per user (A and b as JSONB columns).
    """
    A: Optional[List[List[float]]] = None   # shape (d, d)
    b: Optional[List[float]] = None          # shape (d,)
    n_updates: int = 0
    last_updated: Optional[str] = None       # ISO 8601 datetime string

    @property
    def is_initialized(self) -> bool:
        return self.A is not None and self.b is not None

    def to_dict(self) -> dict:
        return {
            "A": self.A,
            "b": self.b,
            "n_updates": self.n_updates,
            "last_updated": self.last_updated,
        }

    @classmethod
    def from_dict(cls, d: dict) -> BanditState:
        return cls(**d)


# ---------------------------------------------------------------------------
# BehavioralStats
# ---------------------------------------------------------------------------

@dataclass
class BehavioralStats:
    """
    Aggregate statistics derived from a user's session history.

    Used to:
      1. Update personality weights (weekly batch job)
      2. Provide context features to the bandit
      3. Power the analytics dashboard

    DB mapping: behavioral_stats table, one row per user; updated periodically.
    """
    avg_time_delta: float = 0.0
    # mean(actual_minutes - estimated_minutes); positive → underestimator

    scheduling_lead_time_days: float = 0.0
    # avg days between "task added" and "first block scheduled"

    preferred_block_length_minutes: float = 45.0
    # inferred from accept/reject patterns on suggested block lengths

    peak_productivity_hour_start: Optional[int] = None
    # 0–23; start of the hour-range with highest avg session ratings

    peak_productivity_hour_end: Optional[int] = None
    # 0–23; end of that range

    rating_variance: float = 0.0
    # variance of session ratings; high value → Type 5 (Inconsistent)

    n_sessions: int = 0

    def to_dict(self) -> dict:
        return {
            "avg_time_delta": self.avg_time_delta,
            "scheduling_lead_time_days": self.scheduling_lead_time_days,
            "preferred_block_length_minutes": self.preferred_block_length_minutes,
            "peak_productivity_hour_start": self.peak_productivity_hour_start,
            "peak_productivity_hour_end": self.peak_productivity_hour_end,
            "rating_variance": self.rating_variance,
            "n_sessions": self.n_sessions,
        }

    @classmethod
    def from_dict(cls, d: dict) -> BehavioralStats:
        return cls(**d)


# ---------------------------------------------------------------------------
# UserProfile — top-level object
# ---------------------------------------------------------------------------

@dataclass
class UserProfile:
    """
    Complete user profile. Single source of truth for the RL module.

    Lifecycle:
      1. Created via UserProfile.new_user() at onboarding
      2. Preferences updated if user edits settings
      3. personality_weights updated weekly from behavioral_stats
      4. calibration updated after each completed session
      5. bandit_state updated after each accept/reject feedback event

    Database integration (to be wired up by the backend service):
      - Fetch:  UserProfile.from_dict(row_from_db)
      - Persist: db.upsert(profile.to_dict())
      - user_id should be a UUID string matching the auth system's user record
    """
    user_id: str
    name: str
    created_at: datetime
    updated_at: datetime

    preferences: UserPreferences = field(default_factory=UserPreferences)
    personality_weights: PersonalityWeights = field(default_factory=PersonalityWeights)
    calibration: CalibrationParams = field(default_factory=CalibrationParams)
    bandit_state: BanditState = field(default_factory=BanditState)
    stats: BehavioralStats = field(default_factory=BehavioralStats)

    def to_dict(self) -> dict:
        return {
            "user_id": self.user_id,
            "name": self.name,
            "created_at": self.created_at.isoformat(),
            "updated_at": self.updated_at.isoformat(),
            "preferences": self.preferences.to_dict(),
            "personality_weights": self.personality_weights.to_dict(),
            "calibration": self.calibration.to_dict(),
            "bandit_state": self.bandit_state.to_dict(),
            "stats": self.stats.to_dict(),
        }

    @classmethod
    def from_dict(cls, d: dict) -> UserProfile:
        return cls(
            user_id=d["user_id"],
            name=d["name"],
            created_at=datetime.fromisoformat(d["created_at"]),
            updated_at=datetime.fromisoformat(d["updated_at"]),
            preferences=UserPreferences.from_dict(d["preferences"]),
            personality_weights=PersonalityWeights.from_dict(d["personality_weights"]),
            calibration=CalibrationParams.from_dict(d["calibration"]),
            bandit_state=BanditState.from_dict(d["bandit_state"]),
            stats=BehavioralStats.from_dict(d["stats"]),
        )

    @classmethod
    def new_user(
        cls,
        user_id: str,
        name: str,
        survey_answers: Optional[dict] = None,
        preferences: Optional[UserPreferences] = None,
    ) -> UserProfile:
        """
        Factory for creating a brand-new user at onboarding.

        Args:
            user_id:        UUID from auth system
            name:           display name
            survey_answers: dict from onboarding form; if provided, initializes
                            personality weights from survey heuristics. If None,
                            starts with uniform weights (Inconsistent-dominant).
            preferences:    custom UserPreferences; defaults to system defaults.
        """
        now = datetime.utcnow()
        personality = (
            PersonalityWeights.from_survey(survey_answers)
            if survey_answers
            else PersonalityWeights()
        )
        return cls(
            user_id=user_id,
            name=name,
            created_at=now,
            updated_at=now,
            preferences=preferences or UserPreferences(),
            personality_weights=personality,
        )

    def touch(self) -> None:
        """Update the updated_at timestamp. Call before persisting any change."""
        self.updated_at = datetime.utcnow()
