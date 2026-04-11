---
noteId: "fb719d10218511f1b6c7adf354e427f5"
tags: []

---

# CalCoach — Analytics Module

**Built during:** March 2026 session
**Status:** Working prototype — UI complete, Google Calendar integrated, analytics backend ready for LLM integration
**Stack:** React 18 + TypeScript (frontend) · FastAPI + Python (backend)

---

## What this module is

The Analytics module is the user-facing frontend and data layer for CalCoach. It lives entirely inside `calcoach/analytics/` and is independent of the RL exploration code in `calcoach/RL_exploration/`.

Its job is to:
1. Display and manage work sessions on a weekly calendar synced with Google Calendar (**Calendar tab**)
2. Capture per-session reflections and a productivity score (1–5) after each session (**Diary tab**)
3. Visualize productivity trends over time (**Analytics tab**)
4. Persist all reflection data to a JSON file for use by the RL pipeline

---

## Folder structure

```
analytics/
├── backend/
│   ├── main.py              FastAPI server (reflections/diary)
│   └── requirements.txt     Python dependencies
├── data/                    Created automatically on first POST /reflections
│   └── reflections.json     Append-only log of all user reflections
└── frontend/
    ├── public/              Standard CRA public assets
    ├── src/
    │   ├── App.tsx          Root component — tab shell + shared state
    │   ├── App.css          All styles (single flat file)
    │   └── components/
    │       ├── WeekCalendar.tsx    Interactive 7-day calendar grid
    │       ├── CalendarTab.tsx     "Calendar" tab (Google Calendar sync + chat)
    │       ├── DiaryTab.tsx        "Diary" tab (sessions + reflections)
    │       ├── ReflectionPanel.tsx Productivity scale + reflection form
    │       ├── AnalyticsTab.tsx    SVG bar chart + session table
    │       └── ChatBar.tsx         Reusable chat sidebar UI
    ├── package.json
    └── tsconfig.json
```

---

## Running locally

### Quickstart (all services)
```bash
./start.sh   # from the calcoach/ root
```
This installs dependencies and starts all three services. `Ctrl+C` stops everything.

### Manual startup
```bash
# Calendar backend (Google OAuth + Calendar API)
cd calendar
uvicorn main:app --reload --port 8000
# → http://localhost:8000/docs

# Analytics backend (diary/reflections)
cd analytics/backend
pip install -r requirements.txt
uvicorn main:app --reload --port 8001
# → http://localhost:8001/docs

# Frontend
cd analytics/frontend
npm install && npm start
# → http://localhost:3000
```

### Port layout

| Service | Port |
|---|---|
| Calendar backend (Google OAuth) | `:8000` |
| Analytics backend (reflections) | `:8001` |
| Frontend | `:3000` |

---

## The three tabs

### 1. Calendar tab
**File:** `CalendarTab.tsx`
**Purpose:** Weekly calendar view synced with Google Calendar.

- On load, checks `/auth/status` on the calendar backend
- If not authenticated, shows a **"Connect Google Calendar"** button that redirects to Google's OAuth consent screen
- After auth, fetches upcoming events from `/calendar/events` and renders them on the `WeekCalendar` grid
- Clicking a time slot opens the add-session modal; on save, the event is POSTed to `/calendar/events` and created in Google Calendar
- Chat sidebar labelled **"Feedback for generated schedule"** — bot replies are stubbed; wire up `POST /chat` → LLM to make them real

### 2. Diary tab
**Files:** `DiaryTab.tsx`, `WeekCalendar.tsx`, `ReflectionPanel.tsx`
**Purpose:** The primary tab for this module. Users log work sessions and reflect on them.

**Interaction flow:**
1. User clicks any time slot on the calendar grid
2. A ghost (semi-transparent dashed) block appears at the clicked position, snapped to the nearest 30-minute boundary, defaulting to 1 hour in size
3. A modal opens pre-filled with the clicked time. Fields:
   - **Title** (required)
   - **Description** (optional)
   - **Day** (pre-filled from the column clicked)
   - **Start time** / **End time** (the three fields stay in sync — changing end time recalculates duration; changing duration shifts end time; changing start time keeps duration and shifts end time)
   - **Duration (mins)** — derived from start/end but manually editable
   - **Color** — palette of 10 preset colors
4. Ghost block resizes live as the user edits duration/end time/color in the modal
5. On "Add Session": block is confirmed on the calendar; modal closes; ghost disappears
6. Clicking a confirmed session block selects it and opens the **Reflection Panel** on the right

**Reflection Panel** (right sidebar when a session is selected):
- Always shows the instructions banner: *"Log your work sessions by clicking an area in the calendar, adding the work session, and writing any reflections!"*
- When a session is selected:
  - Session info card (title, description, date, time range, duration)
  - **5-face productivity scale**: 😞 😕 😐 🙂 😄 (scores 1–5)
  - Free-text reflection textarea
  - "Save Reflection" button (disabled until both productivity + text are filled)
  - Confirmation message on save: *"✓ Reflection saved!"*
  - Scrollable history of all past reflections for that session

### 3. Analytics tab
**File:** `AnalyticsTab.tsx`
**Purpose:** Shows productivity trends over time from logged reflections.

**Summary stat cards (top row):**
- Sessions logged (total count)
- Overall avg productivity (with emoji)
- Best period (highest avg, label shows the date/week/month)
- Worst period (lowest avg)

**Bar chart:**
- Three modes: **Day** · **Week** · **Month** — switches aggregation granularity
- Each bar = average productivity score for that period
- Colors: red (#ea4335) → orange → yellow → light green → green (#34a853) based on score
- Hover tooltip shows exact avg and session count
- Y-axis 1–5, X-axis labels rotate at > 12 bars
- Built with raw SVG (no charting library dependency); uses `ResizeObserver` for responsiveness

**All sessions table (below chart):**
- Newest first
- Columns: Date · Title · Time · Duration · Productivity badge · Reflection text

---

## Data model

### Session (frontend-only in DiaryTab, synced with Google Calendar in CalendarTab)
Defined in `WeekCalendar.tsx`:
```typescript
interface Session {
  id: string;
  title: string;
  description: string;   // "" if not filled in
  date: string;          // "yyyy-MM-dd"
  dayIndex: number;      // 0=Sun … 6=Sat
  startHour: number;
  startMin: number;
  durationMins: number;
  color: string;         // hex color e.g. "#4285f4"
}
```
In the **Diary tab**, sessions live only in React state for the current browser session.
In the **Calendar tab**, sessions are fetched from and written to Google Calendar via the calendar backend.

### ReflectionEntry (persisted)
Defined in `ReflectionPanel.tsx`, saved to `analytics/data/reflections.json`:
```typescript
interface ReflectionEntry {
  id: string;            // client-generated (incrementing string for now)
  sessionId: string;     // ties back to the Session
  title: string;
  description: string;
  date: string;          // "yyyy-MM-dd"
  startTime: string;     // "HH:mm"
  endTime: string;       // "HH:mm"
  productivity: number;  // 1–5
  reflectionText: string;
  savedAt: string;       // ISO timestamp (client)
  serverSavedAt: string; // ISO timestamp (server, added by backend)
}
```

**Example JSON record:**
```json
{
  "id": "3",
  "sessionId": "1",
  "title": "CS61A Homework",
  "description": "Working on recursion problems",
  "date": "2026-03-16",
  "startTime": "09:00",
  "endTime": "10:30",
  "productivity": 4,
  "reflectionText": "Felt focused but struggled with tree recursion. Got through 3 problems.",
  "savedAt": "2026-03-16T09:45:00.000Z",
  "serverSavedAt": "2026-03-16T09:45:01Z"
}
```

This file is the primary output of the module — the RL agent reads it to understand how users feel about different session types and times.

---

## Backend APIs

### Calendar backend — `http://localhost:8000`
Interactive docs: `http://localhost:8000/docs`

| Method | Path | Description |
|--------|------|-------------|
| `GET` | `/auth/login` | Redirects to Google OAuth consent screen |
| `GET` | `/auth/callback` | Handles Google redirect; stores tokens in session; redirects to frontend |
| `GET` | `/auth/status` | Returns `{ authenticated: bool }` |
| `GET` | `/calendar/events` | Fetch upcoming Google Calendar events |
| `GET` | `/calendar/busy` | Fetch busy time blocks for next 7 days |
| `POST` | `/calendar/events` | Create a new event in Google Calendar |

### Analytics backend — `http://localhost:8001`
Interactive docs: `http://localhost:8001/docs`

| Method | Path | Description |
|--------|------|-------------|
| `GET` | `/reflections` | List all reflections. Optional `?session_id=` filter. |
| `POST` | `/reflections` | Save a new reflection. Appends to `data/reflections.json`. |
| `DELETE` | `/reflections/{id}` | Remove a reflection by id. |
| `POST` | `/chat` | **Stub.** Accepts `{ session_id, message }`. Wire up LLM here. |

Both backends have CORS configured for `http://localhost:3000` only.

---

## State architecture

```
App.tsx  (owns reflections[])
├── CalendarTab        — owns sessions[] fetched from Google Calendar; auth state
│   └── WeekCalendar   — renders sessions; fires onAddSession
├── DiaryTab           — owns sessions[], receives reflections + onSaveReflection
│   ├── WeekCalendar   — owns weekStart, modal form; fires onAddSession / onSelectSession
│   └── ReflectionPanel — reads reflections, fires onSave
└── AnalyticsTab       — reads reflections (read-only)
```

`reflections` state lives in `App.tsx` so both DiaryTab and AnalyticsTab see the same data.

---

## Key design decisions & things to know

**Ghost block preview:** When the modal is open, a semi-transparent dashed block renders on the calendar derived directly from the form state. There is no separate "ghost" state — it's purely computed. This means it updates live as the user edits any field in the modal.

**Start/End/Duration sync:** All three fields are kept in sync:
- Change start → end shifts (duration preserved)
- Change end → duration recalculates
- Change duration → end shifts (start preserved)

**30-minute snap:** Clicking a column snaps to the nearest 30-min boundary. Enforced in `snapTo30()` in `WeekCalendar.tsx`.

**Default scroll to 8 AM:** The week grid scrolls to `scrollTop = 480` (8 × 60px) on mount.

**No charting library:** `AnalyticsTab.tsx` uses raw SVG with a `ResizeObserver` to avoid a heavy dependency for a simple bar chart.

**Analytics backend is optional:** The frontend saves reflections to React state immediately and fires `POST /reflections` in a try/catch. If the backend is down, the UI works normally — data just isn't written to disk.

**Google Calendar OAuth:** Uses PKCE flow. Tokens are stored server-side in a signed session cookie. The frontend never sees the tokens directly — it just makes credentialed requests to the calendar backend.

---

## What's not done yet (natural next steps)

| Area | What's needed |
|------|--------------|
| **Diary session persistence** | Diary tab sessions are lost on page refresh. Add `POST /sessions` + load on mount, or use localStorage. |
| **Calendar tab LLM chat** | Wire `POST /chat` to an actual LLM (Claude, GPT, etc.) using the user's reflections and calendar events as context. |
| **Diary chat → LLM** | `ReflectionPanel` saves raw text. A next step is sending that text + session metadata to the LLM for a coaching response. |
| **RL integration** | `data/reflections.json` is the input. The RL agent in `RL_exploration/` can read this to model user preferences and recommend better schedules. |
| **Auth / multi-user** | Everything is single-user right now. `reflections.json` is a flat global file. |
| **ID generation** | IDs are currently incrementing strings (`"1"`, `"2"`…) reset on page load. Switch to `uuid` on both client and server. |
