from __future__ import annotations
from dataclasses import dataclass, field
from datetime import datetime
from typing import Optional

from user_profile.bandit_state import BanditState
from user_profile.behavioral_stats import BehavioralStats
from user_profile.calibration import CalibrationParams
from user_profile.personality import PersonalityWeights
from user_profile.preferences import UserPreferences


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

    Database integration:
      - Fetch:   UserProfile.from_dict(row_from_db)
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
            survey_answers: onboarding form answers; initializes personality weights
            preferences:    custom UserPreferences; defaults to system defaults
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
