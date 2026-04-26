import os
from dotenv import load_dotenv
from fastapi import FastAPI
from fastapi.middleware.cors import CORSMiddleware
from starlette.middleware.sessions import SessionMiddleware
from routes.auth import router as auth_router
from routes.calendar import router as calendar_router

load_dotenv(dotenv_path=os.path.join(os.path.dirname(__file__), "..", ".env"))

# Allow insecure transport only in local dev (Railway provides HTTPS)
if os.getenv("ENVIRONMENT", "development") == "development":
    os.environ["OAUTHLIB_INSECURE_TRANSPORT"] = "1"

_frontend_url = os.getenv("FRONTEND_URL", "http://localhost:3000")
_is_production = os.getenv("ENVIRONMENT", "development") == "production"

app = FastAPI()

app.add_middleware(
    CORSMiddleware,
    allow_origins=[_frontend_url],
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)
app.add_middleware(
    SessionMiddleware,
    secret_key=os.getenv("SECRET_KEY", "dev-secret-change-in-prod"),
    same_site="none" if _is_production else "lax",
    https_only=_is_production,
)

app.include_router(auth_router)
app.include_router(calendar_router)
