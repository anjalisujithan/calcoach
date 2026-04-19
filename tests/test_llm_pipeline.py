"""
test_llm_pipeline.py

Smoke-test the full Claude → RL pipeline end-to-end.
Run from the calcoach/ folder:

    cd /path/to/CalCoach/calcoach
    export ANTHROPIC_API_KEY="sk-ant-..."
    python -m tests.test_llm_pipeline
"""

from __future__ import annotations

import os
import sys

# ── Fake calendar: some days busy, some free ─────────────────────────────────
SAMPLE_CALENDAR = {
    "Monday":    ["0800-1800"],              # fully blocked
    "Tuesday":   ["0800-0930", "1200-1400"], # free: 0930-1200, 1400-1800
    "Wednesday": ["0900-1100"],              # free: 0800-0900, 1100-1800
    "Thursday":  ["0800-0930", "1500-1800"], # free: 0930-1500
    "Friday":    ["0800-1800"],              # fully blocked
    "Saturday":  [],                         # completely free (but avoid_days)
    "Sunday":    [],                         # completely free (but avoid_days)
}


def main() -> None:
    api_key = os.environ.get("ANTHROPIC_API_KEY")
    if not api_key:
        print("ERROR: Set ANTHROPIC_API_KEY before running this test.")
        sys.exit(1)

    # ── Build a minimal user profile ─────────────────────────────────────────
    from calcoach.user_profile.preferences import UserPreferences
    from calcoach.user_profile.profile import UserProfile

    prefs = UserPreferences(
        work_start="09:00",
        work_end="18:00",
        avoid_days=["Saturday", "Sunday"],
        buffer_minutes=10,
        max_daily_work_minutes=240,
    )
    profile = UserProfile.new_user(
        user_id="test_user_001",
        name="Test User",
        preferences=prefs,
    )

    # ── Run the pipeline ─────────────────────────────────────────────────────
    from calcoach.LLM_integration.orchestrator import SchedulingPipeline

    pipeline = SchedulingPipeline(
        user_profile=profile,
        calendar_json=SAMPLE_CALENDAR,
        n_candidates=4,
    )

    user_request = (
        "I need to finish my CS project writeup. "
        "It'll take about 2.5 hours. Deadline is Thursday."
    )
    print(f"\nUser: {user_request}\n")
    print("Calling Claude + RL pipeline...\n")

    ranked_candidates, ranked_contexts = pipeline.suggest(user_request)

    if not ranked_candidates:
        print("No valid candidates found — check calendar / deadline constraints.")
        return

    print(f"✓ Got {len(ranked_candidates)} ranked suggestions:\n")
    for i, (c, ctx) in enumerate(zip(ranked_candidates, ranked_contexts)):
        print(f"  #{i+1} [{c.strategy}]")
        for b in c.blocks:
            print(f"       {b}")
        print(f"       total: {c.total_minutes} min | context dim: {ctx.shape[0]}")
        print()

    # Simulate user accepting the top suggestion
    from calcoach.LLM_integration.reward_handler import FeedbackType
    pipeline.record_feedback(
        context_vector=ranked_contexts[0],
        feedback=FeedbackType.ACCEPTED,
        rank_of_chosen=1,
    )
    print("✓ Bandit updated with ACCEPTED feedback for suggestion #1.")
    print(f"  bandit n_updates: {profile.bandit_state.n_updates}")


if __name__ == "__main__":
    main()
