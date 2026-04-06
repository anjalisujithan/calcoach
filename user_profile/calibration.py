from __future__ import annotations
from dataclasses import dataclass, field
from typing import Dict


@dataclass
class CalibrationParams:
    """
    Per-user, per-task-type duration correction factors.

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

    def update(self, task_type: str, estimated_minutes: float, actual_minutes: float) -> None:
        """Online update using exponential moving average (alpha=0.3)."""
        if estimated_minutes <= 0:
            return
        ratio = actual_minutes / estimated_minutes
        alpha = 0.3
        current = self.correction_by_type.get(task_type, 1.0)
        self.correction_by_type[task_type] = (1 - alpha) * current + alpha * ratio
        self.n_samples_by_type[task_type] = self.n_samples_by_type.get(task_type, 0) + 1

    def to_dict(self) -> dict:
        return {
            "correction_by_type": self.correction_by_type,
            "n_samples_by_type": self.n_samples_by_type,
        }

    @classmethod
    def from_dict(cls, d: dict) -> CalibrationParams:
        return cls(**d)
