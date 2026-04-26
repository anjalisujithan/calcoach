from fastapi import APIRouter, Request
from fastapi.responses import RedirectResponse, JSONResponse
from google_auth_oauthlib.flow import Flow
from firestore_client import save_calendar_tokens, save_shared_availability_snapshot, save_oauth_state, get_and_delete_oauth_state
from services.google_calendar import get_calendar_service

import os
import tempfile

SCOPES = ["https://www.googleapis.com/auth/calendar"]
REDIRECT_URI = os.getenv("GOOGLE_REDIRECT_URI", "http://localhost:8000/auth/callback")
FRONTEND_URL = os.getenv("FRONTEND_URL", "http://localhost:3000")

def _get_client_secrets_file() -> str:
    """Return path to client secrets JSON. Supports inline JSON via env var for prod."""
    inline = os.getenv("GOOGLE_CLIENT_SECRETS_JSON")
    if inline:
        tmp = tempfile.NamedTemporaryFile(mode="w", suffix=".json", delete=False)
        tmp.write(inline)
        tmp.flush()
        return tmp.name
    path = os.getenv("GOOGLE_CLIENT_SECRETS_FILE",
                     "client_secret_372533672163-9usane5tl6oqvv04n26vo6arsc61igpp.apps.googleusercontent.com.json")
    return path

router = APIRouter(prefix="/auth")


@router.get("/login")
def login(request: Request, email: str = ""):
    flow = Flow.from_client_secrets_file(
        _get_client_secrets_file(),
        scopes=SCOPES,
        redirect_uri=REDIRECT_URI,
    )
    auth_url, state = flow.authorization_url(
        access_type="offline",
        prompt="consent",
    )
    save_oauth_state(state, email.strip().lower())
    return RedirectResponse(auth_url)


@router.get("/callback")
def callback(request: Request, code: str, state: str):
    email = get_and_delete_oauth_state(state)
    if email is None:
        return JSONResponse({"error": "State mismatch — possible CSRF"}, status_code=400)

    flow = Flow.from_client_secrets_file(
        _get_client_secrets_file(),
        scopes=SCOPES,
        redirect_uri=REDIRECT_URI,
        state=state,
    )
    flow.fetch_token(code=code)
    creds = flow.credentials

    tokens = {
        "access_token": creds.token,
        "refresh_token": creds.refresh_token,
        "token_uri": creds.token_uri,
        "client_id": creds.client_id,
        "client_secret": creds.client_secret,
        "scopes": list(creds.scopes or SCOPES),
    }

    if email:
        save_calendar_tokens(email, tokens)
        try:
            service = get_calendar_service(tokens)
            events = service.list_upcoming_events()
            sessions = [
                {
                    "id": e.get("id", ""),
                    "summary": e.get("summary", ""),
                    "start": e.get("start", {}),
                    "end": e.get("end", {}),
                }
                for e in events
            ]
            save_shared_availability_snapshot(email, sessions)
        except Exception as e:
            print(f"[calendar] Failed to sync shared availability on login for {email}: {e}")

    return RedirectResponse(FRONTEND_URL)


@router.get("/status")
def status(request: Request, email: str = ""):
    if email:
        from firestore_client import get_calendar_tokens
        tokens = get_calendar_tokens(email.strip().lower())
        if tokens:
            return {"authenticated": True, "has_refresh_token": bool(tokens.get("refresh_token"))}
        return {"authenticated": False}
    tokens = request.session.get("tokens")
    if not tokens:
        return {"authenticated": False}
    return {"authenticated": True, "has_refresh_token": bool(tokens.get("refresh_token"))}


@router.post("/logout")
def logout(request: Request):
    """Clear calendar session state."""
    request.session.clear()
    return {"ok": True}
