"""
reward_handler.py

Converts user feedback on a suggested schedule into a scalar reward value
that gets fed to LinUCBBandit.update().

Reward scale: -1.0 (strongly bad) to +1.0 (strongly good).

Usage:
    reward = compute_reward(feedback_type, rank_of_chosen, n_candidates)
    bandit.update(context_vector, reward)
"""

from __future__ import annotations

from enum import Enum


class FeedbackType(str, Enum):
    ACCEPTED          = "accepted"          # User picked this suggestion as-is → strong positive
    ACCEPTED_MODIFIED = "accepted_modified" # User picked it but tweaked times → mild positive
    REJECTED          = "rejected"          # User explicitly dismissed it → negative
    TIMEOUT           = "timeout"           # User never responded → neutral/slight negative
    COMPLETED_TASK    = "completed_task"    # User marked the task done after using this → bonus


# Reward table (base values, adjusted by rank below)
_BASE_REWARD: dict[FeedbackType, float] = {
    FeedbackType.ACCEPTED:          +1.0,
    FeedbackType.ACCEPTED_MODIFIED: +0.5,
    FeedbackType.REJECTED:          -0.5,
    FeedbackType.TIMEOUT:           -0.1,
    FeedbackType.COMPLETED_TASK:    +1.0,   # applied on top of ACCEPTED
}

# Rank discount: if the user picks the 3rd suggestion instead of the 1st, the
# bandit gets slightly less credit (we expect the model to surface the best first).
_RANK_DISCOUNT_PER_POSITION = 0.05  # e.g. rank=2 → discount of 0.05


def compute_reward(
    feedback: FeedbackType,
    rank_of_chosen: int = 1,
    n_candidates: int = 5,
) -> float:
    """
    Compute a scalar reward in [-1.0, +1.0].

    Args:
        feedback: the type of user feedback received
        rank_of_chosen: 1-indexed position of the chosen candidate in the ranked list
                        (1 = top suggestion). Use 1 for rejected/timeout.
        n_candidates: total number of suggestions shown (used to normalise rank discount)

    Returns:
        float reward clamped to [-1.0, +1.0]
    """
    base = _BASE_REWARD[feedback]

    # Apply rank discount only for positive rewards and only when the user chose
    # a lower-ranked option (meaning the top suggestions weren't ideal).
    if base > 0 and rank_of_chosen > 1:
        discount = _RANK_DISCOUNT_PER_POSITION * (rank_of_chosen - 1)
        base = max(0.0, base - discount)

    return max(-1.0, min(1.0, base))
