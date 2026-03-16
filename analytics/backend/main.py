"""
CalCoach Analytics Backend — FastAPI
Persists reflection data to analytics/data/reflections.json for downstream analytics and RL.
"""

from __future__ import annotations

import json
from datetime import datetime
from pathlib import Path
from typing import List, Optional
from uuid import uuid4

from fastapi import FastAPI, HTTPException
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

# ── JSON file persistence ─────────────────────────────────────────────────────

DATA_DIR = Path(__file__).parent.parent / "data"
REFLECTIONS_FILE = DATA_DIR / "reflections.json"


def _load() -> list[dict]:
    DATA_DIR.mkdir(parents=True, exist_ok=True)
    if REFLECTIONS_FILE.exists():
        try:
            return json.loads(REFLECTIONS_FILE.read_text(encoding="utf-8"))
        except json.JSONDecodeError:
            return []
    return []


def _save(data: list[dict]) -> None:
    DATA_DIR.mkdir(parents=True, exist_ok=True)
    REFLECTIONS_FILE.write_text(
        json.dumps(data, indent=2, ensure_ascii=False), encoding="utf-8"
    )


# ── Models ────────────────────────────────────────────────────────────────────

class ReflectionIn(BaseModel):
    """
    Full reflection record sent from the frontend.
    Each field maps directly to what gets stored in reflections.json.
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
    # Client-generated fields (we trust them and re-stamp server-side too)
    id: str
    savedAt: str              # ISO timestamp from client


class ReflectionOut(ReflectionIn):
    serverSavedAt: str        # server-side timestamp for audit


# ── Endpoints ─────────────────────────────────────────────────────────────────

@app.get("/reflections", response_model=List[ReflectionOut])
def list_reflections(session_id: Optional[str] = None):
    """Return all reflections, optionally filtered by sessionId."""
    data = _load()
    if session_id:
        data = [r for r in data if r.get("sessionId") == session_id]
    return data


@app.post("/reflections", response_model=ReflectionOut, status_code=201)
def create_reflection(body: ReflectionIn):
    """
    Save a reflection entry. Appends to reflections.json.

    JSON schema for each record:
    {
      "id":             "client-generated uuid",
      "sessionId":      "client-generated uuid",
      "title":          "Work session title",
      "description":    "Optional description (may be empty string)",
      "date":           "yyyy-MM-dd",
      "startTime":      "HH:mm",
      "endTime":        "HH:mm",
      "productivity":   1-5,
      "reflectionText": "User's free-text reflection",
      "savedAt":        "ISO timestamp (client)",
      "serverSavedAt":  "ISO timestamp (server)"
    }
    """
    if not 1 <= body.productivity <= 5:
        raise HTTPException(400, "productivity must be 1–5")

    record = body.dict()
    record["serverSavedAt"] = datetime.utcnow().isoformat() + "Z"

    data = _load()
    data.append(record)
    _save(data)

    return record


@app.delete("/reflections/{reflection_id}")
def delete_reflection(reflection_id: str):
    data = _load()
    filtered = [r for r in data if r.get("id") != reflection_id]
    if len(filtered) == len(data):
        raise HTTPException(404, "Reflection not found")
    _save(filtered)
    return {"ok": True}


# ── Chat stub (wire up LLM here) ──────────────────────────────────────────────

class ChatMessage(BaseModel):
    session_id: Optional[str] = None
    message: str


class ChatResponse(BaseModel):
    reply: str


@app.post("/chat", response_model=ChatResponse)
def chat(body: ChatMessage):
    # TODO: retrieve past reflections for context, call LLM
    return {"reply": "[LLM stub] Connect an LLM here to generate coaching responses."}
