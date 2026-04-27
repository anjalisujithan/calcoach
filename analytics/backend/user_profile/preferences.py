from __future__ import annotations
from dataclasses import dataclass, field
from typing import List


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
