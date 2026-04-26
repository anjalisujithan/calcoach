"""
models.py

Shared data classes for the CalCoach RL module.
Used by: LLM layer, slot_generator, feature_extractor, contextual_bandit.
"""

from __future__ import annotations

from dataclasses import dataclass
from datetime import time
from typing import List, Optional


DAY_ORDER: List[str] = [
    "Monday", "Tuesday", "Wednesday", "Thursday",
    "Friday", "Saturday", "Sunday",
]

MIN_VIABLE_CHUNK_MINUTES: int = 1


@dataclass
class Block:
    """A single scheduled time block on a specific day."""
    day: str
    start: time
    end: time
    duration_minutes: int

    def __repr__(self) -> str:
        return (
            f"Block({self.day} "
            f"{self.start.strftime('%H%M')}–{self.end.strftime('%H%M')}, "
            f"{self.duration_minutes}min)"
        )

    def __eq__(self, other: object) -> bool:
        if not isinstance(other, Block):
            return NotImplemented
        return (self.day, self.start, self.end) == (other.day, other.start, other.end)

    def __hash__(self) -> int:
        return hash((self.day, self.start, self.end))


@dataclass
class CandidateSchedule:
    """
    A complete schedule option proposed by the LLM: one or more Blocks
    that together are intended to cover a task.
    The 'strategy' label is set by the LLM and carried through for
    feature extraction and debugging.
    """
    blocks: List[Block]
    total_minutes: int
    strategy: str   # e.g. "spread_across_week", "morning_focus", "deadline_adjacent"

    @property
    def span_days(self) -> int:
        return len({b.day for b in self.blocks})

    @property
    def earliest_day_index(self) -> int:
        return min(DAY_ORDER.index(b.day) for b in self.blocks if b.day in DAY_ORDER)

    @property
    def latest_day_index(self) -> int:
        return max(DAY_ORDER.index(b.day) for b in self.blocks if b.day in DAY_ORDER)

    @property
    def avg_start_hour(self) -> float:
        return sum(b.start.hour + b.start.minute / 60 for b in self.blocks) / len(self.blocks)

    @property
    def avg_block_duration(self) -> float:
        return sum(b.duration_minutes for b in self.blocks) / len(self.blocks)

    def fingerprint(self) -> frozenset:
        """Order-independent identity key for deduplication."""
        return frozenset((b.day, b.start, b.end) for b in self.blocks)

    def __repr__(self) -> str:
        blocks_str = ", ".join(repr(b) for b in self.blocks)
        return f"CandidateSchedule([{blocks_str}], strategy='{self.strategy}')"


@dataclass
class TaskRequest:
    """
    Structured task parameters extracted by the LLM from natural language.
    Also passed to the LLM when it generates CandidateSchedule suggestions.
    """
    task_name: str
    total_duration_minutes: int
    task_type: str                        # "reading" | "problem_set" | "writing" | "other"
    deadline_day: str                     # "Thursday" — no block may fall after this day
    preferred_chunk_minutes: Optional[int] = None
    min_chunk_minutes: int = MIN_VIABLE_CHUNK_MINUTES
    max_chunk_minutes: int = 120
