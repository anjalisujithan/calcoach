from __future__ import annotations
from dataclasses import dataclass
from typing import List, Optional


@dataclass
class BanditState:
    """
    Per-user LinUCB state: A matrix (d×d) and b vector (d,).
    d = context vector dimension, fixed by feature_extractor.CONTEXT_DIM.

    Stored as nested Python lists for JSON / JSONB compatibility.
    Lazily initialized in contextual_bandit.py once d is known.
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
