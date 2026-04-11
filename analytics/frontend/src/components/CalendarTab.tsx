import { useState, useEffect, useRef } from 'react';
import WeekCalendar, { Session } from './WeekCalendar';
import ChatBar, { Message } from './ChatBar';
import EventModal from './EventModal';
import { ReflectionEntry } from './ReflectionPanel';

const CALENDAR_API = 'http://localhost:8000';
const ANALYTICS_API = 'http://localhost:8001';

let msgId = 0;
const mkId = () => String(++msgId);

const INITIAL_MESSAGES: Message[] = [
  {
    id: mkId(),
    role: 'assistant',
    text: "Hi! I'm CalCoach. Share your tasks and goals and I'll help generate an optimized schedule for your week.",
  },
];

const GCAL_COLORS: Record<string, string> = {
  '1':  '#7986cb',
  '2':  '#33b679',
  '3':  '#8e24aa',
  '4':  '#e67c73',
  '5':  '#f6bf26',
  '6':  '#f4511e',
  '7':  '#039be5',
  '8':  '#3f51b5',
  '9':  '#0f9d58',
  '10': '#d50000',
  '11': '#616161',
};

function googleEventToSession(event: any): Session | null {
  const startStr: string = event.start?.dateTime ?? event.start?.date;
  const endStr: string = event.end?.dateTime ?? event.end?.date;
  if (!startStr || !endStr) return null;
  const start = new Date(startStr);
  const end = new Date(endStr);
  const durationMins = Math.round((end.getTime() - start.getTime()) / 60000);
  return {
    id: event.id,
    title: event.summary ?? '(No title)',
    description: event.description ?? '',
    date: startStr.slice(0, 10),
    dayIndex: start.getDay(),
    startHour: start.getHours(),
    startMin: start.getMinutes(),
    durationMins,
    color: GCAL_COLORS[event.colorId] ?? '#4285f4',
    recurrence: event.recurrence,
  };
}

function sessionToPayload(s: Omit<Session, 'id'>) {
  return {
    title: s.title,
    description: s.description,
    date: s.date,
    startHour: s.startHour,
    startMin: s.startMin,
    durationMins: s.durationMins,
    recurrence: s.recurrence ?? [],
  };
}

interface Props {
  reflections: ReflectionEntry[];
  onSaveReflection: (entry: Omit<ReflectionEntry, 'id' | 'savedAt'>) => void;
}

const DEFAULT_CATEGORIES = ['Work', 'Research', 'Classes', 'Personal'];

function loadCategories(): string[] {
  try {
    const stored = localStorage.getItem('calcoach_categories');
    if (stored) return JSON.parse(stored);
  } catch { /* ignore */ }
  return DEFAULT_CATEGORIES;
}

export default function CalendarTab({ reflections, onSaveReflection }: Props) {
  const [messages, setMessages] = useState<Message[]>(INITIAL_MESSAGES);
  const [authenticated, setAuthenticated] = useState<boolean | null>(null);
  const [sessions, setSessions] = useState<Session[]>([]);
  const [refreshing, setRefreshing] = useState(false);
  const [selectedSessionId, setSelectedSessionId] = useState<string | null>(null);
  const [categories, setCategories] = useState<string[]>(loadCategories);

  function handleAddCategory(cat: string) {
    setCategories(prev => {
      if (prev.includes(cat)) return prev;
      const next = [...prev, cat];
      localStorage.setItem('calcoach_categories', JSON.stringify(next));
      return next;
    });
  }

  function handleDeleteCategory(cat: string) {
    setCategories(prev => {
      const next = prev.filter(c => c !== cat);
      localStorage.setItem('calcoach_categories', JSON.stringify(next));
      return next;
    });
  }

  const localIds = useRef<Set<string>>(new Set());

  const selectedSession = sessions.find(s => s.id === selectedSessionId) ?? null;

  useEffect(() => {
    fetch(`${CALENDAR_API}/auth/status`, { credentials: 'include' })
      .then(r => r.json())
      .then(data => setAuthenticated(data.authenticated))
      .catch(() => setAuthenticated(false));
  }, []);

  async function fetchEvents() {
    setRefreshing(true);
    try {
      const res = await fetch(`${CALENDAR_API}/calendar/events`, { credentials: 'include' });
      const data = await res.json();
      const gcalSessions = (data.events ?? [])
        .map(googleEventToSession)
        .filter(Boolean) as Session[];
      const gcalIds = new Set(gcalSessions.map(s => s.id));

      const orphaned = sessions.filter(s => localIds.current.has(s.id));
      const pushed: Session[] = [];
      for (const s of orphaned) {
        try {
          const r = await fetch(`${CALENDAR_API}/calendar/events`, {
            method: 'POST',
            credentials: 'include',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(sessionToPayload(s)),
          });
          const d = await r.json();
          const newId = d.event?.id ?? s.id;
          localIds.current.delete(s.id);
          pushed.push({ ...s, id: newId });
          gcalIds.add(newId);
        } catch {
          pushed.push(s);
        }
      }
      setSessions([...gcalSessions, ...pushed.filter(s => !gcalIds.has(s.id))]);
    } catch (e) {
      console.error(e);
    } finally {
      setRefreshing(false);
    }
  }

  useEffect(() => {
    if (!authenticated) return;
    fetchEvents();
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [authenticated]);

  async function handleEditSession(id: string, s: Omit<Session, 'id'>) {
    try {
      await fetch(`${CALENDAR_API}/calendar/events/${id}`, {
        method: 'PATCH',
        credentials: 'include',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(sessionToPayload(s)),
      });
    } catch { /* optimistic */ }
    setSessions(prev => prev.map(existing => existing.id === id ? { ...s, id } : existing));
  }

  async function handleAddSession(s: Omit<Session, 'id'>) {
    try {
      const res = await fetch(`${CALENDAR_API}/calendar/events`, {
        method: 'POST',
        credentials: 'include',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(sessionToPayload(s)),
      });
      const data = await res.json();
      const id = data.event?.id ?? mkId();
      setSessions(prev => [...prev, { ...s, id }]);
    } catch {
      const id = mkId();
      localIds.current.add(id);
      setSessions(prev => [...prev, { ...s, id }]);
    }
  }

  async function handleDeleteSession(id: string) {
    try {
      await fetch(`${CALENDAR_API}/calendar/events/${id}`, {
        method: 'DELETE',
        credentials: 'include',
      });
    } catch { /* optimistic */ }
    setSessions(prev => prev.filter(s => s.id !== id));
    setSelectedSessionId(null);
  }

  function handleSend(text: string) {
    const userMsg: Message = { id: mkId(), role: 'user', text };
    const botMsg: Message = {
      id: mkId(),
      role: 'assistant',
      text: "[Placeholder Message]: Of course! I have scheduled a lunch for Chris on Wednesday, April 8 from 1-2pm. Let me know if that works :)",
    };
    setMessages(m => [...m, userMsg, botMsg]);
  }

  if (authenticated === null) {
    return (
      <div className="tab-layout">
        <div className="calendar-panel" style={{ display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
          <p style={{ color: '#888' }}>Checking Google Calendar connection…</p>
        </div>
      </div>
    );
  }

  if (!authenticated) {
    return (
      <div className="tab-layout">
        <div className="calendar-panel" style={{ display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
          <div style={{ textAlign: 'center' }}>
            <p style={{ marginBottom: '1rem', color: '#666' }}>Connect your Google Calendar to get started.</p>
            <a href={`${CALENDAR_API}/auth/login`} className="btn-save" style={{ textDecoration: 'none', padding: '0.6rem 1.4rem' }}>
              Connect Google Calendar
            </a>
          </div>
        </div>
        <ChatBar
          headerLabel="Feedback for generated schedule"
          placeholder="Schedule Anything"
          messages={messages}
          onSend={handleSend}
        />
      </div>
    );
  }

  const resyncBtn = (
    <button
      onClick={fetchEvents}
      disabled={refreshing}
      style={{
        background: refreshing ? '#ccc' : '#4285f4',
        color: '#fff', border: 'none', borderRadius: '6px',
        padding: '0.4rem 1rem', fontWeight: 600,
        cursor: refreshing ? 'not-allowed' : 'pointer', fontSize: '0.85rem',
      }}
    >
      {refreshing ? '↻ Syncing…' : '↻ Resync with GCal'}
    </button>
  );

  return (
    <div className="tab-layout">
      <WeekCalendar
        sessions={sessions}
        selectedSession={selectedSessionId}
        onSelectSession={setSelectedSessionId}
        onAddSession={handleAddSession}
        onEditSession={handleEditSession}
        categories={categories}
        onAddCategory={handleAddCategory}
        onDeleteCategory={handleDeleteCategory}
        toolbarExtra={resyncBtn}
      />
      <ChatBar
        headerLabel="Feedback for generated schedule"
        placeholder="Schedule Anything"
        messages={messages}
        onSend={handleSend}
      />
      {selectedSession && (
        <EventModal
          session={selectedSession}
          reflections={reflections}
          categories={categories}
          onAddCategory={handleAddCategory}
          onDeleteCategory={handleDeleteCategory}
          onClose={() => setSelectedSessionId(null)}
          onSave={handleEditSession}
          onDelete={handleDeleteSession}
          onSaveReflection={onSaveReflection}
        />
      )}
    </div>
  );
}
