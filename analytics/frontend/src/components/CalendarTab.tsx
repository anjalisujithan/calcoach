import { useState, useEffect, useRef } from 'react';
import WeekCalendar, { Session, CalendarMeta, detectLocationType, getDefaultTimezone } from './WeekCalendar';
import ChatBar, { Message } from './ChatBar';
import EventModal from './EventModal';
import { ReflectionEntry } from './ReflectionPanel';

const CALENDAR_API = 'http://localhost:8000';
const ANALYTICS_API = 'http://localhost:8001';

let msgId = 0;
const mkId = () => String(++msgId);

function getInitialMessages(): Message[] {
  return [
    {
      id: mkId(),
      role: 'assistant',
      text: "Hi! I'm CalCoach. Share your tasks and goals and I'll help generate an optimized schedule for your week or answer your questions!",
    },
  ];
}

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
  const loc = event.location ?? '';
  const storedType = event.extendedProperties?.private?.locationType;
  return {
    id: event.id,
    title: event.summary ?? '(No title)',
    description: event.description ?? '',
    location: loc,
    locationType: storedType ?? (loc ? detectLocationType(loc) : undefined),
    timezone: event.start?.timeZone ?? getDefaultTimezone(),
    calendarId: event._calendarId ?? 'primary',
    visibility: event.visibility ?? 'default',
    date: startStr.slice(0, 10),
    dayIndex: start.getDay(),
    startHour: start.getHours(),
    startMin: start.getMinutes(),
    durationMins,
    color: GCAL_COLORS[event.colorId] ?? '#4285f4',
    recurrence: event.recurrence,
    recurringEventId: event.recurringEventId,
    attendees: event.attendees ?? [],
  };
}

function sessionToPayload(s: Omit<Session, 'id'>) {
  return {
    title: s.title,
    description: s.description,
    location: s.location ?? '',
    locationType: s.locationType ?? 'room',
    timezone: s.timezone ?? getDefaultTimezone(),
    calendarId: s.calendarId ?? 'primary',
    visibility: s.visibility ?? 'default',
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
  onSessionsChange?: (sessions: Session[]) => void;
  userEmail: string;
}

const DEFAULT_CATEGORIES = ['Work', 'Research', 'Classes', 'Personal'];

function loadCategories(): string[] {
  try {
    const stored = localStorage.getItem('calcoach_categories');
    if (stored) return JSON.parse(stored);
  } catch { /* ignore */ }
  return DEFAULT_CATEGORIES;
}

export default function CalendarTab({ reflections, onSaveReflection, onSessionsChange, userEmail }: Props) {
  const [messages, setMessages] = useState<Message[]>(getInitialMessages());
  const [chatHistory, setChatHistory] = useState<{ role: string; text: string }[]>([]);
  const [chatOpen, setChatOpen] = useState(true);
  const [chatLoading, setChatLoading] = useState(false);
  const [authenticated, setAuthenticated] = useState<boolean | null>(null);
  const [sessions, setSessions] = useState<Session[]>([]);
  const [refreshing, setRefreshing] = useState(false);
  const [selectedSessionId, setSelectedSessionId] = useState<string | null>(null);
  const [categories, setCategories] = useState<string[]>(loadCategories);
  const [newEventDraft, setNewEventDraft] = useState<{ date: string; startHour: number; startMin: number; durationMins: number } | null>(null);
  const [calendars, setCalendars] = useState<CalendarMeta[]>([]);
  const [visibleCalendarIds, setVisibleCalendarIds] = useState<Set<string>>(new Set(['primary']));
  const calInitialized = useRef(false);

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

  useEffect(() => { onSessionsChange?.(sessions); }, [sessions, onSessionsChange]);

  // On first calendar load, default visibility to the primary calendar only
  useEffect(() => {
    if (calendars.length === 0 || calInitialized.current) return;
    calInitialized.current = true;
    const primary = calendars.find(c => c.primary);
    const init = new Set<string>(['primary']);
    if (primary) init.add(primary.id);
    setVisibleCalendarIds(init);
  }, [calendars]);

  const localIds = useRef<Set<string>>(new Set());
  const inFlightController = useRef<AbortController | null>(null);
  const inFlightTimeout = useRef<ReturnType<typeof setTimeout> | null>(null);
  const abortReason = useRef<'user' | 'timeout' | null>(null);
  /** groupId → { slotIndex, events[] } for /feedback + multi-block GCal create */
  const pendingSlotMap = useRef<Map<string, { slotIndex: number; events: any[] }>>(new Map());
  /** pending block session id → groupId */
  const pendingSessionToGroup = useRef<Map<string, string>>(new Map());

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
    fetch(`${CALENDAR_API}/calendar/calendars`, { credentials: 'include' })
      .then(r => r.json())
      .then(data => setCalendars(data.calendars ?? []))
      .catch(() => {});
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [authenticated]);

  async function handleEditSession(id: string, s: Omit<Session, 'id'>) {
    setSessions(prev => prev.map(existing => existing.id === id ? { ...s, id } : existing));
    if (!authenticated) return;
    try {
      await fetch(`${CALENDAR_API}/calendar/events/${id}`, {
        method: 'PATCH',
        credentials: 'include',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(sessionToPayload(s)),
      });
    } catch { /* optimistic */ }
  }

  async function handleAddSession(s: Omit<Session, 'id'>) {
    if (!authenticated) {
      const id = mkId();
      localIds.current.add(id);
      setSessions(prev => [...prev, { ...s, id }]);
      return;
    }
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
      // Resync to load all expanded recurring instances from GCal
      if ((s.recurrence ?? []).length > 0) fetchEvents();
    } catch {
      const id = mkId();
      localIds.current.add(id);
      setSessions(prev => [...prev, { ...s, id }]);
    }
  }

  async function handleDeleteSession(id: string) {
    if (authenticated) {
      try {
        const calId = sessions.find(s => s.id === id)?.calendarId ?? 'primary';
        await fetch(`${CALENDAR_API}/calendar/events/${id}?calendarId=${encodeURIComponent(calId)}`, {
          method: 'DELETE',
          credentials: 'include',
        });
      } catch { /* optimistic */ }
    }
    setSessions(prev => prev.filter(s => s.id !== id));
    setSelectedSessionId(null);
  }

  async function handleDeleteSeriesSession(recurringEventId: string) {
    try {
      await fetch(`${CALENDAR_API}/calendar/events/${recurringEventId}`, {
        method: 'DELETE',
        credentials: 'include',
      });
    } catch { /* optimistic */ }
    setSessions(prev => prev.filter(s => s.recurringEventId !== recurringEventId && s.id !== recurringEventId));
    setSelectedSessionId(null);
  }

  function handleOpenCreate(date: string, startHour: number, startMin: number, durationMins: number) {
    setNewEventDraft({ date, startHour, startMin, durationMins });
  }

  async function handleSaveNew(_id: string, s: Omit<Session, 'id'>) {
    await handleAddSession(s);
    setNewEventDraft(null);
  }

  function clearPendingSuggestions() {
    pendingSlotMap.current.clear();
    pendingSessionToGroup.current.clear();
    setSessions(prev => prev.filter(s => !s.pending));
  }

  function clearInFlightRequest() {
    if (inFlightTimeout.current) {
      clearTimeout(inFlightTimeout.current);
      inFlightTimeout.current = null;
    }
    inFlightController.current = null;
    abortReason.current = null;
    setChatLoading(false);
  }

  function handleStopChat() {
    if (!inFlightController.current) return;
    abortReason.current = 'user';
    inFlightController.current.abort();
  }

  function handleRestartChat() {
    handleStopChat();
    clearPendingSuggestions();
    setChatHistory([]);
    setMessages(getInitialMessages());
  }

  async function handleSend(text: string) {
    if (chatLoading) return;
    const userMsg: Message = { id: mkId(), role: 'user', text };
    setMessages(m => [...m, userMsg]);

    const controller = new AbortController();
    inFlightController.current = controller;
    setChatLoading(true);
    inFlightTimeout.current = setTimeout(() => {
      abortReason.current = 'timeout';
      controller.abort();
    }, 60_000);

    try {
      const res = await fetch(`${ANALYTICS_API}/chat`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        signal: controller.signal,
        body: JSON.stringify({
          message: text,
          requester_email: userEmail,
          history: chatHistory,
          sessions: sessions.filter(s => !s.pending).map(({ title, date, startHour, startMin, durationMins }) => ({
            title, date, startHour, startMin, durationMins,
          })),
          reflections: reflections.map(({ title, date, startTime, endTime, productivity, reflectionText }) => ({
            title, date, startTime, endTime, productivity, reflectionText,
          })),
        }),
      });
      clearInFlightRequest();
      const data = await res.json();
      const reply = data.reply ?? 'Sorry, something went wrong.';
      setMessages(m => [...m, { id: mkId(), role: 'assistant', text: reply }]);
      if (data.updated_history) setChatHistory(data.updated_history);

      // Handle ranked suggestions as pending (grayed-out) calendar events
      const suggestions: any[] = data.pending_suggestions ?? [];
      if (suggestions.length > 0) {
        pendingSlotMap.current.clear();
        pendingSessionToGroup.current.clear();

        const toAdd: Session[] = [];
        for (const suggestion of suggestions) {
          const events: any[] =
            Array.isArray(suggestion.calendar_blocks) && suggestion.calendar_blocks.length > 0
              ? suggestion.calendar_blocks
              : [suggestion.slot];
          const groupId = mkId();
          pendingSlotMap.current.set(groupId, { slotIndex: suggestion.rank - 1, events });

          events.forEach((event: any, i: number) => {
            const pendingId = mkId();
            pendingSessionToGroup.current.set(pendingId, groupId);
            toAdd.push({
              id: pendingId,
              title: `#${suggestion.rank} ${event.title ?? ''}`,
              description: event.description ?? '',
              date: event.date,
              dayIndex: new Date(event.date + 'T00:00:00').getDay(),
              startHour: event.startHour,
              startMin: event.startMin,
              durationMins: event.durationMins,
              color: '#4285f4',
              pending: true,
              pendingGroupId: groupId,
              pendingShowActions: i === 0,
            });
          });
        }
        setSessions(prev => [...prev.filter(s => !s.pending), ...toAdd]);
      }

      // Backwards-compat: direct events_to_create (non-scheduling replies)
      const newEvents = data.events_to_create ?? [];
      if (newEvents.length > 0) {
        let hasRecurring = false;
        for (const event of newEvents) {
          const recurrence: string[] = event.recurrence ?? [];
          if (recurrence.length > 0) hasRecurring = true;
          await handleAddSession({
            title: event.title,
            description: event.description ?? '',
            date: event.date,
            dayIndex: new Date(event.date + 'T00:00:00').getDay(),
            startHour: event.startHour,
            startMin: event.startMin,
            durationMins: event.durationMins,
            color: '#4285f4',
            recurrence,
          });
        }
        // Resync to load all expanded instances from GCal
        if (hasRecurring) fetchEvents();
      }
    } catch (err: any) {
      const reason = abortReason.current;
      clearInFlightRequest();
      const msg = err?.name === 'AbortError'
        ? reason === 'user'
          ? 'Stopped.'
          : 'Request timed out (>60s). The scheduling engine may be overloaded — try again.'
        : 'Error reaching CalCoach backend.';
      setMessages(m => [...m, { id: mkId(), role: 'assistant', text: msg }]);
    }
  }

  async function handleAcceptSession(id: string) {
    const groupId = pendingSessionToGroup.current.get(id) ?? id;
    const info = pendingSlotMap.current.get(groupId);
    if (!info?.events?.length) return;

    try {
      await fetch(`${ANALYTICS_API}/feedback`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ slot_index: info.slotIndex, feedback: 'accepted' }),
      });
    } catch { /* non-critical */ }

    const stripRank = (t: string) => t.replace(/^#\d+\s+/, '');

    const newRows: Session[] = [];
    if (info?.events?.length) {
      for (const e of info.events) {
        if (authenticated) {
          try {
            const res = await fetch(`${CALENDAR_API}/calendar/events`, {
              method: 'POST',
              credentials: 'include',
              headers: { 'Content-Type': 'application/json' },
              body: JSON.stringify({
                title: stripRank(e.title ?? ''),
                description: e.description ?? '',
                date: e.date,
                startHour: e.startHour,
                startMin: e.startMin,
                durationMins: e.durationMins,
                recurrence: [],
              }),
            });
            const d = await res.json();
            const gcalId = d.event?.id ?? mkId();
            newRows.push({
              id: gcalId,
              title: stripRank(e.title ?? ''),
              description: e.description ?? '',
              date: e.date,
              dayIndex: new Date(e.date + 'T00:00:00').getDay(),
              startHour: e.startHour,
              startMin: e.startMin,
              durationMins: e.durationMins,
              color: '#4285f4',
            });
            continue;
          } catch { /* fall through to local */ }
        }
        const tid = mkId();
        localIds.current.add(tid);
        newRows.push({
          id: tid,
          title: stripRank(e.title ?? ''),
          description: e.description ?? '',
          date: e.date,
          dayIndex: new Date(e.date + 'T00:00:00').getDay(),
          startHour: e.startHour,
          startMin: e.startMin,
          durationMins: e.durationMins,
          color: '#4285f4',
        });
      }
    }

    setSessions(prev => {
      const withoutPending = prev.filter(s => !s.pending);
      return [...withoutPending, ...newRows];
    });

    pendingSlotMap.current.clear();
    pendingSessionToGroup.current.clear();

    // If any accepted event has recurrence, resync to load all expanded instances
    if (info.events.some((e: any) => (e.recurrence ?? []).length > 0)) {
      fetchEvents();
    }
  }

  async function handleRejectSession(id: string) {
    const groupId = pendingSessionToGroup.current.get(id) ?? id;
    const info = pendingSlotMap.current.get(groupId);
    if (info) {
      try {
        await fetch(`${ANALYTICS_API}/feedback`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ slot_index: info.slotIndex, feedback: 'rejected' }),
        });
      } catch { /* non-critical */ }
      pendingSlotMap.current.delete(groupId);
    }
    Array.from(pendingSessionToGroup.current.keys()).forEach(pid => {
      if (pendingSessionToGroup.current.get(pid) === groupId) {
        pendingSessionToGroup.current.delete(pid);
      }
    });
    setSessions(prev => prev.filter(s => {
      if (!s.pending) return true;
      const gid = s.pendingGroupId ?? s.id;
      return gid !== groupId;
    }));
  }

  // Only show sessions from calendars the user has checked
  const visibleSessions = sessions.filter(
    s => s.pending || visibleCalendarIds.has(s.calendarId ?? 'primary')
  );

  function toggleCalendar(id: string) {
    setVisibleCalendarIds(prev => {
      const next = new Set(prev);
      if (next.has(id)) {
        if (next.size === 1) return prev; // keep at least one visible
        next.delete(id);
      } else {
        next.add(id);
      }
      return next;
    });
  }

  // Per-calendar color indicator + toggle pill
  const calFilterBar = calendars.length > 1 ? (
    <div style={{
      display: 'flex', alignItems: 'center', gap: '6px',
      padding: '5px 16px', borderBottom: '1px solid #e0e0e0',
      background: '#fff', flexShrink: 0, flexWrap: 'wrap',
    }}>
      <span style={{ fontSize: '11px', color: '#9aa0a6', fontWeight: 600, textTransform: 'uppercase', letterSpacing: '0.4px', flexShrink: 0, marginRight: '2px' }}>
        Calendars:
      </span>
      {calendars.map(c => {
        const on = visibleCalendarIds.has(c.id);
        const col = c.backgroundColor ?? '#4285f4';
        return (
          <button
            key={c.id}
            onClick={() => toggleCalendar(c.id)}
            title={c.primary ? `${c.summary} (default)` : c.summary}
            style={{
              display: 'inline-flex', alignItems: 'center', gap: '5px',
              padding: '2px 10px 2px 7px', borderRadius: '20px', border: 'none',
              outline: `1.5px solid ${on ? col : '#e0e0e0'}`,
              background: on ? `${col}1a` : 'transparent',
              cursor: 'pointer', fontSize: '12px',
              color: on ? '#202124' : '#9aa0a6',
              fontWeight: c.primary ? 600 : 400,
              transition: 'all 0.12s', flexShrink: 0, maxWidth: '200px',
            }}
          >
            <span style={{
              width: '8px', height: '8px', borderRadius: '50%', flexShrink: 0,
              background: on ? col : '#d0d0d0', display: 'inline-block',
            }} />
            <span style={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
              {c.summary}{c.primary ? ' ★' : ''}
            </span>
          </button>
        );
      })}
    </div>
  ) : null;

  const resyncBtn = (
    <>
      {authenticated === true && (
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
      )}
      {authenticated === false && (
        <a
          href={`${CALENDAR_API}/auth/login?email=${encodeURIComponent(userEmail)}`}
          style={{
            background: '#fff', color: '#3c4043',
            border: '1px solid #dadce0', borderRadius: '6px',
            padding: '0.4rem 0.75rem', fontWeight: 600,
            fontSize: '0.85rem', textDecoration: 'none', display: 'inline-block',
          }}
        >
          Connect Google Calendar
        </a>
      )}
      {!chatOpen && (
        <button
          onClick={() => setChatOpen(true)}
          style={{
            background: '#fff',
            color: '#3c4043',
            border: '1px solid #dadce0',
            borderRadius: '6px',
            padding: '0.4rem 0.75rem',
            fontWeight: 600,
            cursor: 'pointer',
            fontSize: '0.85rem',
          }}
          title="Reopen chat sidebar"
        >
          Open Chat
        </button>
      )}
    </>
  );

  return (
    <div className="tab-layout">
      <div style={{ flex: 1, display: 'flex', flexDirection: 'column', overflow: 'hidden', minWidth: 0 }}>
        {calFilterBar}
        <WeekCalendar
          sessions={visibleSessions}
          selectedSession={selectedSessionId}
          onSelectSession={setSelectedSessionId}
          onAddSession={handleAddSession}
          onEditSession={handleEditSession}
          onDeleteSession={handleDeleteSession}
          onAcceptSession={handleAcceptSession}
          onRejectSession={handleRejectSession}
          onOpenCreate={handleOpenCreate}
          categories={categories}
          onAddCategory={handleAddCategory}
          onDeleteCategory={handleDeleteCategory}
          calendars={calendars}
          toolbarExtra={resyncBtn}
        />
      </div>
      {chatOpen && (
        <ChatBar
          headerLabel="Feedback for generated schedule"
          placeholder="Schedule Anything"
          messages={messages}
          onSend={handleSend}
          mentionSearchEndpoint={`${ANALYTICS_API}/users/search`}
          currentUserEmail={userEmail}
          isLoading={chatLoading}
          onStop={handleStopChat}
          onReset={handleRestartChat}
          onClose={() => setChatOpen(false)}
        />
      )}
      {selectedSession && (
        <EventModal
          session={selectedSession}
          reflections={reflections}
          categories={categories}
          onAddCategory={handleAddCategory}
          onDeleteCategory={handleDeleteCategory}
          calendars={calendars}
          onClose={() => setSelectedSessionId(null)}
          onSave={handleEditSession}
          onDelete={handleDeleteSession}
          onDeleteSeries={handleDeleteSeriesSession}
          onSaveReflection={onSaveReflection}
        />
      )}
      {newEventDraft && (
        <EventModal
          session={{
            id: '__new__',
            title: '',
            description: '',
            date: newEventDraft.date,
            dayIndex: new Date(newEventDraft.date + 'T12:00:00').getDay(),
            startHour: newEventDraft.startHour,
            startMin: newEventDraft.startMin,
            durationMins: newEventDraft.durationMins,
            color: '#4285f4',
          }}
          reflections={[]}
          categories={categories}
          onAddCategory={handleAddCategory}
          onDeleteCategory={handleDeleteCategory}
          calendars={calendars}
          onClose={() => setNewEventDraft(null)}
          onSave={handleSaveNew}
          onDelete={() => setNewEventDraft(null)}
          onSaveReflection={onSaveReflection}
        />
      )}
    </div>
  );
}
