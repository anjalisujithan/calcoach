from __future__ import annotations
from dataclasses import dataclass
from typing import List


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
        return [self.rusher, self.planner, self.context_switcher, self.night_owl, self.inconsistent]

    def normalize(self) -> PersonalityWeights:
        """Return a new instance where all weights sum to 1.0."""
        total = self.rusher + self.planner + self.context_switcher + self.night_owl + self.inconsistent
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

        Expected keys (all optional):
          planning_horizon : "day_of" | "day_before" | "days_ahead" | "week_ahead"
          work_style       : "burst" | "steady" | "variety" | "deep_focus"
          time_preference  : "morning" | "afternoon" | "evening" | "no_preference"
          chunk_preference : "short" | "medium" | "long"
        """
        w = PersonalityWeights(rusher=0.10, planner=0.10, context_switcher=0.10, night_owl=0.10, inconsistent=0.60)

        horizon = answers.get("planning_horizon", "")
        if horizon in ("day_of", "day_before"):
            w.rusher += 0.30; w.inconsistent -= 0.15
        elif horizon in ("days_ahead", "week_ahead"):
            w.planner += 0.30; w.inconsistent -= 0.15

        style = answers.get("work_style", "")
        if style == "burst":
            w.rusher += 0.20
        elif style == "steady":
            w.planner += 0.20
        elif style == "variety":
            w.context_switcher += 0.30; w.inconsistent -= 0.10
        elif style == "deep_focus":
            w.planner += 0.15

        time_pref = answers.get("time_preference", "")
        if time_pref in ("morning", "evening"):
            w.night_owl += 0.25; w.inconsistent -= 0.10
        elif time_pref == "afternoon":
            w.context_switcher += 0.10

        chunk = answers.get("chunk_preference", "")
        if chunk == "short":
            w.context_switcher += 0.10
        elif chunk == "long":
            w.planner += 0.10

        w.rusher = max(0.0, w.rusher)
        w.planner = max(0.0, w.planner)
        w.context_switcher = max(0.0, w.context_switcher)
        w.night_owl = max(0.0, w.night_owl)
        w.inconsistent = max(0.05, w.inconsistent)

        return w.normalize()
