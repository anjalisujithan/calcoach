"""
orchestrator.py

End-to-end pipeline: natural language → ranked schedule suggestions.

Flow:
  1. TaskExtractor   → TaskRequest (Claude extracts structure from text)
  2. ScheduleValidator.get_all_free_windows → free windows from calendar JSON
  3. CandidateGenerator → List[CandidateSchedule] (Claude proposes options)
  4. ScheduleValidator.filter_candidates → remove constraint-violating candidates
  5. LinUCBBandit.rank → personalised ranking (uses feature_extractor internally)

Usage:
    pipeline = SchedulingPipeline(user_profile, calendar_json)
    ranked, contexts = pipeline.suggest("I need to write my lab report, 2 hours, due Friday")

    # After user picks suggestion at index i:
    from calcoach.LLM_integration.reward_handler import FeedbackType
    pipeline.record_feedback(contexts[i], FeedbackType.ACCEPTED, rank_of_chosen=i+1)
"""

from __future__ import annotations

from typing import Dict, List, Optional, Tuple

import numpy as np

from calcoach.LLM_integration.task_extractor import TaskExtractor
from calcoach.LLM_integration.candidate_generator import CandidateGenerator
from calcoach.LLM_integration.reward_handler import FeedbackType, compute_reward
from calcoach.RL_exploration.slot_generator import ScheduleValidator
from calcoach.RL_exploration.feature_extractor import extract
from calcoach.RL_exploration.contextual_bandit import LinUCBBandit
from calcoach.models import CandidateSchedule, TaskRequest
from calcoach.user_profile.profile import UserProfile


class SchedulingPipeline:
    """
    Wires together the LLM layer and the RL layer into a single pipeline.

    Args:
        user_profile: the current user's profile (preferences, personality, bandit state)
        calendar_json: busy-time calendar in the ScheduleValidator format
            {"Monday": ["0900-1000", "1200-1300"], "Tuesday": [], ...}
        n_candidates: how many suggestions to request from Claude
        model: Claude model ID to use
        alpha: LinUCB exploration coefficient (higher = more exploration)
    """

    def __init__(
        self,
        user_profile: UserProfile,
        calendar_json: Dict[str, List[str]],
        n_candidates: int = 5,
        model: str = "claude-opus-4-6",
        alpha: float = 1.0,
    ) -> None:
        self.profile = user_profile
        self.calendar_json = calendar_json
        self.n_candidates = n_candidates

        self._extractor = TaskExtractor(model=model)
        self._generator = CandidateGenerator(model=model)
        self._validator = ScheduleValidator(user_profile.preferences)
        self._bandit = LinUCBBandit(alpha=alpha)

        # Saved after suggest() for use in record_feedback()
        self._last_task: Optional[TaskRequest] = None

    def suggest(
        self, user_text: str
    ) -> Tuple[List[CandidateSchedule], List[np.ndarray]]:
        """
        Full pipeline: text → ranked (candidate, context_vector) pairs.

        Args:
            user_text: natural language task description from the user

        Returns:
            (ranked_candidates, ranked_contexts)
            - ranked_candidates[0] is the top suggestion
            - ranked_contexts[i] is the 17-dim context vector for ranked_candidates[i],
              needed later to call record_feedback()
        """
        # Step 1: parse task from natural language
        task = self._extractor.extract(user_text)
        self._last_task = task

        # Step 2: get free windows from the calendar
        free_windows = self._validator.get_all_free_windows(self.calendar_json)

        # Step 3: generate candidate schedules with Claude
        raw_candidates = self._generator.generate(task, free_windows, self.n_candidates)

        # Step 4: filter — keep only candidates that pass all hard constraints
        valid_candidates = self._validator.filter_candidates(
            raw_candidates, self.calendar_json, task
        )

        if not valid_candidates:
            return [], []

        # Step 5: rank with the bandit (feature extraction happens inside rank())
        ranked_candidates = self._bandit.rank(
            valid_candidates, self.profile, task, self.calendar_json
        )

        # Step 6: compute context vectors for the ranked order
        # (needed by the caller so they can pass them to record_feedback)
        ranked_contexts = [
            extract(c, self.profile, task, self.calendar_json)
            for c in ranked_candidates
        ]

        return ranked_candidates, ranked_contexts

    def record_feedback(
        self,
        context_vector: np.ndarray,
        feedback: FeedbackType,
        rank_of_chosen: int = 1,
    ) -> None:
        """
        Update the bandit with the user's feedback on a suggestion.
        Mutates self.profile.bandit_state in place — persist to DB afterwards.

        Args:
            context_vector: the 17-dim vector for the candidate the user acted on,
                            as returned in ranked_contexts from suggest()
            feedback: what the user did (accepted, rejected, etc.)
            rank_of_chosen: 1-indexed rank of the candidate the user interacted with
        """
        reward = compute_reward(feedback, rank_of_chosen, n_candidates=self.n_candidates)
        self._bandit.update(context_vector, reward, self.profile)
