import hashlib
import base64
import secrets
from fastapi import APIRouter, Request
from fastapi.responses import RedirectResponse, JSONResponse
from google_auth_oauthlib.flow import Flow

SCOPES = ["https://www.googleapis.com/auth/calendar"]
CLIENT_SECRETS_FILE = "client_secret_372533672163-9usane5tl6oqvv04n26vo6arsc61igpp.apps.googleusercontent.com.json"
REDIRECT_URI = "http://localhost:8000/auth/callback"

router = APIRouter(prefix="/auth")


@router.get("/login")
def login(request: Request):
    flow = Flow.from_client_secrets_file(
        CLIENT_SECRETS_FILE,
        scopes=SCOPES,
        redirect_uri=REDIRECT_URI,
    )
    code_verifier = secrets.token_urlsafe(96)
    code_challenge = base64.urlsafe_b64encode(
        hashlib.sha256(code_verifier.encode()).digest()
    ).rstrip(b"=").decode()

    auth_url, state = flow.authorization_url(
        access_type="offline",
        prompt="consent",
        code_challenge=code_challenge,
        code_challenge_method="S256",
    )
    request.session["oauth_state"] = state
    request.session["code_verifier"] = code_verifier
    return RedirectResponse(auth_url)


@router.get("/callback")
def callback(request: Request, code: str, state: str):
    if state != request.session.get("oauth_state"):
        return JSONResponse({"error": "State mismatch — possible CSRF"}, status_code=400)

    flow = Flow.from_client_secrets_file(
        CLIENT_SECRETS_FILE,
        scopes=SCOPES,
        redirect_uri=REDIRECT_URI,
        state=state,
    )
    flow.fetch_token(code=code, code_verifier=request.session.get("code_verifier"))
    creds = flow.credentials

    request.session["tokens"] = {
        "access_token": creds.token,
        "refresh_token": creds.refresh_token,
        "token_uri": creds.token_uri,
        "client_id": creds.client_id,
        "client_secret": creds.client_secret,
        "scopes": list(creds.scopes or SCOPES),
    }

    return {"message": "Authenticated successfully", "has_refresh_token": bool(creds.refresh_token)}


@router.get("/status")
def status(request: Request):
    tokens = request.session.get("tokens")
    if not tokens:
        return {"authenticated": False}
    return {"authenticated": True, "has_refresh_token": bool(tokens.get("refresh_token"))}
