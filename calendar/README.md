---
noteId: "fb719d11218511f1b6c7adf354e427f5"
tags: []

---

# Calendar Backend

FastAPI backend that handles Google Calendar OAuth and exposes calendar data.

## Setup

```bash
cd calendar
python -m venv venv
source venv/bin/activate
pip install fastapi uvicorn python-dotenv google-auth google-auth-oauthlib google-api-python-client itsdangerous starlette
```

Create a `.env` file:
```
GOOGLE_CLIENT_ID="your-client-id"
GOOGLE_CLIENT_SECRET="your-client-secret"
SECRET_KEY="your-random-secret"
```

## Run

```bash
uvicorn main:app --reload
```

Then in order:

1. `http://localhost:8000/auth/login` — log in with Google
2. `http://localhost:8000/calendar/events` — should return your real calendar events
3. `http://localhost:8000/calendar/busy` — should return your busy time blocks

## Routes

### Auth

| Method | Route | What it does |
|--------|-------|--------------|
| GET | `/auth/login` | Redirects user to Google's login page |
| GET | `/auth/callback` | Google redirects here after login — exchanges the code for tokens and saves them to the session |
| GET | `/auth/status` | Returns whether the user is authenticated |

### Calendar

| Method | Route | What it does |
|--------|-------|--------------|
| GET | `/calendar/events` | Returns the next 10 upcoming events from the user's primary calendar |
| GET | `/calendar/busy` | Returns busy time blocks for the next 7 days |

All `/calendar/*` routes require the user to be authenticated first via `/auth/login`.

## Project Structure

```
calendar/
├── main.py                 # App setup, middleware, router registration
├── routes/
│   ├── auth.py             # OAuth flow routes
│   └── calendar.py         # Calendar data routes
├── services/
│   └── google_calendar.py  # Google Calendar API calls
├── .env                    # Secrets (not committed)
└── .gitignore
```
