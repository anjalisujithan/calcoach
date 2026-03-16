"""
CalCoach Analytics Backend — FastAPI scaffold
Currently stores reflections in memory; swap out for a real DB as needed.
"""

from __future__ import annotations

from datetime import datetime
from typing import List, Optional
from uuid import uuid4

from fastapi import FastAPI
from fastapi.middleware.cors import CORSMiddleware
from pydantic import BaseModel

app = FastAPI(title="CalCoach API")

app.add_middleware(
    CORSMiddleware,
    allow_origins=["http://localhost:3000"],
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)

# ── In-memory stores (replace with DB) ──────────────────────────────────────

sessions_db: dict[str, dict] = {}
reflections_db: list[dict] = []


# ── Models ───────────────────────────────────────────────────────────────────

class SessionCreate(BaseModel):
    title: str
    day_index: int          # 0=Sun … 6=Sat
    start_hour: int
    start_min: int
    duration_mins: int


class SessionOut(SessionCreate):
    id: str


class ReflectionCreate(BaseModel):
    session_id: str
    text: str


class ReflectionOut(ReflectionCreate):
    id: str
    session_title: Optional[str]
    timestamp: str


class ChatMessage(BaseModel):
    session_id: Optional[str] = None
    message: str


class ChatResponse(BaseModel):
    reply: str


# ── Session endpoints ────────────────────────────────────────────────────────

@app.get("/sessions", response_model=List[SessionOut])
def list_sessions():
    return list(sessions_db.values())


@app.post("/sessions", response_model=SessionOut)
def create_session(body: SessionCreate):
    session = {"id": str(uuid4()), **body.dict()}
    sessions_db[session["id"]] = session
    return session


@app.delete("/sessions/{session_id}")
def delete_session(session_id: str):
    sessions_db.pop(session_id, None)
    return {"ok": True}


# ── Reflection endpoints ─────────────────────────────────────────────────────

@app.get("/reflections", response_model=List[ReflectionOut])
def list_reflections(session_id: Optional[str] = None):
    rows = reflections_db
    if session_id:
        rows = [r for r in rows if r["session_id"] == session_id]
    return rows


@app.post("/reflections", response_model=ReflectionOut)
def create_reflection(body: ReflectionCreate):
    session_title = sessions_db.get(body.session_id, {}).get("title")
    reflection = {
        "id": str(uuid4()),
        "session_id": body.session_id,
        "text": body.text,
        "session_title": session_title,
        "timestamp": datetime.utcnow().isoformat(),
    }
    reflections_db.append(reflection)
    return reflection


# ── Chat endpoint (stub — wire up LLM here) ──────────────────────────────────

@app.post("/chat", response_model=ChatResponse)
def chat(body: ChatMessage):
    # TODO: call LLM with body.message + retrieved reflections as context
    reply = (
        f"[LLM stub] Received: '{body.message}'. "
        "Connect an LLM here to generate real responses."
    )
    return {"reply": reply}
