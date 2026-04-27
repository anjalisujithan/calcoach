"""
test_recurring_recovery.py

Regression tests for the recurring-event payload normalization and recovery
helpers in analytics/backend/main.py.

Reproduces the user-visible bug from chat where the LLM emitted:
    {"events_to_create": [{
        "title": "Running Practice",
        "recurrence": ["RRULE:FREQ=WEEKLY;BYDAY=MO,TU,TH,FR"],
        "durationMins": 60,
        "COUNT": 12
    }]}
…and the chat handler raised ValidationError on the missing date / startHour /
startMin, leaked the raw JSON into the chat surface, and never created the event.

Run from repo root:
    python -m tests.test_recurring_recovery

Or under pytest:
    pytest tests/test_recurring_recovery.py -q
"""

from __future__ import annotations

import importlib.util
import sys
from datetime import datetime, timezone, timedelta
from pathlib import Path

REPO_ROOT = Path(__file__).resolve().parent.parent
BACKEND_DIR = REPO_ROOT / "analytics" / "backend"


def _load_main_module():
    """Import analytics/backend/main.py without polluting sys.modules with the
    package name the FastAPI app uses."""
    if str(BACKEND_DIR) not in sys.path:
        sys.path.insert(0, str(BACKEND_DIR))
    spec = importlib.util.spec_from_file_location(
        "calcoach_analytics_main", BACKEND_DIR / "main.py"
    )
    module = importlib.util.module_from_spec(spec)
    assert spec.loader is not None
    spec.loader.exec_module(module)
    return module


main = _load_main_module()

# When main.py is loaded via spec_from_file_location its module name is custom, so
# Pydantic's lazy field-type resolution can't find `List` in the model's namespace.
# Force a rebuild against main.py's globals so CalendarEvent(...) works in tests.
try:
    main.CalendarEvent.model_rebuild(_types_namespace=main.__dict__)
except Exception:
    pass


# ---------------------------------------------------------------------------
# _normalize_recurrence_payload
# ---------------------------------------------------------------------------


def test_normalize_folds_top_level_count_into_rrule():
    payload = {
        "title": "Running Practice",
        "recurrence": ["RRULE:FREQ=WEEKLY;BYDAY=MO,TU,TH,FR"],
        "durationMins": 60,
        "COUNT": 12,
    }
    out = main._normalize_recurrence_payload(payload)
    assert "COUNT" not in out, "COUNT should be folded into the RRULE string"
    assert out["recurrence"] == [
        "RRULE:FREQ=WEEKLY;BYDAY=MO,TU,TH,FR;COUNT=12"
    ]


def test_normalize_folds_top_level_until_into_rrule():
    payload = {
        "title": "Marathon Prep",
        "recurrence": ["RRULE:FREQ=WEEKLY;BYDAY=MO,WE,FR"],
        "UNTIL": "20260726",
    }
    out = main._normalize_recurrence_payload(payload)
    assert "UNTIL" not in out
    assert out["recurrence"][0].endswith("UNTIL=20260726")


def test_normalize_does_not_double_add_existing_key():
    payload = {
        "recurrence": ["RRULE:FREQ=WEEKLY;BYDAY=TU;COUNT=4"],
        "COUNT": 99,
    }
    out = main._normalize_recurrence_payload(payload)
    rule = out["recurrence"][0]
    assert rule.count("COUNT=") == 1, "Should not duplicate existing COUNT clause"
    assert "COUNT=4" in rule, "Existing COUNT value should win"


def test_normalize_synthesizes_rrule_from_loose_fields():
    payload = {"FREQ": "WEEKLY", "BYDAY": "MO,WE", "COUNT": 6}
    out = main._normalize_recurrence_payload(payload)
    assert out["recurrence"], "Should synthesize an RRULE when only loose fields exist"
    rule = out["recurrence"][0]
    assert rule.startswith("RRULE:")
    assert "BYDAY=MO,WE" in rule
    assert "COUNT=6" in rule


# ---------------------------------------------------------------------------
# _recover_recurring_event
# ---------------------------------------------------------------------------


def test_recover_fills_date_from_byday_when_time_present_in_history():
    History = main.HistoryMessage
    history = [
        History(role="user", text="schedule a recurring running practice four times a week, prep for marathon july 26"),
        History(role="assistant", text="Which days?"),
        History(role="user", text="mon, tues, thurs, fri"),
        History(role="assistant", text="What time of day?"),
    ]
    partial = {
        "title": "Running Practice",
        "recurrence": ["RRULE:FREQ=WEEKLY;BYDAY=MO,TU,TH,FR"],
        "durationMins": 60,
    }
    recovered = main._recover_recurring_event(partial, "7am please", history)
    assert recovered is not None, "Should recover when start time given in latest message"
    assert recovered["startHour"] == 7
    assert recovered["startMin"] == 0
    assert recovered["durationMins"] == 60
    assert recovered["date"], "Should derive a first-occurrence date from BYDAY"
    # Date must be a Monday/Tuesday/Thursday/Friday going forward
    parsed_dt = datetime.strptime(recovered["date"], "%Y-%m-%d")
    assert parsed_dt.weekday() in {0, 1, 3, 4}
    # UNTIL should have been folded in from the marathon date in history
    assert "UNTIL=20260726" in recovered["recurrence"][0]


def test_recover_returns_none_when_start_time_missing():
    History = main.HistoryMessage
    history = [
        History(role="user", text="schedule recurring running practice four times a week"),
    ]
    partial = {
        "title": "Running Practice",
        "recurrence": ["RRULE:FREQ=WEEKLY;BYDAY=MO,TU,TH,FR"],
        "durationMins": 60,
    }
    recovered = main._recover_recurring_event(partial, "mon, tues, thurs, fri", history)
    assert recovered is None, "Should refuse to fabricate a start time"


def test_recover_uses_workStartHour_from_survey_prefs_when_no_time_in_text():
    History = main.HistoryMessage
    history = [
        History(role="user", text="schedule a weekly gym session every Monday for 8 weeks"),
    ]
    partial = {
        "title": "Gym",
        "recurrence": ["RRULE:FREQ=WEEKLY;BYDAY=MO;COUNT=8"],
        "durationMins": 60,
    }
    recovered = main._recover_recurring_event(
        partial, "ok", history, user_profile_prefs={"workStartHour": 9}
    )
    assert recovered is not None
    assert recovered["startHour"] == 9
    assert recovered["startMin"] == 0


# ---------------------------------------------------------------------------
# _missing_field_question
# ---------------------------------------------------------------------------


def test_missing_field_question_lists_missing_pieces():
    q = main._missing_field_question(
        {"title": "Running Practice", "recurrence": ["RRULE:FREQ=WEEKLY;BYDAY=MO"]}
    )
    assert "Running Practice" in q
    assert "time" in q.lower()


# ---------------------------------------------------------------------------
# _infer_until_yyyymmdd
# ---------------------------------------------------------------------------


def test_infer_until_handles_prep_for_marathon_phrase():
    now = datetime(2026, 4, 1, tzinfo=timezone.utc)
    out = main._infer_until_yyyymmdd("prep for marathon july 26", now)
    assert out == "20260726"


def test_infer_until_handles_before_phrase():
    now = datetime(2026, 4, 1, tzinfo=timezone.utc)
    out = main._infer_until_yyyymmdd("study sessions before may 15", now)
    assert out == "20260515"


def test_infer_until_rolls_year_forward_when_month_already_past():
    now = datetime(2026, 8, 1, tzinfo=timezone.utc)
    out = main._infer_until_yyyymmdd("until march 1", now)
    assert out == "20270301"


# ---------------------------------------------------------------------------
# _is_recurring_request_in_context
# ---------------------------------------------------------------------------


def test_is_recurring_request_in_context_uses_history():
    History = main.HistoryMessage
    history = [
        History(role="user", text="schedule a recurring gym session"),
        History(role="assistant", text="Which days?"),
    ]
    # Latest message alone has no recurring keywords, but history does.
    assert main._is_recurring_request_in_context("mon and wed", history)
    assert not main._is_recurring_request_in_context("mon and wed", [])


# ---------------------------------------------------------------------------
# _dedupe_events_to_create
# ---------------------------------------------------------------------------


def _ev(**kwargs):
    """Build a CalendarEvent with sane defaults for terse test cases."""
    return main.CalendarEvent(
        title=kwargs.get("title", "Running Practice"),
        description=kwargs.get("description", ""),
        date=kwargs.get("date", "2026-04-27"),
        startHour=kwargs.get("startHour", 7),
        startMin=kwargs.get("startMin", 0),
        durationMins=kwargs.get("durationMins", 60),
        recurrence=kwargs.get("recurrence", []),
    )


def test_dedupe_collapses_identical_recurring_series():
    rule = "RRULE:FREQ=WEEKLY;BYDAY=MO,TU,TH,FR;UNTIL=20260726"
    events = [
        _ev(recurrence=[rule]),
        _ev(recurrence=[rule]),
        _ev(recurrence=[rule]),
        _ev(recurrence=[rule]),
    ]
    deduped, drops = main._dedupe_events_to_create(events)
    assert len(deduped) == 1, "Identical recurring series should collapse to one entry"
    assert drops == 3


def test_dedupe_keeps_distinct_singles():
    events = [
        _ev(date="2026-04-27"),
        _ev(date="2026-04-28"),
        _ev(date="2026-04-30"),
    ]
    deduped, drops = main._dedupe_events_to_create(events)
    assert len(deduped) == 3
    assert drops == 0


def test_dedupe_drops_singles_covered_by_recurring_master():
    rule = "RRULE:FREQ=WEEKLY;BYDAY=MO,TU,TH,FR;UNTIL=20260726"
    events = [
        _ev(recurrence=[rule], date="2026-04-27"),       # Monday master
        _ev(date="2026-04-27"),                          # Mon — covered, drop
        _ev(date="2026-04-28"),                          # Tue — covered, drop
        _ev(date="2026-04-29"),                          # Wed — NOT in BYDAY, keep
    ]
    deduped, drops = main._dedupe_events_to_create(events)
    titles_with_rec = [e for e in deduped if e.recurrence]
    plain_dates = sorted(e.date for e in deduped if not e.recurrence)
    assert len(titles_with_rec) == 1
    assert plain_dates == ["2026-04-29"]
    assert drops == 2


def test_dedupe_does_not_collapse_different_titles():
    rule = "RRULE:FREQ=WEEKLY;BYDAY=MO"
    events = [
        _ev(title="Running Practice", recurrence=[rule]),
        _ev(title="Yoga", recurrence=[rule]),
    ]
    deduped, drops = main._dedupe_events_to_create(events)
    assert len(deduped) == 2
    assert drops == 0


# ---------------------------------------------------------------------------
# _drop_events_already_scheduled
# ---------------------------------------------------------------------------


def test_drops_events_that_match_existing_calendar_session_recurring():
    rule = "RRULE:FREQ=WEEKLY;BYDAY=MO,TU,TH,FR;UNTIL=20260726"
    new_events = [_ev(recurrence=[rule])]
    existing = [
        # User already has Running Practice on a Tuesday at 7am for 60 min
        {"title": "Running Practice", "date": "2026-04-28",
         "startHour": 7, "startMin": 0, "durationMins": 60},
    ]
    keep, drops = main._drop_events_already_scheduled(new_events, existing)
    assert keep == []
    assert drops == 1


def test_keeps_events_when_existing_is_different_time():
    rule = "RRULE:FREQ=WEEKLY;BYDAY=MO,TU,TH,FR;UNTIL=20260726"
    new_events = [_ev(recurrence=[rule])]
    existing = [
        {"title": "Running Practice", "date": "2026-04-28",
         "startHour": 18, "startMin": 0, "durationMins": 60},
    ]
    keep, drops = main._drop_events_already_scheduled(new_events, existing)
    assert len(keep) == 1
    assert drops == 0


def test_drops_single_occurrence_when_existing_matches_date():
    new_events = [_ev(date="2026-04-27")]
    existing = [
        {"title": "Running Practice", "date": "2026-04-27",
         "startHour": 7, "startMin": 0, "durationMins": 60},
    ]
    keep, drops = main._drop_events_already_scheduled(new_events, existing)
    assert keep == []
    assert drops == 1


# ---------------------------------------------------------------------------
# Recurring scheduling SUGGESTIONS (candidate_slots flow with approve/decline)
# ---------------------------------------------------------------------------


def test_normalize_scheduling_candidate_preserves_recurrence():
    raw = {
        "title": "Running Practice",
        "date": "2026-04-27",
        "startHour": 7,
        "startMin": 0,
        "durationMins": 60,
        "recurrence": ["RRULE:FREQ=WEEKLY;BYDAY=MO,TU,TH,FR;UNTIL=20260726"],
        "reasoning": "Mornings keep you consistent",
    }
    bundle = main._normalize_scheduling_candidate(raw)
    assert bundle is not None
    assert bundle.get("recurrence") == [
        "RRULE:FREQ=WEEKLY;BYDAY=MO,TU,TH,FR;UNTIL=20260726"
    ]
    assert main._bundle_is_recurring(bundle) is True
    parts = bundle["parts"]
    assert len(parts) == 1
    assert parts[0]["startHour"] == 7
    assert parts[0]["date"] == "2026-04-27"


def test_normalize_scheduling_candidate_folds_stray_count_into_rrule():
    raw = {
        "title": "Gym",
        "date": "2026-05-04",
        "startHour": 17,
        "startMin": 0,
        "durationMins": 60,
        "recurrence": ["RRULE:FREQ=WEEKLY;BYDAY=MO"],
        "COUNT": 8,
    }
    bundle = main._normalize_scheduling_candidate(raw)
    assert bundle is not None
    rule = bundle["recurrence"][0]
    assert rule.count("COUNT=") == 1
    assert "COUNT=8" in rule


def test_normalize_scheduling_candidate_non_recurring_has_no_recurrence_key():
    raw = {
        "title": "CS Homework",
        "date": "2026-04-27",
        "startHour": 9,
        "startMin": 0,
        "durationMins": 90,
    }
    bundle = main._normalize_scheduling_candidate(raw)
    assert bundle is not None
    assert "recurrence" not in bundle
    assert main._bundle_is_recurring(bundle) is False


def test_format_recurring_summary_builds_human_label():
    bundle = {
        "title": "Running Practice",
        "recurrence": ["RRULE:FREQ=WEEKLY;BYDAY=MO,TU,TH,FR;UNTIL=20260726"],
        "parts": [
            {"date": "2026-04-27", "startHour": 7, "startMin": 0, "durationMins": 60},
        ],
    }
    label = main._format_recurring_summary(bundle)
    # Expect Mon/Tue/Thu/Fri at 7:00 AM (60 min, until Jul 26)
    assert "Mon" in label and "Tue" in label and "Thu" in label and "Fri" in label
    assert "7:00 AM" in label
    assert "60 min" in label
    assert "Jul" in label and "26" in label


def test_format_bundle_summary_delegates_for_recurring():
    bundle = {
        "title": "Yoga",
        "recurrence": ["RRULE:FREQ=WEEKLY;BYDAY=WE;COUNT=10"],
        "parts": [
            {"date": "2026-04-29", "startHour": 18, "startMin": 30, "durationMins": 60},
        ],
    }
    label = main._format_bundle_summary(bundle)
    assert "Wed" in label
    assert "6:30 PM" in label
    assert "10 times" in label


def test_bundle_clashes_with_existing_series_detects_byday_overlap():
    bundle = {
        "title": "Running Practice",
        "recurrence": ["RRULE:FREQ=WEEKLY;BYDAY=MO,TU,TH,FR;UNTIL=20260726"],
        "parts": [
            {"date": "2026-04-27", "startHour": 7, "startMin": 0, "durationMins": 60},
        ],
    }
    existing = [
        {"title": "Running Practice", "date": "2026-04-30",  # Thursday
         "startHour": 7, "startMin": 0, "durationMins": 60},
    ]
    assert main._bundle_clashes_with_existing_series(bundle, existing) is True


def test_bundle_clashes_with_existing_series_ignores_different_time():
    bundle = {
        "title": "Running Practice",
        "recurrence": ["RRULE:FREQ=WEEKLY;BYDAY=MO,TU,TH,FR;UNTIL=20260726"],
        "parts": [
            {"date": "2026-04-27", "startHour": 7, "startMin": 0, "durationMins": 60},
        ],
    }
    existing = [
        {"title": "Running Practice", "date": "2026-04-30",
         "startHour": 18, "startMin": 0, "durationMins": 60},
    ]
    assert main._bundle_clashes_with_existing_series(bundle, existing) is False


def test_bundle_clashes_with_existing_series_ignores_different_title():
    bundle = {
        "title": "Running Practice",
        "recurrence": ["RRULE:FREQ=WEEKLY;BYDAY=MO"],
        "parts": [
            {"date": "2026-04-27", "startHour": 7, "startMin": 0, "durationMins": 60},
        ],
    }
    existing = [
        {"title": "Yoga", "date": "2026-04-27",
         "startHour": 7, "startMin": 0, "durationMins": 60},
    ]
    assert main._bundle_clashes_with_existing_series(bundle, existing) is False


def test_bundle_clashes_with_existing_series_returns_false_for_non_recurring():
    bundle = {
        "title": "CS Homework",
        "parts": [
            {"date": "2026-04-27", "startHour": 9, "startMin": 0, "durationMins": 90},
        ],
    }
    existing = [
        {"title": "CS Homework", "date": "2026-04-27",
         "startHour": 9, "startMin": 0, "durationMins": 90},
    ]
    # _bundle_clashes_with_existing_series only fires for recurring bundles.
    assert main._bundle_clashes_with_existing_series(bundle, existing) is False


def main_runner() -> None:
    tests = [v for k, v in globals().items() if k.startswith("test_") and callable(v)]
    failures = 0
    for t in tests:
        try:
            t()
            print(f"  ok   {t.__name__}")
        except AssertionError as e:
            failures += 1
            print(f"  FAIL {t.__name__}: {e}")
        except Exception as e:
            failures += 1
            print(f"  ERR  {t.__name__}: {e!r}")
    if failures:
        print(f"\n{failures} test(s) failed.")
        sys.exit(1)
    print(f"\nAll {len(tests)} tests passed.")


if __name__ == "__main__":
    main_runner()
