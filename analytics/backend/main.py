"""
CalCoach Analytics Backend — FastAPI
Persists reflection data to Google Firestore.
"""

from __future__ import annotations

from pathlib import Path

from dotenv import load_dotenv

# Repo root `.env` (e.g. FIREBASE_SERVICE_ACCOUNT_PATH) — works when cwd is analytics/backend
load_dotenv(Path(__file__).resolve().parent.parent.parent / ".env")

from datetime import datetime, timezone
from typing import List, Optional

import json
import os

from fastapi import FastAPI, HTTPException
from fastapi.middleware.cors import CORSMiddleware
from groq import AsyncGroq
from pydantic import BaseModel

from firestore_client import get_db

app = FastAPI(title="CalCoach API")

app.add_middleware(
    CORSMiddleware,
    allow_origins=["http://localhost:3000"],
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)

COLLECTION = "reflections"
USERS_COLLECTION = "users"


# ── Models ────────────────────────────────────────────────────────────────────

class ReflectionIn(BaseModel):
    """
    Full reflection record sent from the frontend.
    """
    # Session identity
    sessionId: str
    title: str
    description: str          # empty string if user left it blank
    # Time info
    date: str                 # "yyyy-MM-dd"
    startTime: str            # "HH:mm"
    endTime: str              # "HH:mm"
    # Reflection data
    productivity: int         # 1 (least) – 5 (most)
    reflectionText: str
    # Client-generated fields
    id: str
    savedAt: str              # ISO timestamp from client


class ReflectionOut(ReflectionIn):
    serverSavedAt: str        # server-side timestamp for audit


class UserOut(BaseModel):
    id: str
    displayName: str
    email: str
    createdAt: str


# ── Endpoints ─────────────────────────────────────────────────────────────────

@app.get("/reflections", response_model=List[ReflectionOut])
async def list_reflections(session_id: Optional[str] = None):
    """Return all reflections, optionally filtered by sessionId."""
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
    """Save a reflection entry to Firestore."""
    if not 1 <= body.productivity <= 5:
        raise HTTPException(400, "productivity must be 1–5")

    record = body.dict()
    record["serverSavedAt"] = datetime.now(timezone.utc).isoformat() + "Z"

    db = get_db()
    # Use the client-supplied id as the Firestore document ID for idempotency
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


# ── Users (dummy data for Firestore testing) ──────────────────────────────────

@app.get("/users", response_model=List[UserOut])
async def list_users():
    db = get_db()
    out: List[UserOut] = []
    async for doc in db.collection(USERS_COLLECTION).stream():
        data = doc.to_dict() or {}
        out.append(
            UserOut(
                id=doc.id,
                displayName=data.get("displayName", ""),
                email=data.get("email", ""),
                createdAt=data.get("createdAt", ""),
            )
        )
    return out


class UserRegisterIn(BaseModel):
    email: str
    display_name: str = ""


@app.post("/users/register", status_code=201)
async def register_user(body: UserRegisterIn):
    """Create a student document on first signup (idempotent — no-op if already exists)."""
    email = body.email.strip().lower()
    if not email:
        raise HTTPException(400, "email is required")

    db = get_db()
    doc_ref = db.collection(USERS_COLLECTION).document(email)
    existing = await doc_ref.get()
    if existing.exists:
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
    """Write a few fixed documents to the `users` collection (safe to call repeatedly)."""
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


# ── Chat stub (wire up LLM here) ──────────────────────────────────────────────

class CalendarEvent(BaseModel):
    title: str
    description: str = ""
    date: str          # "yyyy-MM-dd"
    startHour: int
    startMin: int
    durationMins: int

class HistoryMessage(BaseModel):
    role: str          # "user" | "assistant"
    text: str

class ChatMessage(BaseModel):
    message: str
    history: List[HistoryMessage] = []
    sessions: List[dict] = []
    reflections: List[dict] = []


class ChatResponse(BaseModel):
    reply: str
    events_to_create: List[CalendarEvent] = []
    updated_history: List[HistoryMessage] = []


HISTORY_THRESHOLD = 8
KEEP_RECENT = 4


async def _compress_history(
    client: AsyncGroq, history: List[HistoryMessage]
) -> List[HistoryMessage]:
    """Summarize the oldest messages, keeping the KEEP_RECENT most recent verbatim."""
    to_summarize = history[:-KEEP_RECENT]
    recent = history[-KEEP_RECENT:]

    convo_text = "\n".join(
        f"{m.role.upper()}: {m.text}" for m in to_summarize
    )
    summary_completion = await client.chat.completions.create(
        model="llama-3.3-70b-versatile",
        messages=[
            {
                "role": "system",
                "content": (
                    "Summarize the following conversation between a user and CalCoach "
                    "(an AI scheduling assistant). Preserve any scheduling preferences, "
                    "constraints, decisions, or personal details the user expressed. Be concise."
                ),
            },
            {"role": "user", "content": convo_text},
        ],
    )
    summary_text = summary_completion.choices[0].message.content
    summary_msg = HistoryMessage(role="system", text=f"[Earlier conversation summary] {summary_text}")
    return [summary_msg] + recent


def _truncate(text: str, max_chars: int = 80) -> str:
    text = text.strip()
    return text if len(text) <= max_chars else text[:max_chars] + "…"


def _build_system_prompt(sessions: List[dict], reflections: List[dict]) -> str:
    now = datetime.now(timezone.utc)
    today = now.strftime("%A, %B %d, %Y")
    today_str = now.strftime("%Y-%m-%d")

    # Only include sessions within a 2-week window to keep prompt size bounded
    cal_lines = []
    for s in sorted(sessions, key=lambda x: (x.get("date", ""), x.get("startHour", 0))):
        date = s.get("date", "")
        if date < today_str:
            continue
        h, m = s.get("startHour", 0), s.get("startMin", 0)
        dur = s.get("durationMins", 0)
        cal_lines.append(f"  - {date} {h:02d}:{m:02d} ({dur}min): {s.get('title')}")
    cal_block = "\n".join(cal_lines[:30]) if cal_lines else "  (no upcoming events)"

    ref_lines = []
    for r in reflections[-5:]:
        note = _truncate(r.get("reflectionText", "") or "", max_chars=120)
        ref_lines.append(
            f"  - {r.get('date')} {r.get('startTime', '')}-{r.get('endTime', '')} [{r.get('title')}] productivity={r.get('productivity')}/5"
            + (f": {note}" if note else "")
        )
    ref_block = "\n".join(ref_lines) if ref_lines else "  (no reflections yet)"

    return f"""You are CalCoach, an AI scheduling assistant. Today is {today}.

CURRENT CALENDAR:
{cal_block}

RECENT REFLECTIONS (productivity ratings and notes from past sessions):
{ref_block}

Use the calendar and reflections to give personalized, context-aware scheduling advice.
When the user asks you to schedule or add something, pick a specific time that doesn't conflict with existing events and fits their patterns from reflections.

Always respond with valid JSON in exactly this format:
{{
  "reply": "<your conversational response>",
  "events_to_create": [
    {{
      "title": "<event title>",
      "description": "<optional description>",
      "date": "<yyyy-MM-dd>",
      "startHour": <0-23>,
      "startMin": <0 or 30>,
      "durationMins": <duration in minutes>
    }}
  ]
}}

If you are not creating any events, use an empty array for events_to_create.
Do not include any text outside the JSON object."""


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
    try:
        parsed = json.loads(raw)
        reply = parsed.get("reply", raw)
        events_raw = parsed.get("events_to_create", [])
        events = [CalendarEvent(**e) for e in events_raw if isinstance(e, dict)]
    except Exception:
        reply = raw
        events = []

    updated_history = history + [
        HistoryMessage(role="user", text=body.message),
        HistoryMessage(role="assistant", text=reply),
    ]

    return ChatResponse(reply=reply, events_to_create=events, updated_history=updated_history)
