# CalCoach 🧸📆

Ever feel like you literally cannot for the life of you remember what you spent your entire day on? Students struggle with time management and this problem extends beyond academics, even in the workforce. The concrete problems this AI coach will address are: 1. Managing assignments, 2. Breaking projects into manageable subparts, 3. Work/Life balance

We start with students, but we believe this is a more generalizable problem to all working adults who want to effectively manage their life for maximum time management capabilities.

## Architecture

| Service | Location | Port |
|---|---|---|
| React frontend | `analytics/frontend/` | 3000 |
| Analytics backend (FastAPI) | `analytics/backend/` | 8001 |
| Calendar backend (FastAPI) | `calendar/` | 8000 |

## Setup

### 1. Groq API Key (LLM Backend)

1. Go to [https://console.groq.com/keys](https://console.groq.com/keys) and create an API key.
2. Add it to the root `.env`:
   ```
   GROQ_API_KEY='your-groq-api-key'
   ```

### 2. Firebase / Firestore

- Enable **Email/Password** and **Google** under Firebase console → Authentication → Sign-in method
- Download a service account key: Project settings → Service accounts → Generate new private key
- Save it to `analytics/backend/serviceAccount.json`

**Root `.env`** (full example):
```
GROQ_API_KEY=your-groq-api-key
FIREBASE_SERVICE_ACCOUNT_PATH=/path/to/calcoach/analytics/backend/serviceAccount.json
FIRESTORE_DATABASE_ID=calcoach
```

**Frontend `.env`** (`analytics/frontend/.env`):
```
REACT_APP_FIREBASE_API_KEY=your-api-key
REACT_APP_FIREBASE_AUTH_DOMAIN=your-project.firebaseapp.com
REACT_APP_FIREBASE_PROJECT_ID=your-project-id
```

Find the frontend values in Firebase console → Project settings → Your apps → SDK setup.

### 3. Install dependencies

**Analytics backend:**
```bash
cd analytics/backend
python3 -m venv venv
source venv/bin/activate
pip install -r requirements.txt
```

**Calendar backend:**
```bash
cd calendar
python3 -m venv venv
source venv/bin/activate
pip install -r requirements.txt
```

**Frontend:**
```bash
cd analytics/frontend && npm install
```

## Running Locally

Start all three services (each in its own terminal):

```bash
# Terminal 1 — analytics backend
cd analytics/backend && source venv/bin/activate
uvicorn main:app --reload --port 8001

# Terminal 2 — calendar backend
cd calendar && source venv/bin/activate
uvicorn main:app --reload --port 8000

# Terminal 3 — frontend
cd analytics/frontend && npm start
```

The app opens at `http://localhost:3000`.

## Firestore Collections

| Collection | Description |
|---|---|
| `users` | One document per user (keyed by email), created on first login |
| `reflections` | Productivity reflections tied to calendar sessions |

## Authentication

Users sign up / log in via the landing page using email/password or Google. On first login a document is created in the `users` collection via `POST /users/register` on the analytics backend.

## Claude Scheduling Pipeline

Run the sample schedule set through Claude and log structured JSON suggestions.

1. Export your Anthropic key:
   - `export ANTHROPIC_API_KEY="your-key"`
2. (Optional) Limit schedules for a quick smoke test:
   - `export SCHEDULE_LIMIT=2`
3. (Optional) Override model:
   - `export CLAUDE_MODEL="claude-opus-4-6"`
4. Run:
   - `python run_claude_schedule_pipeline.py --intended-task "Study for CS 61C midterm"`

Outputs are written under `logs/claude_schedule_run_<timestamp>/`:
- `parsed_results.json` (validated structured output)
- `raw_responses.jsonl` (full API responses + extracted text)
- `errors.jsonl` (per-item failures, if any)
