CalCoach 🧸📆
Ever feel like you literally cannot for the life of you remember what you spent your entire day on? Students struggle with time management and this problem extends beyond academics, even in the workforce. The concrete problems this AI coach will address are: 1. Managing assignments, 2. Breaking projects into manageable subparts, 3. Work/Life balance

Ever feel like you literally cannot remember what you spent your entire day on? Students struggle with time management, and the problem extends beyond academics into the workforce. This AI coach focuses on:

1. Managing assignments  
2. Breaking projects into manageable subparts  
3. Work / life balance  

We start with students, but the idea generalizes to anyone who wants stronger time management.

---

## Architecture

| Service | Location | Port |
| --- | --- | --- |
| React frontend | `analytics/frontend/` | 3000 |
| Analytics backend (FastAPI) | `analytics/backend/` | 8001 |
| Calendar backend (FastAPI) | `calendar/` | 8000 |

---

## Setup

### 1. Groq API key (LLM backend)

1. Create a key at [console.groq.com/keys](https://console.groq.com/keys).  
2. Add it to the **repo root** `.env`:

```env
GROQ_API_KEY=your-groq-api-key
```

### 2. Firebase / Firestore

- Enable **Email/Password** and **Google** under Firebase Console → **Authentication** → **Sign-in method**.  
- Download a service account key: **Project settings** → **Service accounts** → **Generate new private key**.  
- Save it (for example) to `analytics/backend/serviceAccount.json`.

**Root `.env`** (example):

```env
GROQ_API_KEY=your-groq-api-key
FIREBASE_SERVICE_ACCOUNT_PATH=/path/to/calcoach/analytics/backend/serviceAccount.json
FIRESTORE_DATABASE_ID=calcoach
Frontend .env (analytics/frontend/.env):

REACT_APP_FIREBASE_API_KEY=your-api-key
REACT_APP_FIREBASE_AUTH_DOMAIN=your-project.firebaseapp.com
REACT_APP_FIREBASE_PROJECT_ID=your-project-id
Find the frontend values in Firebase console → Project settings → Your apps → SDK setup.

3. Install dependencies
Analytics backend:

cd analytics/backend
python3 -m venv venv
source venv/bin/activate
pip install -r requirements.txt
Calendar backend:

cd calendar
python3 -m venv venv
source venv/bin/activate
pip install -r requirements.txt
Frontend:

cd analytics/frontend && npm install
Running Locally
Start all three services (each in its own terminal):

# Terminal 1 — analytics backend
cd analytics/backend && source venv/bin/activate
uvicorn main:app --reload --port 8001

# Terminal 2 — calendar backend
cd calendar && source venv/bin/activate
uvicorn main:app --reload --port 8000

# Terminal 3 — frontend
cd analytics/frontend && npm start
The app opens at http://localhost:3000.

Firestore Collections
Collection	Description
users	One document per user (keyed by email), created on first login
reflections	Productivity reflections tied to calendar sessions
Authentication
Users sign up / log in via the landing page using email/password or Google. On first login a document is created in the users collection via POST /users/register on the analytics backend.

Claude Scheduling Pipeline
Run the sample schedule set through Claude and log structured JSON suggestions.

   ```bash
   export ANTHROPIC_API_KEY="your-key"
   ```

2. Optional — limit schedules for a quick test:

   ```bash
   export SCHEDULE_LIMIT=2
   ```

3. Optional — override model:

   ```bash
   export CLAUDE_MODEL="claude-opus-4-6"
   ```

4. Run:

   ```bash
   python run_claude_schedule_pipeline.py --intended-task "Study for CS 61C midterm"
   ```

Outputs go under `logs/claude_schedule_run_<timestamp>/`:

| File | Contents |
| --- | --- |
| `parsed_results.json` | Validated structured output |
| `raw_responses.jsonl` | Full API responses + extracted text |
| `errors.jsonl` | Per-item failures (if any) |
parsed_results.json (validated structured output)
raw_responses.jsonl (full API responses + extracted text)
errors.jsonl (per-item failures, if any)
