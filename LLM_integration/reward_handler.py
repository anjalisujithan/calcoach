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


def compute_productivity_reward(
    productivity: int,
    session_length_feedback: str | None = None,
    timing_feedback: str | None = None,
    breaks_feedback: str | None = None,
) -> float:
    """
    Compute a delayed scalar reward from post-session reflection data.

    This is called when the user rates a completed session — it tells the bandit
    how well the *placed* slot actually worked out, not just that it was accepted.

    Args:
        productivity: 1–5 emoji score from the Reflect panel
                      1 → -0.8 (terrible), 3 → 0.1 (neutral), 5 → +1.0 (great)
        session_length_feedback: 'too_short' | 'just_right' | 'too_long'
                      Nudges the reward to signal whether block size was appropriate.
        timing_feedback: 'too_early' | 'good_timing' | 'too_late'
                      Nudges the reward to signal whether the time-of-day was right.
        breaks_feedback: 'too_many' | 'just_right' | 'too_few'
                      Nudges the reward to signal whether chunking/fragmentation was right.
                      too_many → blocks were too short/fragmented
                      too_few  → blocks were too long without a break

    Returns:
        float reward clamped to [-1.0, +1.0]
    """
    # Map 1-5 → roughly [-0.8, +1.0] with 3 ≈ neutral
    prod_reward = (productivity - 1) / 4.0 * 1.8 - 0.8

    # Session length: wrong length → small penalty; right length → small bonus
    _length_adj: dict[str, float] = {
        "too_short":  -0.10,
        "just_right": +0.10,
        "too_long":   -0.20,  # longer than needed is worse than shorter
    }
    length_adj = _length_adj.get(session_length_feedback or "just_right", 0.0)

    # Timing: wrong time-of-day → small penalty; good timing → small bonus
    _timing_adj: dict[str, float] = {
        "too_early":   -0.15,
        "good_timing": +0.10,
        "too_late":    -0.15,
    }
    timing_adj = _timing_adj.get(timing_feedback or "good_timing", 0.0)

    # Breaks / chunking: fragmented or marathon → penalty; well-paced → small bonus
    # This maps to the block_duration and n_blocks features in the context vector.
    _breaks_adj: dict[str, float] = {
        "too_many":   -0.15,  # over-fragmented: too many short blocks
        "just_right": +0.10,
        "too_few":    -0.15,  # under-broken: blocks were too long without a break
    }
    breaks_adj = _breaks_adj.get(breaks_feedback or "just_right", 0.0)

    return max(-1.0, min(1.0, prod_reward + length_adj + timing_adj + breaks_adj))


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
