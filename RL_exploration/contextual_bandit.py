"""
contextual_bandit.py

LinUCB contextual bandit for ranking scheduling candidates.

Algorithm: LinUCB (disjoint arms)
  For each candidate, score = θᵀx + α * sqrt(xᵀA⁻¹x)
    θ    = A⁻¹b          — learned preference vector for this user
    xᵀA⁻¹x              — uncertainty bonus (higher when A has seen little data)
    α                    — exploration coefficient (higher = more exploration)

  On feedback (reward r for context vector x):
    A ← A + xxᵀ
    b ← b + r·x

Per-user state (A, b) is stored in UserProfile.bandit_state and persisted to the DB.
At cold start (A=I, b=0): θ=0, so ranking is purely by uncertainty — candidates
with more extreme feature values get explored first. Personality weights in the
context vector act as a prior that shapes this early exploration.

Reward signal (set by reward_handler.py, not this module):
  Immediate:  accept=1.0, reject varies by reason (0.0 – 0.3)
  Delayed:    session rating + completion % combined into 0.0–1.0
  Combined:   r = 0.4 * immediate + 0.6 * delayed
"""

from __future__ import annotations

from datetime import datetime
from typing import Dict, List, Tuple

import numpy as np

from calcoach.models import CandidateSchedule, TaskRequest
from calcoach.user_profile import BanditState, UserProfile
from calcoach.RL_exploration.feature_extractor import CONTEXT_DIM, FEATURE_NAMES, extract


# ---------------------------------------------------------------------------
# LinUCBBandit
# ---------------------------------------------------------------------------

class LinUCBBandit:
    """
    Contextual bandit that learns per-user scheduling preferences via LinUCB.

    Usage:
        bandit = LinUCBBandit(alpha=1.0)

        # Rank LLM candidates for a user
        ranked = bandit.rank(candidates, user_profile, task, calendar_json)

        # After user accepts/rejects and completes session:
        context_vec = extract(chosen_candidate, user_profile, task, calendar_json)
        bandit.update(context_vec, reward=0.8, user_profile=user_profile)
        # Caller is responsible for persisting user_profile to DB after update
    """

    def __init__(self, alpha: float = 1.0) -> None:
        """
        Args:
            alpha: Exploration coefficient. Higher = more uncertainty bonus,
                   more exploration. Start at 1.0; tune down as users accumulate data.
        """
        self.alpha = alpha

    # ------------------------------------------------------------------
    # Public: rank
    # ------------------------------------------------------------------

    def rank(
        self,
        candidates: List[CandidateSchedule],
        user_profile: UserProfile,
        task: TaskRequest,
        calendar_json: Dict[str, List[str]],
    ) -> List[CandidateSchedule]:
        """
        Score and rank candidates for this user, best first.

        Args:
            candidates:    Valid candidates from ScheduleValidator (already filtered)
            user_profile:  User's current profile including bandit state
            task:          The TaskRequest being scheduled
            calendar_json: Raw busy-calendar JSON for feature extraction

        Returns:
            candidates sorted by LinUCB score descending (index 0 = best suggestion)
        """
        if not candidates:
            return []

        A, b = self._load_state(user_profile.bandit_state)
        A_inv = np.linalg.inv(A)
        theta = A_inv @ b

        scored: List[Tuple[float, CandidateSchedule]] = []
        for candidate in candidates:
            x = extract(candidate, user_profile, task, calendar_json)
            score = self._score(x, theta, A_inv)
            scored.append((score, candidate))

        scored.sort(key=lambda t: t[0], reverse=True)
        return [c for _, c in scored]

    def score_all(
        self,
        candidates: List[CandidateSchedule],
        user_profile: UserProfile,
        task: TaskRequest,
        calendar_json: Dict[str, List[str]],
    ) -> List[Tuple[CandidateSchedule, float]]:
        """
        Same as rank but returns (candidate, score) pairs.
        Useful for debugging and evaluation.
        """
        if not candidates:
            return []

        A, b = self._load_state(user_profile.bandit_state)
        A_inv = np.linalg.inv(A)
        theta = A_inv @ b

        results = []
        for candidate in candidates:
            x = extract(candidate, user_profile, task, calendar_json)
            score = self._score(x, theta, A_inv)
            results.append((candidate, score))

        results.sort(key=lambda t: t[1], reverse=True)
        return results

    # ------------------------------------------------------------------
    # Public: update
    # ------------------------------------------------------------------

    def update(
        self,
        context_vector: np.ndarray,
        reward: float,
        user_profile: UserProfile,
    ) -> None:
        """
        Update the bandit's learned parameters after observing a reward.
        Modifies user_profile.bandit_state in place — caller must persist to DB.

        Args:
            context_vector: Feature vector of the chosen candidate (from extract())
            reward:         Scalar reward in [0, 1] (from reward_handler.py)
            user_profile:   User whose bandit state gets updated
        """
        x = context_vector.reshape(-1)
        A, b = self._load_state(user_profile.bandit_state)

        A = A + np.outer(x, x)   # A ← A + xxᵀ
        b = b + reward * x        # b ← b + r·x

        self._save_state(user_profile.bandit_state, A, b)
        user_profile.touch()

    # ------------------------------------------------------------------
    # Interpretability helper
    # ------------------------------------------------------------------

    def learned_weights(self, user_profile: UserProfile) -> Dict[str, float]:
        """
        Return the learned θ vector mapped to feature names.
        Positive weight → bandit prefers candidates with higher values of that feature.
        Negative weight → bandit avoids candidates with higher values of that feature.
        Useful for the analytics dashboard and for debugging.
        """
        A, b = self._load_state(user_profile.bandit_state)
        theta = np.linalg.inv(A) @ b
        return dict(zip(FEATURE_NAMES, theta.tolist()))

    # ------------------------------------------------------------------
    # Private helpers
    # ------------------------------------------------------------------

    def _score(
        self, x: np.ndarray, theta: np.ndarray, A_inv: np.ndarray
    ) -> float:
        """
        LinUCB score for a single context vector.
          exploitation term: θᵀx       (how well this matches learned preferences)
          exploration bonus: α√(xᵀA⁻¹x) (higher when this region is under-explored)
        """
        exploitation = float(theta @ x)
        exploration = self.alpha * float(np.sqrt(x @ A_inv @ x))
        return exploitation + exploration

    def _load_state(self, bandit_state: BanditState) -> Tuple[np.ndarray, np.ndarray]:
        """
        Return (A, b) as numpy arrays.
        Initializes to (identity, zeros) if this user has no bandit state yet.
        """
        if not bandit_state.is_initialized:
            return np.eye(CONTEXT_DIM), np.zeros(CONTEXT_DIM)
        return np.array(bandit_state.A), np.array(bandit_state.b)

    def _save_state(
        self, bandit_state: BanditState, A: np.ndarray, b: np.ndarray
    ) -> None:
        """Serialize numpy arrays back into BanditState for DB persistence."""
        bandit_state.A = A.tolist()
        bandit_state.b = b.tolist()
        bandit_state.n_updates += 1
        bandit_state.last_updated = datetime.utcnow().isoformat()
