"""
firestore_client.py

Initializes the Firebase Admin SDK once and exposes a get_db() helper
that returns the Firestore client.

Configuration — set ONE of:
  1. GOOGLE_APPLICATION_CREDENTIALS env var pointing to your service-account JSON key file
     (Firebase Admin picks this up automatically)
  2. FIREBASE_SERVICE_ACCOUNT_PATH env var — an explicit path to the key file
  3. FIREBASE_PROJECT_ID env var — for use inside a GCP environment where ADC is available

Optional (named Firestore database, not the default "(default)" DB):
  FIRESTORE_DATABASE_ID — e.g. "calcoach" when your DB id in GCP is not "(default)"

If none of these are set the app will raise a RuntimeError at startup.
"""

from __future__ import annotations

import os

import firebase_admin
from firebase_admin import credentials, firestore

_app: firebase_admin.App | None = None


def _init_app() -> firebase_admin.App:
    """Initialize Firebase Admin SDK exactly once."""
    # Explicit service-account key file path
    key_path = os.environ.get("FIREBASE_SERVICE_ACCOUNT_PATH") or os.environ.get(
        "GOOGLE_APPLICATION_CREDENTIALS"
    )
    project_id = os.environ.get("FIREBASE_PROJECT_ID")

    if key_path:
        cred = credentials.Certificate(key_path)
        return firebase_admin.initialize_app(cred)

    if project_id:
        # Use Application Default Credentials (works inside GCP / Cloud Run)
        cred = credentials.ApplicationDefault()
        return firebase_admin.initialize_app(cred, {"projectId": project_id})

    raise RuntimeError(
        "Firestore not configured. Set FIREBASE_SERVICE_ACCOUNT_PATH "
        "(or GOOGLE_APPLICATION_CREDENTIALS) to a service-account JSON key, "
        "or set FIREBASE_PROJECT_ID when running on GCP with ADC."
    )


def get_db() -> firestore.AsyncClient:
    """Return the Firestore async client, initializing Firebase on first call."""
    global _app
    if not firebase_admin._apps:
        _app = _init_app()
    app = firebase_admin.get_app()
    cred = app.credential
    project_id = app.project_id or cred.project_id or os.environ.get("FIREBASE_PROJECT_ID")
    if not project_id:
        raise RuntimeError(
            "Could not determine Firebase project id for Firestore (set FIREBASE_PROJECT_ID if needed)."
        )
    db_id = os.environ.get("FIRESTORE_DATABASE_ID") or os.environ.get(
        "FIREBASE_FIRESTORE_DATABASE"
    )
    creds = cred.get_credential()
    if db_id:
        return firestore.AsyncClient(
            project=project_id, credentials=creds, database=db_id
        )
    return firestore.AsyncClient(project=project_id, credentials=creds)
