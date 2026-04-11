"""
CalCoach Analytics Backend — FastAPI
Persists reflection data to Google Firestore.
"""

from __future__ import annotations

from pathlib import Path

from dotenv import load_dotenv

# Repo root `.env` (e.g. FIREBASE_SERVICE_ACCOUNT_PATH) — works when cwd is analytics/backend
load_dotenv(Path(__file__).resolve().parent.parent.parent / ".env")

from datetime import datetime
from typing import List, Optional

from fastapi import FastAPI, HTTPException
from fastapi.middleware.cors import CORSMiddleware
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
    record["serverSavedAt"] = datetime.utcnow().isoformat() + "Z"

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


@app.post("/users/seed", response_model=List[UserOut])
async def seed_dummy_users():
    """Write a few fixed documents to the `users` collection (safe to call repeatedly)."""
    db = get_db()
    now = datetime.utcnow().isoformat() + "Z"
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

class ChatMessage(BaseModel):
    session_id: Optional[str] = None
    message: str


class ChatResponse(BaseModel):
    reply: str


@app.post("/chat", response_model=ChatResponse)
async def chat(body: ChatMessage):
    # TODO: retrieve past reflections for context, call LLM
    return {"reply": "[LLM stub] Connect an LLM here to generate coaching responses."}
