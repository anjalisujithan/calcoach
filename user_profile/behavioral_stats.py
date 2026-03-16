from __future__ import annotations
from dataclasses import dataclass
from typing import Optional


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
