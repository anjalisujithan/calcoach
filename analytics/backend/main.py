"""
CalCoach Analytics Backend — FastAPI
Persists reflection data to Google Firestore.
"""

from __future__ import annotations

import sys
from pathlib import Path

from dotenv import load_dotenv

# Repo root `.env`
load_dotenv(Path(__file__).resolve().parent.parent.parent / ".env")

# ── RL imports (optional — app degrades gracefully if not installed) ──────────
_CALCOACH_ROOT = str(Path(__file__).resolve().parent.parent.parent.parent)
if _CALCOACH_ROOT not in sys.path:
    sys.path.insert(0, _CALCOACH_ROOT)

try:
    from datetime import time as _time
    from calcoach.RL_exploration.contextual_bandit import LinUCBBandit
    from calcoach.RL_exploration.feature_extractor import extract as _extract, FEATURE_NAMES
    from calcoach.RL_exploration.slot_generator import ScheduleValidator
    from calcoach.models import Block, CandidateSchedule, TaskRequest, DAY_ORDER
    from calcoach.user_profile.profile import UserProfile
    from calcoach.user_profile.preferences import UserPreferences
    from calcoach.LLM_integration.reward_handler import FeedbackType, compute_reward
    _RL_AVAILABLE = True
except Exception as _rl_import_err:
    _RL_AVAILABLE = False
    ScheduleValidator = None  # type: ignore[misc, assignment]
    DAY_ORDER = []  # type: ignore[misc, assignment]
    print(f"[RL] Disabled — import failed: {_rl_import_err}")

if _RL_AVAILABLE:
    _bandit = LinUCBBandit(alpha=1.0)
    _user_profile = UserProfile.new_user(
        user_id="default_user",
        name="CalCoach User",
        preferences=UserPreferences(
            work_start="09:00",
            work_end="21:00",
            avoid_days=[],
            buffer_minutes=10,
            max_daily_work_minutes=360,
        ),
    )
else:
    _bandit = None
    _user_profile = None

from datetime import datetime, timezone
from typing import List, Optional, Tuple

import json
import os

from fastapi import FastAPI, HTTPException
from fastapi.middleware.cors import CORSMiddleware
from groq import AsyncGroq
from pydantic import BaseModel, Field

from firestore_client import get_db

app = FastAPI(title="CalCoach API")

# Stores last ranked scheduling bundles so /feedback can look them up by index.
# Each item is from _normalize_scheduling_candidate: title, description, reasoning, parts[].
_last_candidate_slots: List[dict] = []

app.add_middleware(
    CORSMiddleware,
    allow_origins=["http://localhost:3000"],
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)

COLLECTION = "reflections"
USERS_COLLECTION = "users"


# ── Bandit persistence helpers ────────────────────────────────────────────────

async def _save_bandit_state(email: str) -> None:
    """Persist the in-memory bandit state for this user to Firestore.
    Serialized as a JSON string to avoid Firestore's nested-array limitation."""
    if not _RL_AVAILABLE or _user_profile is None:
        return
    try:
        db = get_db()
        doc_ref = db.collection(USERS_COLLECTION).document(email)
        await doc_ref.set(
            {"bandit_state_json": json.dumps(_user_profile.bandit_state.to_dict())},
            merge=True,
        )
        print(f"[RL] Saved bandit state for {email} (n_updates={_user_profile.bandit_state.n_updates})")
    except Exception as e:
        print(f"[RL] Failed to save bandit state: {e}")


async def _load_bandit_state(email: str) -> None:
    """Load bandit state from Firestore into the in-memory user profile."""
    if not _RL_AVAILABLE or _user_profile is None:
        return
    try:
        db = get_db()
        doc_ref = db.collection(USERS_COLLECTION).document(email)
        doc = await doc_ref.get()
        if doc.exists:
            data = doc.to_dict() or {}
            bs_json = data.get("bandit_state_json")
            if bs_json:
                bs = json.loads(bs_json)
                if bs.get("A") and bs.get("b"):
                    from calcoach.user_profile.bandit_state import BanditState
                    _user_profile.bandit_state = BanditState.from_dict(bs)
                    print(f"[RL] Loaded bandit state for {email} (n_updates={_user_profile.bandit_state.n_updates})")
                    return
        print(f"[RL] No existing bandit state for {email}, starting fresh")
    except Exception as e:
        print(f"[RL] Failed to load bandit state: {e}")


# ── Models ────────────────────────────────────────────────────────────────────

class ReflectionIn(BaseModel):
    sessionId: str
    title: str
    description: str
    date: str
    startTime: str
    endTime: str
    productivity: int
    reflectionText: str
    id: str
    savedAt: str


class ReflectionOut(ReflectionIn):
    serverSavedAt: str


class UserOut(BaseModel):
    id: str
    displayName: str
    email: str
    createdAt: str


# ── Endpoints ─────────────────────────────────────────────────────────────────

@app.get("/reflections", response_model=List[ReflectionOut])
async def list_reflections(session_id: Optional[str] = None):
    db = get_db()
    col = db.collection(COLLECTION)
    if session_id:
        query = col.where("sessionId", "==", session_id)
    else:
        query = col
    docs = [doc.to_dict() async for doc in query.stream()]
    return docs


@app.post("/reflections", response_model=ReflectionOut, status_code=201)
async def create_reflection(body: ReflectionIn):
    if not 1 <= body.productivity <= 5:
        raise HTTPException(400, "productivity must be 1–5")
    record = body.dict()
    record["serverSavedAt"] = datetime.now(timezone.utc).isoformat() + "Z"
    db = get_db()
    await db.collection(COLLECTION).document(record["id"]).set(record)
    return record


@app.delete("/reflections/{reflection_id}")
async def delete_reflection(reflection_id: str):
    db = get_db()
    doc_ref = db.collection(COLLECTION).document(reflection_id)
    doc = await doc_ref.get()
    if not doc.exists:
        raise HTTPException(404, "Reflection not found")
    await doc_ref.delete()
    return {"ok": True}


@app.get("/users", response_model=List[UserOut])
async def list_users():
    db = get_db()
    out: List[UserOut] = []
    async for doc in db.collection(USERS_COLLECTION).stream():
        data = doc.to_dict() or {}
        out.append(UserOut(
            id=doc.id,
            displayName=data.get("displayName", ""),
            email=data.get("email", ""),
            createdAt=data.get("createdAt", ""),
        ))
    return out


class UserRegisterIn(BaseModel):
    email: str
    display_name: str = ""


_current_user_email: str = ""  # tracks the logged-in user's email for bandit persistence


@app.post("/users/register", status_code=201)
async def register_user(body: UserRegisterIn):
    """Create a student document on first signup (idempotent — no-op if already exists)."""
    global _current_user_email
    email = body.email.strip().lower()
    if not email:
        raise HTTPException(400, "email is required")

    _current_user_email = email

    db = get_db()
    doc_ref = db.collection(USERS_COLLECTION).document(email)
    existing = await doc_ref.get()
    if existing.exists:
        # Load persisted bandit state for this returning user
        await _load_bandit_state(email)
        return {"created": False, "data": existing.to_dict()}

    now = datetime.now(timezone.utc).isoformat() + "Z"
    user = {
        "email": email,
        "user_summary": None,
        "created_at": now,
    }
    await doc_ref.set(user)
    return {"created": True, "data": user}


@app.post("/users/seed", response_model=List[UserOut])
async def seed_dummy_users():
    db = get_db()
    now = datetime.now(timezone.utc).isoformat() + "Z"
    rows = [
        ("dummy_alice", "Alice", "alice@example.test"),
        ("dummy_bob", "Bob", "bob@example.test"),
        ("dummy_carol", "Carol", "carol@example.test"),
    ]
    out: List[UserOut] = []
    for doc_id, name, email in rows:
        record = {"displayName": name, "email": email, "createdAt": now, "seed": True}
        await db.collection(USERS_COLLECTION).document(doc_id).set(record)
        out.append(UserOut(id=doc_id, displayName=name, email=email, createdAt=now))
    return out


# ── Chat models ───────────────────────────────────────────────────────────────

class CalendarEvent(BaseModel):
    title: str
    description: str = ""
    date: str
    startHour: int
    startMin: int
    durationMins: int


class RankedSuggestion(BaseModel):
    rank: int           # 1 = best (bandit's top pick)
    slot: CalendarEvent # first block (same as calendar_blocks[0] when multi-block)
    reasoning: str      # short explanation from the LLM
    calendar_blocks: List[CalendarEvent] = Field(
        default_factory=list,
        description="All calendar events for this suggestion; accept adds all. Empty = use slot only.",
    )


class HistoryMessage(BaseModel):
    role: str
    text: str


class ChatMessage(BaseModel):
    message: str
    history: List[HistoryMessage] = []
    sessions: List[dict] = []
    reflections: List[dict] = []


class ChatResponse(BaseModel):
    reply: str
    events_to_create: List[CalendarEvent] = []       # backwards compat (non-scheduling replies)
    pending_suggestions: List[RankedSuggestion] = [] # ranked scheduling suggestions
    updated_history: List[HistoryMessage] = []


HISTORY_THRESHOLD = 8
KEEP_RECENT = 4
TARGET_VIABLE_SUGGESTIONS = 3
SCHEDULING_REPAIR_MAX_ROUNDS = 6


async def _compress_history(
    client: AsyncGroq, history: List[HistoryMessage]
) -> List[HistoryMessage]:
    to_summarize = history[:-KEEP_RECENT]
    recent = history[-KEEP_RECENT:]
    convo_text = "\n".join(f"{m.role.upper()}: {m.text}" for m in to_summarize)
    summary_completion = await client.chat.completions.create(
        model="llama-3.3-70b-versatile",
        messages=[
            {"role": "system", "content": (
                "Summarize the following conversation between a user and CalCoach "
                "(an AI scheduling assistant). Preserve any scheduling preferences, "
                "constraints, decisions, or personal details the user expressed. Be concise."
            )},
            {"role": "user", "content": convo_text},
        ],
    )
    summary_text = summary_completion.choices[0].message.content
    return [HistoryMessage(role="system", text=f"[Earlier conversation summary] {summary_text}")] + recent


def _truncate(text: str, max_chars: int = 80) -> str:
    text = text.strip()
    return text if len(text) <= max_chars else text[:max_chars] + "…"


def _build_system_prompt(sessions: List[dict], reflections: List[dict]) -> str:
    now = datetime.now(timezone.utc)
    today = now.strftime("%A, %B %d, %Y")
    today_str = now.strftime("%Y-%m-%d")

    cal_lines = []
    busy_lines = []
    for s in sorted(sessions, key=lambda x: (x.get("date", ""), x.get("startHour", 0))):
        date = s.get("date", "")
        if date < today_str:
            continue
        h, m = s.get("startHour", 0), s.get("startMin", 0)
        dur = s.get("durationMins", 0)
        end_total = h * 60 + m + dur
        end_h, end_m = end_total // 60, end_total % 60
        cal_lines.append(f"  - {date} {h:02d}:{m:02d} ({dur}min): {s.get('title')}")
        busy_lines.append(f"  BUSY: {date} {h:02d}:{m:02d}–{end_h:02d}:{end_m:02d} [{s.get('title')}]")
    cal_block = "\n".join(cal_lines[:30]) if cal_lines else "  (no upcoming events)"
    busy_block = "\n".join(busy_lines[:30]) if busy_lines else "  (no busy blocks — all time is free)"

    ref_lines = []
    for r in reflections[-5:]:
        note = _truncate(r.get("reflectionText", "") or "", max_chars=120)
        ref_lines.append(
            f"  - {r.get('date')} {r.get('startTime', '')}-{r.get('endTime', '')} "
            f"[{r.get('title')}] productivity={r.get('productivity')}/5"
            + (f": {note}" if note else "")
        )
    ref_block = "\n".join(ref_lines) if ref_lines else "  (no reflections yet)"

    return f"""You are CalCoach, an AI scheduling assistant. Today is {today}.

CURRENT CALENDAR:
{cal_block}

BUSY BLOCKS (do NOT schedule anything that overlaps with these):
{busy_block}

RECENT REFLECTIONS (productivity ratings and notes from past sessions):
{ref_block}

Use the calendar and reflections to give personalized, context-aware scheduling advice.

Always respond with valid JSON in exactly this format:
{{
  "reply": "<brief intro only — do NOT list the slots here, the UI will display them>",
  "candidate_slots": [],
  "events_to_create": []
}}

When the user asks you to SCHEDULE, ADD, or CREATE an event:
- Set "reply" to a brief sentence (e.g. "Here are 3 options for your CS homework:")
- Provide exactly 3 alternative scheduling OPTIONS in "candidate_slots" — different strategies/days for the same task. The server validates against BUSY times: every block must lie entirely inside a FREE window (see follow-up messages if a revision is requested).
- SINGLE continuous block per option: use top-level fields only: title, description, date (yyyy-MM-dd), startHour (0-23), startMin (0 or 30), durationMins, reasoning (1 sentence)
- MULTI-BLOCK one option (e.g. 4 hours as four 1-hour sessions): ONE object with the same title/description/reasoning at the top level, plus a "blocks" array. Each block must have: date, startHour, startMin, durationMins (optional title/description override per block). Do NOT split one option into multiple top-level candidate_slots entries.
- DURATION RULE (hard): for every option, the sum of all blocks' durationMins MUST equal the total time the user asked to schedule. If the user asks for 2 hours, every option must total exactly 120 minutes. This is non-negotiable — never under- or over-schedule.
- Leave "events_to_create" as an empty array

When NOT scheduling (just conversation or advice):
- Leave both "candidate_slots" and "events_to_create" as empty arrays

Do not include any text outside the JSON object."""


# ── RL helpers ────────────────────────────────────────────────────────────────

def _sessions_to_calendar_json(sessions: List[dict]) -> dict:
    """Build weekday-keyed busy slots (used by ScheduleValidator for work-hours/avoid-days checks)."""
    cal: dict = {}
    for s in sessions:
        try:
            weekday = datetime.strptime(s.get("date", ""), "%Y-%m-%d").strftime("%A")
            h, m = s.get("startHour", 0), s.get("startMin", 0)
            dur = s.get("durationMins", 0)
            end_total = h * 60 + m + dur
            slot_str = f"{h:02d}{m:02d}-{end_total // 60:02d}{end_total % 60:02d}"
            cal.setdefault(weekday, []).append(slot_str)
        except Exception:
            continue
    return cal


def _sessions_to_date_busy(sessions: List[dict]) -> dict:
    """Build date-keyed busy intervals (minutes since midnight) for exact clash detection."""
    busy: dict = {}  # "YYYY-MM-DD" -> List[(start_min, end_min)]
    for s in sessions:
        try:
            date = s.get("date", "")
            if not date:
                continue
            h, m = int(s.get("startHour", 0)), int(s.get("startMin", 0))
            dur = int(s.get("durationMins", 0))
            start_min = h * 60 + m
            end_min = start_min + dur
            busy.setdefault(date, []).append((start_min, end_min))
        except Exception:
            continue
    return busy


def _bundle_clashes_with_sessions(bundle: dict, date_busy: dict) -> Tuple[bool, str]:
    """
    Check every block in a bundle against exact existing-event times on that specific date.
    Returns (True, reason) if any block overlaps an existing event, (False, "") if clean.
    """
    parts = bundle.get("parts") or []
    for p in parts:
        date = p.get("date", "")
        h = int(p.get("startHour", 0))
        m = int(p.get("startMin", 0))
        dur = int(p.get("durationMins", 0))
        start_min = h * 60 + m
        end_min = start_min + dur
        for (busy_start, busy_end) in date_busy.get(date, []):
            # Overlap: not (end <= busy_start or start >= busy_end)
            if not (end_min <= busy_start or start_min >= busy_end):
                return True, (
                    f"Block on {date} {h:02d}:{m:02d}+{dur}min overlaps existing event "
                    f"{busy_start // 60:02d}:{busy_start % 60:02d}-{busy_end // 60:02d}:{busy_end % 60:02d}"
                )
    return False, ""


def _prefs_for_validation() -> UserPreferences:
    if _RL_AVAILABLE and _user_profile is not None:
        return _user_profile.preferences
    return UserPreferences(
        work_start="09:00",
        work_end="21:00",
        avoid_days=[],
        buffer_minutes=10,
        max_daily_work_minutes=600,
    )


def _task_from_bundle_for_validation(bundle: dict, cand: CandidateSchedule) -> TaskRequest:
    """TaskRequest aligned with this bundle so total-duration and deadline checks match."""
    parts = bundle.get("parts") or []
    dates: List[datetime] = []
    for p in parts:
        try:
            dates.append(datetime.strptime(p.get("date", ""), "%Y-%m-%d"))
        except Exception:
            continue
    latest = max(dates) if dates else datetime.now(timezone.utc)
    deadline_day = latest.strftime("%A")
    total_min = cand.total_minutes
    max_chunk = max((b.duration_minutes for b in cand.blocks), default=60)
    return TaskRequest(
        task_name=bundle.get("title", "Task"),
        total_duration_minutes=total_min,
        task_type="other",
        deadline_day=deadline_day,
        preferred_chunk_minutes=max_chunk,
        min_chunk_minutes=20,
        max_chunk_minutes=max(max_chunk, 120),
    )


def _bundle_fingerprint(bundle: dict) -> tuple:
    parts = bundle.get("parts") or []
    return tuple(
        sorted(
            (
                str(p.get("date", "")),
                int(p.get("startHour", 0)),
                int(p.get("startMin", 0)),
                int(p.get("durationMins", 0)),
            )
            for p in parts
        )
    )


def _bundle_total_minutes(bundle: dict) -> int:
    parts = bundle.get("parts") or []
    return sum(int(p.get("durationMins", 0)) for p in parts)


def _target_duration_from_bundles(bundles: List[dict]) -> Optional[int]:
    """
    Find the most common total duration (mode) across the initial bundles.
    This is the 'requested' total — all validated bundles must match it.
    """
    from collections import Counter
    totals = [_bundle_total_minutes(b) for b in bundles if _bundle_total_minutes(b) > 0]
    if not totals:
        return None
    return Counter(totals).most_common(1)[0][0]


def _format_free_windows_text(prefs: UserPreferences, sessions: List[dict]) -> str:
    if not _RL_AVAILABLE or ScheduleValidator is None:
        return "(Scheduler unavailable — cannot list free windows.)"
    cal = _sessions_to_calendar_json(sessions)
    validator = ScheduleValidator(prefs)
    free_by_day = validator.get_all_free_windows(cal)
    lines: List[str] = []
    for day in DAY_ORDER:
        windows = free_by_day.get(day, [])
        if not windows:
            lines.append(f"{day}: (no free window within work hours — avoid day or fully busy)")
        else:
            fmts = [
                f"{ws.strftime('%H:%M')}-{we.strftime('%H:%M')}"
                for ws, we in windows
            ]
            lines.append(f"{day}: " + ", ".join(fmts))
    return "\n".join(lines)


def _validate_scheduling_bundle(
    bundle: dict,
    sessions: List[dict],
    prefs: UserPreferences,
    target_minutes: Optional[int] = None,
) -> Tuple[bool, str, List[Tuple[int, str]]]:
    """
    Returns (ok, overall_reason, bad_block_indices).
    bad_block_indices: (part_index, validate_block reason) for blocks that fail free-window / deadline / avoid-day.
    """
    if not _RL_AVAILABLE or ScheduleValidator is None:
        return True, "", []
    cand = _bundle_to_candidate(bundle)
    if cand is None:
        return False, "unparseable bundle", []

    # Hard check 1: exact date-based clash with existing calendar events
    date_busy = _sessions_to_date_busy(sessions)
    clashes, clash_reason = _bundle_clashes_with_sessions(bundle, date_busy)
    if clashes:
        return False, clash_reason, []

    # Hard check 2: total duration must match what the user requested
    if target_minutes is not None:
        actual_minutes = _bundle_total_minutes(bundle)
        if abs(actual_minutes - target_minutes) > 5:
            return False, (
                f"Duration mismatch: blocks total {actual_minutes}min but {target_minutes}min is required. "
                "Adjust block durationMins so they sum to the requested total."
            ), []

    # Hard check 3: work hours / avoid days via ScheduleValidator.
    # Pass an EMPTY calendar so the weekday-keyed slot list doesn't wrongly block every
    # instance of a weekday that has ANY existing event.  Exact date-level clashes are
    # already handled by check 1 above.
    validator = ScheduleValidator(prefs)
    free_windows = validator.get_all_free_windows({})
    task = _task_from_bundle_for_validation(bundle, cand)
    ok, reason = validator.validate_candidate(cand, free_windows, task)
    if ok:
        return True, "", []
    bad_parts: List[Tuple[int, str]] = []
    for i, block in enumerate(cand.blocks):
        ok_b, br = validator.validate_block(block, free_windows, task.deadline_day)
        if not ok_b:
            bad_parts.append((i, br))
    return False, reason, bad_parts


def _diagnose_bundles_for_prompt(
    bundles: List[dict],
    sessions: List[dict],
    prefs: UserPreferences,
    target_minutes: Optional[int] = None,
) -> str:
    lines: List[str] = []
    for i, bundle in enumerate(bundles):
        ok, reason, bad = _validate_scheduling_bundle(bundle, sessions, prefs, target_minutes=target_minutes)
        if ok:
            lines.append(f"OPTION {i + 1}: VALID ✓")
            continue
        lines.append(f"OPTION {i + 1}: INVALID — {reason}")
        if bad:
            for pi, br in bad:
                parts = bundle.get("parts") or []
                p = parts[pi] if pi < len(parts) else {}
                lines.append(
                    f"    → Fix ONLY block index {pi}: date={p.get('date')} "
                    f"{int(p.get('startHour', 0)):02d}:{int(p.get('startMin', 0)):02d} "
                    f"durationMins={p.get('durationMins')} — {br}"
                )
        else:
            lines.append(
                "    → No single block was flagged; the issue is overlap between blocks in this option, "
                "daily work cap, or total duration vs. requested work. Rework the whole option."
            )
    return "\n".join(lines)


def _normalize_scheduling_candidate(raw: dict) -> Optional[dict]:
    """
    Normalize one LLM candidate into {title, description, reasoning, parts}.
    Each part is a dict suitable for CalendarEvent (title, description, date, startHour, startMin, durationMins).
    """
    if not isinstance(raw, dict):
        return None
    title = raw.get("title") or "Task"
    description = raw.get("description") or ""
    reasoning = raw.get("reasoning") or ""
    parts: List[dict] = []
    blocks = raw.get("blocks")
    if isinstance(blocks, list) and len(blocks) > 0:
        for b in blocks:
            if not isinstance(b, dict):
                continue
            d = b.get("date")
            if not d:
                continue
            parts.append({
                "title": b.get("title") or title,
                "description": b.get("description") or description,
                "date": d,
                "startHour": int(b.get("startHour", 0)),
                "startMin": int(b.get("startMin", 0)),
                "durationMins": int(b.get("durationMins", 60)),
            })
    else:
        d = raw.get("date")
        if not d:
            return None
        parts.append({
            "title": title,
            "description": description,
            "date": d,
            "startHour": int(raw.get("startHour", 0)),
            "startMin": int(raw.get("startMin", 0)),
            "durationMins": int(raw.get("durationMins", 60)),
        })
    if not parts:
        return None
    return {"title": title, "description": description, "reasoning": reasoning, "parts": parts}


def _bundle_to_candidate(bundle: dict) -> Optional[CandidateSchedule]:
    """Build a CandidateSchedule (possibly multiple Blocks) from a normalized bundle."""
    parts = bundle.get("parts") or []
    if not parts:
        return None
    rl_blocks: List[Block] = []
    total = 0
    try:
        for p in parts:
            weekday = datetime.strptime(p.get("date", ""), "%Y-%m-%d").strftime("%A")
            h, m = int(p.get("startHour", 0)), int(p.get("startMin", 0))
            dur = int(p.get("durationMins", 60))
            total += dur
            end_total = h * 60 + m + dur
            rl_blocks.append(
                Block(
                    day=weekday,
                    start=_time(h, m),
                    end=_time(min(end_total // 60, 23), end_total % 60),
                    duration_minutes=dur,
                )
            )
        strategy = f"multi_{len(rl_blocks)}b" if len(rl_blocks) > 1 else f"{rl_blocks[0].day.lower()}_{rl_blocks[0].start.hour:02d}{rl_blocks[0].start.minute:02d}"
        return CandidateSchedule(blocks=rl_blocks, total_minutes=total, strategy=strategy)
    except Exception:
        return None


def _candidate_sort_key(c: CandidateSchedule) -> tuple:
    """Stable identity for mapping ranked candidates back to bundles."""
    return tuple(sorted((b.day, b.start.hour, b.start.minute, b.duration_minutes) for b in c.blocks))


def _rank_slots(bundles: List[dict], sessions: List[dict]) -> List[dict]:
    """Rank scheduling bundles via LinUCB. Returns bundles in ranked order. Falls back on error."""
    if not _RL_AVAILABLE or len(bundles) < 2:
        return bundles
    try:
        calendar_json = _sessions_to_calendar_json(sessions)
        candidates = [_bundle_to_candidate(b) for b in bundles]
        valid_pairs = [(c, b) for c, b in zip(candidates, bundles) if c is not None]
        if len(valid_pairs) < 2:
            return bundles

        valid_candidates = [p[0] for p in valid_pairs]
        valid_bundles = [p[1] for p in valid_pairs]

        total_dur = 60
        max_chunk = 60
        for bb in valid_bundles:
            pp = bb.get("parts") or []
            if pp:
                total_dur = max(total_dur, sum(int(x.get("durationMins", 60)) for x in pp))
                max_chunk = max(max_chunk, max(int(x.get("durationMins", 60)) for x in pp))

        first_parts = valid_bundles[0].get("parts") or []
        first_date = first_parts[0].get("date", "") if first_parts else ""
        try:
            deadline_day = datetime.strptime(first_date, "%Y-%m-%d").strftime("%A")
        except Exception:
            deadline_day = "Sunday"

        task = TaskRequest(
            task_name=valid_bundles[0].get("title", "Task"),
            total_duration_minutes=total_dur,
            task_type="other",
            deadline_day=deadline_day,
            preferred_chunk_minutes=max_chunk,
            min_chunk_minutes=20,
            max_chunk_minutes=max(max_chunk, 120),
        )

        ranked_candidates = _bandit.rank(valid_candidates, _user_profile, task, calendar_json)

        bundle_map: dict[tuple, dict] = {}
        for b in valid_bundles:
            c_b = _bundle_to_candidate(b)
            if c_b is not None:
                bundle_map[_candidate_sort_key(c_b)] = b

        ranked: List[dict] = []
        for c in ranked_candidates:
            k = _candidate_sort_key(c)
            if k in bundle_map:
                ranked.append(bundle_map[k])
        if ranked:
            top_parts = ranked[0].get("parts") or []
            top = top_parts[0] if top_parts else {}
            print(
                f"[RL] Ranked {len(ranked)} options. Top first block: "
                f"{top.get('date')} {int(top.get('startHour', 0)):02d}:{int(top.get('startMin', 0)):02d}"
            )
        return ranked if ranked else bundles
    except Exception as e:
        print(f"[RL] Ranking failed, using original order: {e}")
        return bundles


def _format_slot_label(slot: dict) -> str:
    try:
        dt = datetime.strptime(slot["date"], "%Y-%m-%d")
        h, m = slot["startHour"], slot["startMin"]
        ampm = "AM" if h < 12 else "PM"
        h12 = h % 12 or 12
        return f"{dt.strftime('%A, %b %d')} at {h12}:{m:02d} {ampm} ({slot['durationMins']} min)"
    except Exception:
        return f"{slot.get('date')} {slot.get('startHour'):02d}:{slot.get('startMin'):02d}"


def _format_bundle_summary(bundle: dict) -> str:
    parts = bundle.get("parts") or []
    if len(parts) <= 1:
        return _format_slot_label(parts[0]) if parts else ""
    bits = [_format_slot_label(p) for p in parts]
    total_m = sum(int(p.get("durationMins", 0)) for p in parts)
    return f"{len(parts)} blocks, {total_m} min total — " + "; ".join(bits)


async def _repair_scheduling_until_viable(
    client: AsyncGroq,
    messages_base: list,
    sessions: List[dict],
    initial_bundles: List[dict],
    initial_raw: str,
    initial_parsed: dict,
) -> Tuple[List[dict], str, str]:
    """
    Re-prompt the model until we have TARGET_VIABLE_SUGGESTIONS clash-free options
    (ScheduleValidator vs. sessions busy + work hours), or max rounds.

    Returns (viable_bundles, reply_text, last_model_raw).
    """
    prefs = _prefs_for_validation()
    viable_acc: List[dict] = []
    seen: set = set()

    # Determine the target total duration from the initial suggestions (mode across all 3).
    # Every validated bundle must sum to this total ± 5 min.
    target_minutes = _target_duration_from_bundles(initial_bundles)
    if target_minutes:
        print(f"[schedule] target_minutes={target_minutes}")

    def _absorb(bundles: List[dict]) -> None:
        for b in bundles:
            ok, _, _ = _validate_scheduling_bundle(b, sessions, prefs, target_minutes=target_minutes)
            if not ok:
                continue
            fp = _bundle_fingerprint(b)
            if fp in seen:
                continue
            seen.add(fp)
            viable_acc.append(b)

    _absorb(initial_bundles)
    reply_acc: str = str(initial_parsed.get("reply", "") or initial_raw)
    current_raw: str = initial_raw
    current_parsed: dict = initial_parsed
    bundles_in: List[dict] = list(initial_bundles)

    duration_rule = (
        f"DURATION RULE (hard): every option's blocks must sum to exactly {target_minutes} minutes "
        "(±5 min tolerance). If an option's blocks don't add up, adjust durationMins — do NOT change the "
        "total requested time.\n\n"
    ) if target_minutes else ""

    repair_round = 0
    while len(viable_acc) < TARGET_VIABLE_SUGGESTIONS and repair_round < SCHEDULING_REPAIR_MAX_ROUNDS:
        repair_round += 1
        free_txt = _format_free_windows_text(prefs, sessions)
        diag = _diagnose_bundles_for_prompt(bundles_in, sessions, prefs, target_minutes=target_minutes)
        valid_json = ""
        if viable_acc:
            valid_json = (
                "OPTIONS THAT ARE ALREADY VALID — include each below EXACTLY as a full candidate_slots "
                "element (same title, description, reasoning, and blocks/parts), in this order, at the "
                "START of your candidate_slots array. Then add NEW valid options until the array has "
                f"exactly {TARGET_VIABLE_SUGGESTIONS} items in total:\n"
                + json.dumps(viable_acc, indent=2)
                + "\n\n"
            )
        repair_content = (
            "Automated calendar check: some proposed times clash with existing events, fall outside "
            "free work windows, or break other hard rules (overlap within the same option, daily cap, "
            "or incorrect total duration).\n\n"
            f"{duration_rule}"
            f"{valid_json}"
            "DIAGNOSIS of your LAST response (fix invalid options; keep valid ones verbatim if listed above):\n"
            f"{diag}\n\n"
            "FREE WINDOWS (each scheduled block must fit entirely inside ONE interval for that weekday):\n"
            f"{free_txt}\n\n"
            f"Allowed work hours: {prefs.work_start}–{prefs.work_end}. avoid_days: {list(prefs.avoid_days)}. "
            f"Buffer (minutes) around busy events: {prefs.buffer_minutes}.\n\n"
            "Return JSON in the SAME schema (reply + candidate_slots + events_to_create). "
            f"candidate_slots must contain exactly {TARGET_VIABLE_SUGGESTIONS} items; each must be fully valid. "
            "For multi-block options, change only failing blocks' date/startHour/startMin/durationMins when "
            "possible; leave other blocks unchanged."
        )
        messages2 = messages_base + [
            {"role": "assistant", "content": current_raw},
            {"role": "user", "content": repair_content},
        ]
        comp = await client.chat.completions.create(
            model="llama-3.3-70b-versatile",
            messages=messages2,
            response_format={"type": "json_object"},
        )
        current_raw = comp.choices[0].message.content
        try:
            current_parsed = json.loads(current_raw)
        except json.JSONDecodeError:
            print("[schedule] repair round returned non-JSON; stopping repair loop")
            break
        reply_acc = str(current_parsed.get("reply", reply_acc))
        raw_slots = current_parsed.get("candidate_slots", [])
        next_bundles: List[dict] = []
        if isinstance(raw_slots, list):
            for x in raw_slots:
                if isinstance(x, dict):
                    nb = _normalize_scheduling_candidate(x)
                    if nb:
                        next_bundles.append(nb)
        bundles_in = next_bundles
        _absorb(bundles_in)
        if not bundles_in:
            print("[schedule] repair returned no candidate_slots; stopping")
            break

    if repair_round > 0:
        print(f"[schedule] repair_rounds={repair_round} viable={len(viable_acc)}")
    return viable_acc, reply_acc, current_raw


# ── Chat endpoint ─────────────────────────────────────────────────────────────

@app.post("/chat", response_model=ChatResponse)
async def chat(body: ChatMessage):
    api_key = os.getenv("GROQ_API_KEY")
    if not api_key:
        raise HTTPException(500, "GROQ_API_KEY not set")

    client = AsyncGroq(api_key=api_key)

    history = list(body.history)
    if len(history) > HISTORY_THRESHOLD:
        history = await _compress_history(client, history)

    system_prompt = _build_system_prompt(body.sessions, body.reflections)
    messages = [{"role": "system", "content": system_prompt}]
    for h in history:
        messages.append({"role": h.role if h.role != "system" else "user", "content": h.text})
    messages.append({"role": "user", "content": body.message})

    completion = await client.chat.completions.create(
        model="llama-3.3-70b-versatile",
        messages=messages,
        response_format={"type": "json_object"},
    )

    raw = completion.choices[0].message.content
    reply = raw
    events: List[CalendarEvent] = []
    pending_suggestions: List[RankedSuggestion] = []

    try:
        parsed = json.loads(raw)
        reply = parsed.get("reply", raw)
        candidate_slots_raw = parsed.get("candidate_slots", [])
        events_raw = parsed.get("events_to_create", [])

        if candidate_slots_raw and isinstance(candidate_slots_raw, list):
            bundles_in: List[dict] = []
            for x in candidate_slots_raw:
                if isinstance(x, dict):
                    nb = _normalize_scheduling_candidate(x)
                    if nb:
                        bundles_in.append(nb)

            ranked_bundles: List[dict] = []
            if bundles_in and _RL_AVAILABLE and ScheduleValidator is not None:
                try:
                    viable, reply, _ = await _repair_scheduling_until_viable(
                        client, messages, body.sessions, bundles_in, raw, parsed
                    )
                    ranked_bundles = _rank_slots(viable, body.sessions)
                    ranked_bundles = ranked_bundles[:TARGET_VIABLE_SUGGESTIONS]
                    if len(ranked_bundles) < TARGET_VIABLE_SUGGESTIONS:
                        reply = (
                            f"{reply}\n\n_Note: Only {len(ranked_bundles)} clash-free option(s) fit your "
                            "calendar (free time + work rules) after validation._"
                        )
                except Exception as repair_err:
                    import traceback
                    print(f"[chat] repair/validation error, falling back to direct ranking: {repair_err}")
                    traceback.print_exc()
                    ranked_bundles = _rank_slots(bundles_in, body.sessions)
                    ranked_bundles = ranked_bundles[:TARGET_VIABLE_SUGGESTIONS]
            else:
                ranked_bundles = _rank_slots(bundles_in, body.sessions) if bundles_in else []
                ranked_bundles = ranked_bundles[:TARGET_VIABLE_SUGGESTIONS]

            # Final clash filter — runs regardless of which code path produced ranked_bundles
            # (repair loop, fallback, or RL-disabled).  Ensures no overlapping slot ever
            # reaches the frontend.
            _date_busy = _sessions_to_date_busy(body.sessions)
            pre_filter_count = len(ranked_bundles)
            ranked_bundles = [
                b for b in ranked_bundles
                if not _bundle_clashes_with_sessions(b, _date_busy)[0]
            ]
            if len(ranked_bundles) < pre_filter_count:
                print(f"[chat] Final clash filter removed {pre_filter_count - len(ranked_bundles)} clashing bundle(s)")

            global _last_candidate_slots
            _last_candidate_slots = ranked_bundles

            reply_lines = [reply, ""]
            for i, bundle in enumerate(ranked_bundles):
                reasoning = bundle.get("reasoning", "")
                parts = bundle.get("parts") or []
                cal_events: List[CalendarEvent] = []
                for p in parts:
                    try:
                        cal_events.append(
                            CalendarEvent(
                                title=p.get("title", ""),
                                description=p.get("description", ""),
                                date=p["date"],
                                startHour=int(p.get("startHour", 0)),
                                startMin=int(p.get("startMin", 0)),
                                durationMins=int(p.get("durationMins", 60)),
                            )
                        )
                    except Exception:
                        continue
                if not cal_events:
                    continue
                pending_suggestions.append(
                    RankedSuggestion(
                        rank=i + 1,
                        slot=cal_events[0],
                        reasoning=reasoning,
                        calendar_blocks=cal_events,
                    )
                )
                label = _format_bundle_summary(bundle)
                reply_lines.append(f"**#{i + 1} — {label}**")
                if reasoning:
                    reply_lines.append(reasoning)
                reply_lines.append("")

            if pending_suggestions:
                reply_lines.append(
                    "Options are shown on your calendar. Use ✓ on the highlighted suggestion to add all its blocks, or ✗ to dismiss."
                )
                reply = "\n".join(reply_lines)
        else:
            # No scheduling — use events_to_create directly (backwards compat)
            events = [CalendarEvent(**e) for e in events_raw if isinstance(e, dict)]

    except Exception as e:
        import traceback
        print(f"[chat] JSON parse error: {e}")
        traceback.print_exc()
        reply = raw

    updated_history = history + [
        HistoryMessage(role="user", text=body.message),
        HistoryMessage(role="assistant", text=reply),
    ]

    return ChatResponse(
        reply=reply,
        events_to_create=events,
        pending_suggestions=pending_suggestions,
        updated_history=updated_history,
    )


# ── Feedback endpoint ─────────────────────────────────────────────────────────


class FeedbackIn(BaseModel):
    slot_index: int   # 0-based index into _last_candidate_slots (rank - 1)
    feedback: str     # 'accepted' | 'rejected'


@app.post("/feedback")
async def feedback(body: FeedbackIn):
    """Update the RL bandit when user accepts or rejects a suggested slot."""
    if not _RL_AVAILABLE:
        return {"ok": True, "rl_active": False}
    try:
        if body.slot_index < 0 or body.slot_index >= len(_last_candidate_slots):
            return {"ok": False, "message": f"slot_index {body.slot_index} out of range"}

        bundle = _last_candidate_slots[body.slot_index]
        candidate = _bundle_to_candidate(bundle)
        if candidate is None:
            return {"ok": False, "message": "Could not parse scheduling bundle"}

        parts = bundle.get("parts") or []
        first_date = parts[0].get("date", "") if parts else ""
        try:
            deadline_day = datetime.strptime(first_date, "%Y-%m-%d").strftime("%A")
        except Exception:
            deadline_day = "Sunday"

        dur = sum(int(p.get("durationMins", 60)) for p in parts) if parts else 60
        max_chunk = max((int(p.get("durationMins", 60)) for p in parts), default=dur)
        task = TaskRequest(
            task_name="feedback_task",
            total_duration_minutes=dur,
            task_type="other",
            deadline_day=deadline_day,
            preferred_chunk_minutes=max_chunk,
            min_chunk_minutes=20,
            max_chunk_minutes=max(max_chunk, 120),
        )
        context = _extract(candidate, _user_profile, task, {})
        feedback_type = FeedbackType.ACCEPTED if body.feedback == "accepted" else FeedbackType.REJECTED
        reward = compute_reward(feedback_type)
        _bandit.update(context, reward, _user_profile)
        if _current_user_email:
            await _save_bandit_state(_current_user_email)
        return {"ok": True, "rl_active": True, "n_updates": _user_profile.bandit_state.n_updates}
    except Exception as e:
        return {"ok": False, "message": str(e)}


# ── Onboarding endpoint ────────────────────────────────────────────────────────

class OnboardingIn(BaseModel):
    userType: str = ""
    helpWith: List[str] = []
    workDays: List[str] = []
    workStartHour: int = 9
    workEndHour: int = 21
    workStyle: str = ""
    planningHorizon: str = ""
    chunkSize: str = ""


@app.post("/onboarding")
async def onboarding(body: OnboardingIn):
    """
    Apply survey answers to the user profile so the bandit starts with
    meaningful priors instead of a cold start.
    """
    global _user_profile
    if not _RL_AVAILABLE or _user_profile is None:
        return {"ok": True, "rl_active": False}

    try:
        # Map survey work hours to user preferences
        work_start = f"{body.workStartHour:02d}:00"
        work_end = f"{body.workEndHour:02d}:00"
        avoid_days: List[str] = []
        if "weekdays" in body.workDays and "weekends" not in body.workDays:
            avoid_days = ["Saturday", "Sunday"]
        elif "weekends" in body.workDays and "weekdays" not in body.workDays:
            avoid_days = ["Monday", "Tuesday", "Wednesday", "Thursday", "Friday"]

        # Map chunk size to preferred duration
        chunk_map = {
            "15_30": (15, 30),
            "30_60": (30, 60),
            "60_90": (60, 90),
            "90_plus": (90, 180),
        }
        pref_chunk, max_chunk = chunk_map.get(body.chunkSize, (45, 90))

        # Rebuild user preferences from survey answers
        _user_profile.preferences.work_start = work_start
        _user_profile.preferences.work_end = work_end
        _user_profile.preferences.avoid_days = avoid_days
        _user_profile.preferences.preferred_chunk_minutes = pref_chunk
        _user_profile.preferences.max_daily_work_minutes = (body.workEndHour - body.workStartHour) * 60

        # Seed bandit with a few synthetic updates to nudge priors
        # Morning preference: if user chose early start, reward morning slots
        from datetime import time as _time_cls
        if body.workStartHour <= 10:
            for h in [9, 10]:
                fake_block = Block(day="Monday", start=_time_cls(h, 0), end=_time_cls(h + 1, 0), duration_minutes=60)
                fake_cand = CandidateSchedule(blocks=[fake_block], total_minutes=60, strategy=f"morning_{h}")
                fake_task = TaskRequest(task_name="seed", total_duration_minutes=60, task_type="other",
                                        deadline_day="Sunday", preferred_chunk_minutes=pref_chunk,
                                        min_chunk_minutes=15, max_chunk_minutes=max_chunk)
                ctx = _extract(fake_cand, _user_profile, fake_task, {})
                _bandit.update(ctx, 0.4, _user_profile)   # mild positive
        elif body.workStartHour >= 14:
            for h in [14, 16]:
                fake_block = Block(day="Monday", start=_time_cls(h, 0), end=_time_cls(h + 1, 0), duration_minutes=60)
                fake_cand = CandidateSchedule(blocks=[fake_block], total_minutes=60, strategy=f"afternoon_{h}")
                fake_task = TaskRequest(task_name="seed", total_duration_minutes=60, task_type="other",
                                        deadline_day="Sunday", preferred_chunk_minutes=pref_chunk,
                                        min_chunk_minutes=15, max_chunk_minutes=max_chunk)
                ctx = _extract(fake_cand, _user_profile, fake_task, {})
                _bandit.update(ctx, 0.4, _user_profile)

        print(f"[Onboarding] Applied survey: work={work_start}-{work_end}, avoid={avoid_days}, chunk={pref_chunk}min")
        if _current_user_email:
            await _save_bandit_state(_current_user_email)
        return {"ok": True, "rl_active": True}
    except Exception as e:
        print(f"[Onboarding] Error: {e}")
        return {"ok": False, "message": str(e)}


# ── RL status endpoint (for testing/debugging) ────────────────────────────────

@app.get("/rl-status")
async def rl_status():
    """
    Returns the bandit's current learned weights.
    Use this to verify the RL is learning from feedback.
    After accepting morning slots, morning_* weights should go positive.
    After rejecting evening slots, evening_* weights should go negative.
    """
    if not _RL_AVAILABLE or _user_profile is None:
        return {"rl_active": False}
    weights = _bandit.learned_weights(_user_profile)
    return {
        "rl_active": True,
        "n_updates": _user_profile.bandit_state.n_updates,
        "learned_weights": weights,
        "interpretation": {
            k: ("prefers" if v > 0.05 else "avoids" if v < -0.05 else "neutral")
            for k, v in weights.items()
        }
    }
