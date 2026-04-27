"""
slot_gen_unit.py

Unit tests for ScheduleValidator in slot_generator.py.

The validator's job: given LLM-proposed CandidateSchedules, filter out any
that violate hard constraints (conflicts, work hours, deadlines, etc.).

Run from repo root:
    python -m tests.slot_gen_unit
"""

import sys
from pathlib import Path
sys.path.insert(0, str(Path(__file__).resolve().parent.parent / "analytics" / "backend"))

from user_profile import UserPreferences
from models import Block, CandidateSchedule, TaskRequest
from RL_exploration.slot_generator import ScheduleValidator, _parse_hhmm


# ---------------------------------------------------------------------------
# Shared fixtures
# ---------------------------------------------------------------------------

PREFS = UserPreferences(
    work_start="09:00",
    work_end="18:00",
    buffer_minutes=10,
    preferred_chunk_minutes=45,
    max_daily_work_minutes=240,
    avoid_days=["Saturday", "Sunday"],
)

CALENDAR = {
    "Monday":    ["0800-0930", "1200-1300"],
    "Tuesday":   ["0900-1030", "1500-1600"],
    "Wednesday": ["1100-1200"],
    "Thursday":  ["0800-0900", "1300-1400"],
    "Friday":    [],
}

TASK = TaskRequest(
    task_name="61A HW6",
    total_duration_minutes=150,
    task_type="problem_set",
    deadline_day="Thursday",
    preferred_chunk_minutes=45,
)


def _block(day, start_hhmm, end_hhmm):
    """Helper: build a Block from string times."""
    s = _parse_hhmm(start_hhmm)
    e = _parse_hhmm(end_hhmm)
    mins = (e.hour * 60 + e.minute) - (s.hour * 60 + s.minute)
    return Block(day=day, start=s, end=e, duration_minutes=mins)


def _candidate(*blocks, strategy="test"):
    total = sum(b.duration_minutes for b in blocks)
    return CandidateSchedule(blocks=list(blocks), total_minutes=total, strategy=strategy)


# ---------------------------------------------------------------------------
# Free window tests
# ---------------------------------------------------------------------------

def test_free_windows_apply_buffer():
    """Buffer should push free window start past the end of a busy slot."""
    v = ScheduleValidator(PREFS)
    windows = v.get_all_free_windows(CALENDAR)
    # Monday busy: 0800-0930 → with 10-min buffer, free should start at 0940
    monday = windows["Monday"]
    assert monday[0][0].strftime("%H%M") == "0940", (
        f"Expected free to start at 0940, got {monday[0][0].strftime('%H%M')}"
    )


def test_avoid_days_have_no_windows():
    """Days in avoid_days must return empty free windows."""
    v = ScheduleValidator(PREFS)
    windows = v.get_all_free_windows(CALENDAR)
    assert windows["Saturday"] == []
    assert windows["Sunday"] == []


# ---------------------------------------------------------------------------
# validate_block tests
# ---------------------------------------------------------------------------

def test_valid_block_passes():
    """A block that sits cleanly inside a free window should pass."""
    v = ScheduleValidator(PREFS)
    free = v.get_all_free_windows(CALENDAR)
    # Monday free after 0940; block 1000-1045 is safely inside
    ok, reason = v.validate_block(_block("Monday", "1000", "1045"), free, "Thursday")
    assert ok, f"Expected valid, got: {reason}"


def test_block_conflicting_with_busy_fails():
    """A block that overlaps a busy event (ignoring buffer) should fail."""
    v = ScheduleValidator(PREFS)
    free = v.get_all_free_windows(CALENDAR)
    # Monday busy 0800-0930; block 0900-0945 overlaps
    ok, _ = v.validate_block(_block("Monday", "0900", "0945"), free, "Thursday")
    assert not ok


def test_block_inside_buffer_zone_fails():
    """A block that starts within the buffer zone after a busy event should fail."""
    v = ScheduleValidator(PREFS)
    free = v.get_all_free_windows(CALENDAR)
    # Monday busy ends 0930, buffer=10min → free starts 0940
    # Block 0932-1017 starts inside the buffer zone
    ok, _ = v.validate_block(_block("Monday", "0932", "1017"), free, "Thursday")
    assert not ok


def test_block_past_deadline_fails():
    """A block scheduled after deadline_day should fail."""
    v = ScheduleValidator(PREFS)
    free = v.get_all_free_windows(CALENDAR)
    # deadline is Thursday; Friday block should fail
    ok, reason = v.validate_block(_block("Friday", "1000", "1045"), free, "Thursday")
    assert not ok
    assert "deadline" in reason.lower()


def test_block_on_avoided_day_fails():
    """A block on a day in avoid_days should fail."""
    v = ScheduleValidator(PREFS)
    free = v.get_all_free_windows(CALENDAR)
    ok, reason = v.validate_block(_block("Saturday", "1000", "1045"), free, "Sunday")
    assert not ok
    assert "avoid_days" in reason


def test_block_before_work_start_fails():
    """A block starting before work_start should fail."""
    v = ScheduleValidator(PREFS)
    free = v.get_all_free_windows(CALENDAR)
    # work starts 09:00; block 0800-0845 is before that
    ok, _ = v.validate_block(_block("Wednesday", "0800", "0845"), free, "Thursday")
    assert not ok


def test_block_after_work_end_fails():
    """A block ending after work_end should fail."""
    v = ScheduleValidator(PREFS)
    free = v.get_all_free_windows(CALENDAR)
    # work ends 18:00; block 1730-1830 runs past that
    ok, _ = v.validate_block(_block("Wednesday", "1730", "1830"), free, "Thursday")
    assert not ok


# ---------------------------------------------------------------------------
# validate_candidate tests
# ---------------------------------------------------------------------------

def test_valid_candidate_passes():
    """A well-formed candidate with non-conflicting blocks should pass."""
    v = ScheduleValidator(PREFS)
    free = v.get_all_free_windows(CALENDAR)
    cand = _candidate(
        _block("Monday",    "1000", "1045"),   # 45min — in free window
        _block("Wednesday", "0900", "1000"),   # 60min — in free window
        _block("Thursday",  "0910", "0955"),   # 45min — in free window
    )
    ok, reason = v.validate_candidate(cand, free, TASK)
    assert ok, f"Expected valid candidate, got: {reason}"


def test_candidate_with_conflicting_block_fails():
    """A candidate containing even one bad block should be rejected entirely."""
    v = ScheduleValidator(PREFS)
    free = v.get_all_free_windows(CALENDAR)
    cand = _candidate(
        _block("Monday", "1000", "1045"),   # valid
        _block("Monday", "0900", "0945"),   # conflicts with busy 0800-0930
    )
    ok, _ = v.validate_candidate(cand, free, TASK)
    assert not ok


def test_candidate_with_intra_overlap_fails():
    """Two blocks on the same day that overlap each other should fail."""
    v = ScheduleValidator(PREFS)
    free = v.get_all_free_windows(CALENDAR)
    # Both blocks are in free windows individually, but they overlap each other
    cand = _candidate(
        _block("Wednesday", "0900", "1000"),
        _block("Wednesday", "0930", "1030"),  # starts before the first ends
    )
    ok, reason = v.validate_candidate(cand, free, TASK)
    assert not ok
    assert "overlap" in reason.lower()


def test_candidate_exceeds_daily_cap_fails():
    """A candidate that puts too many minutes on one day should fail."""
    prefs = UserPreferences(
        work_start="09:00",
        work_end="18:00",
        buffer_minutes=0,
        preferred_chunk_minutes=60,
        max_daily_work_minutes=60,   # very tight cap: only 1 hour/day
        avoid_days=["Saturday", "Sunday"],
    )
    v = ScheduleValidator(prefs)
    free = v.get_all_free_windows({"Friday": []})
    friday_task = TaskRequest(
        task_name="Cap test",
        total_duration_minutes=120,
        task_type="other",
        deadline_day="Friday",   # Friday deadline so blocks aren't rejected for that
    )
    cand = _candidate(
        _block("Friday", "0900", "1000"),   # 60min — exactly at cap
        _block("Friday", "1000", "1100"),   # 60min more — exceeds cap
    )
    ok, reason = v.validate_candidate(cand, free, friday_task)
    assert not ok
    assert "cap" in reason.lower()


def test_candidate_insufficient_duration_fails():
    """A candidate whose blocks don't add up to total_duration_minutes should fail."""
    v = ScheduleValidator(PREFS)
    free = v.get_all_free_windows(CALENDAR)
    # Task needs 150min; this candidate only covers 45min
    cand = CandidateSchedule(
        blocks=[_block("Monday", "1000", "1045")],
        total_minutes=45,   # explicitly under-reports
        strategy="test",
    )
    ok, reason = v.validate_candidate(cand, free, TASK)
    assert not ok
    assert "150min" in reason


# ---------------------------------------------------------------------------
# filter_candidates tests
# ---------------------------------------------------------------------------

def test_filter_keeps_valid_removes_invalid():
    """filter_candidates should return only the valid subset, preserving order."""
    v = ScheduleValidator(PREFS)

    valid_1 = _candidate(
        _block("Monday",    "1000", "1045"),
        _block("Wednesday", "0900", "1000"),
        _block("Thursday",  "0910", "0955"),
        strategy="valid_spread",
    )
    invalid_conflict = _candidate(
        _block("Monday", "0850", "0950"),   # conflicts with busy 0800-0930
        _block("Tuesday", "1100", "1200"),
        _block("Wednesday", "0900", "1000"),
        strategy="invalid_conflict",
    )
    valid_2 = _candidate(
        _block("Wednesday", "0900", "1050"),  # 110min
        _block("Thursday",  "0910", "0950"),  # 40min → total 150min
        strategy="valid_wednesday_thursday",
    )

    results = v.filter_candidates(
        [valid_1, invalid_conflict, valid_2], CALENDAR, TASK
    )
    strategies = [c.strategy for c in results]
    assert "valid_spread" in strategies
    assert "valid_wednesday_thursday" in strategies
    assert "invalid_conflict" not in strategies
    assert len(results) == 2


def test_filter_all_invalid_returns_empty():
    """filter_candidates with no valid options should return empty list."""
    v = ScheduleValidator(PREFS)
    bad = _candidate(_block("Saturday", "1000", "1045"), strategy="weekend")
    assert v.filter_candidates([bad], CALENDAR, TASK) == []


def test_filter_with_reasons_exposes_rejection_cause():
    """filter_candidates_with_reasons should explain why each candidate failed."""
    v = ScheduleValidator(PREFS)
    bad = _candidate(_block("Saturday", "1000", "1045"), strategy="weekend")
    results = v.filter_candidates_with_reasons([bad], CALENDAR, TASK)
    assert len(results) == 1
    _, is_valid, reason = results[0]
    assert not is_valid
    assert reason != ""


# ---------------------------------------------------------------------------
# Smoke test (print-style, run directly)
# ---------------------------------------------------------------------------

def run_smoke_test():
    v = ScheduleValidator(PREFS)

    print("=== Free windows ===")
    for day, windows in v.get_all_free_windows(CALENDAR).items():
        if windows:
            print(f"  {day}: {[(w[0].strftime('%H%M'), w[1].strftime('%H%M')) for w in windows]}")

    # Simulate what the LLM might propose — mix of valid and invalid
    llm_proposals = [
        _candidate(
            _block("Monday",    "1000", "1045"),
            _block("Wednesday", "0900", "1000"),
            _block("Thursday",  "0910", "0955"),
            strategy="spread_morning",
        ),
        _candidate(
            _block("Monday", "0850", "0950"),   # conflicts with busy
            _block("Tuesday", "1100", "1145"),
            _block("Wednesday", "0900", "0945"),
            strategy="bad_monday_start",
        ),
        _candidate(
            _block("Wednesday", "0900", "1050"),
            _block("Thursday",  "0910", "0950"),
            strategy="wed_thu_focused",
        ),
        _candidate(
            _block("Friday", "0900", "1030"),   # Friday is past Thursday deadline
            strategy="past_deadline",
        ),
    ]

    print(f"\n=== LLM proposed {len(llm_proposals)} candidates ===")
    results = v.filter_candidates_with_reasons(llm_proposals, CALENDAR, TASK)
    for cand, is_valid, reason in results:
        status = "VALID  " if is_valid else "INVALID"
        label = f"strategy='{cand.strategy}'"
        print(f"  {status}  {label}" + (f"  → {reason}" if not is_valid else ""))

    valid = [c for c, ok, _ in results if ok]
    print(f"\n  {len(valid)}/{len(llm_proposals)} candidates passed validation")
    print("  (these are passed to the contextual bandit for ranking)")


# ---------------------------------------------------------------------------
# Runner
# ---------------------------------------------------------------------------

if __name__ == "__main__":
    tests = [
        test_free_windows_apply_buffer,
        test_avoid_days_have_no_windows,
        test_valid_block_passes,
        test_block_conflicting_with_busy_fails,
        test_block_inside_buffer_zone_fails,
        test_block_past_deadline_fails,
        test_block_on_avoided_day_fails,
        test_block_before_work_start_fails,
        test_block_after_work_end_fails,
        test_valid_candidate_passes,
        test_candidate_with_conflicting_block_fails,
        test_candidate_with_intra_overlap_fails,
        test_candidate_exceeds_daily_cap_fails,
        test_candidate_insufficient_duration_fails,
        test_filter_keeps_valid_removes_invalid,
        test_filter_all_invalid_returns_empty,
        test_filter_with_reasons_exposes_rejection_cause,
    ]
    failed = 0
    for t in tests:
        try:
            t()
            print(f"  PASS  {t.__name__}")
        except AssertionError as e:
            print(f"  FAIL  {t.__name__}: {e}")
            failed += 1

    print(f"\n{len(tests) - failed}/{len(tests)} tests passed\n")
    run_smoke_test()
