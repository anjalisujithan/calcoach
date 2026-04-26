"""
Minimal Firestore helpers for the calendar backend.
Only used to persist and retrieve OAuth tokens per user.
Uses the synchronous firebase_admin client (the auth callback is sync).
"""

from __future__ import annotations

import os
from datetime import datetime, timezone
import firebase_admin
from firebase_admin import credentials, firestore as fs

_app: firebase_admin.App | None = None
SHARED_AVAILABILITY_COLLECTION = "shared_availability"


def _init_app() -> firebase_admin.App:
    import json

    inline_json = os.environ.get("FIREBASE_SERVICE_ACCOUNT_JSON")
    if inline_json:
        cred = credentials.Certificate(json.loads(inline_json))
        return firebase_admin.initialize_app(cred, name="calendar")

    key_path = os.environ.get("FIREBASE_SERVICE_ACCOUNT_PATH") or os.environ.get(
        "GOOGLE_APPLICATION_CREDENTIALS"
    )
    project_id = os.environ.get("FIREBASE_PROJECT_ID")

    if key_path:
        cred = credentials.Certificate(key_path)
        return firebase_admin.initialize_app(cred, name="calendar")

    if project_id:
        cred = credentials.ApplicationDefault()
        return firebase_admin.initialize_app(cred, {"projectId": project_id}, name="calendar")

    raise RuntimeError(
        "Firestore not configured. Set FIREBASE_SERVICE_ACCOUNT_PATH or FIREBASE_PROJECT_ID."
    )


def _get_db():
    global _app
    if "calendar" not in firebase_admin._apps:
        _app = _init_app()
    app = firebase_admin.get_app(name="calendar")
    db_id = os.environ.get("FIRESTORE_DATABASE_ID") or os.environ.get("FIREBASE_FIRESTORE_DATABASE")
    if db_id:
        return fs.client(app=app, database_id=db_id)
    return fs.client(app=app)


def save_calendar_tokens(email: str, tokens: dict) -> None:
    """Persist OAuth tokens for a user. Called synchronously from the auth callback."""
    try:
        db = _get_db()
        db.collection("users").document(email).set(
            {"calendar_tokens": tokens}, merge=True
        )
    except Exception as e:
        print(f"[calendar] Failed to save tokens for {email}: {e}")


def get_calendar_tokens(email: str) -> dict | None:
    """Fetch stored OAuth tokens for a user. Returns None if not found."""
    try:
        db = _get_db()
        doc = db.collection("users").document(email).get()
        if doc.exists:
            return (doc.to_dict() or {}).get("calendar_tokens")
        return None
    except Exception as e:
        print(f"[calendar] Failed to get tokens for {email}: {e}")
        return None


def save_shared_availability_snapshot(email: str, sessions: list[dict]) -> None:
    """Persist a minimal busy-session snapshot for joint scheduling fallback."""
    owner_email = (email or "").strip().lower()
    if not owner_email:
        return
    try:
        db = _get_db()
        payload = {
            "owner_email": owner_email,
            "source": "calendar_events_sync",
            "sessions": sessions[:500],
            "updated_at": datetime.now(timezone.utc).isoformat().replace("+00:00", "Z"),
        }
        db.collection(SHARED_AVAILABILITY_COLLECTION).document(owner_email).set(payload, merge=True)
    except Exception as e:
        print(f"[calendar] Failed to save shared snapshot for {owner_email}: {e}")


def save_oauth_state(state: str, email: str) -> None:
    """Store OAuth state in Firestore so it survives across any redirect."""
    try:
        db = _get_db()
        db.collection("oauth_states").document(state).set({
            "email": email,
            "created_at": datetime.now(timezone.utc).isoformat().replace("+00:00", "Z"),
        })
    except Exception as e:
        print(f"[calendar] Failed to save oauth state: {e}")


def get_and_delete_oauth_state(state: str) -> str | None:
    """Fetch the email for a given OAuth state and delete it (one-time use)."""
    try:
        db = _get_db()
        ref = db.collection("oauth_states").document(state)
        doc = ref.get()
        if not doc.exists:
            return None
        email = (doc.to_dict() or {}).get("email", "")
        ref.delete()
        return email or None
    except Exception as e:
        print(f"[calendar] Failed to get oauth state: {e}")
        return None


def get_shared_availability_sessions(email: str) -> list[dict]:
    """Fetch stored snapshot sessions for a user."""
    owner_email = (email or "").strip().lower()
    if not owner_email:
        return []
    try:
        db = _get_db()
        doc = db.collection(SHARED_AVAILABILITY_COLLECTION).document(owner_email).get()
        if not doc.exists:
            return []
        data = doc.to_dict() or {}
        sessions = data.get("sessions")
        if isinstance(sessions, list):
            return [s for s in sessions if isinstance(s, dict)]
        return []
    except Exception as e:
        print(f"[calendar] Failed to fetch shared snapshot for {owner_email}: {e}")
        return []
