import { useState, useEffect, useRef } from 'react';
import WeekCalendar, { Session, detectLocationType, getDefaultTimezone } from './WeekCalendar';
import ChatBar, { Message } from './ChatBar';
import EventModal from './EventModal';
import { ReflectionEntry } from './ReflectionPanel';

const CALENDAR_API = process.env.REACT_APP_CALENDAR_API ?? 'http://localhost:8000';
const ANALYTICS_API = process.env.REACT_APP_ANALYTICS_API ?? 'http://localhost:8001';

let msgId = 0;
const mkId = () => String(++msgId);

function getInitialMessages(): Message[] {
  return [
    {
      id: mkId(),
      role: 'assistant',
      text: "Hi! I'm CalCoach. Share your tasks and goals and I'll help generate an optimized schedule for your week! Type @[email] to schedule meetings with others :)",
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
    color: event.extendedProperties?.private?.calcoachColor ?? GCAL_COLORS[event.colorId] ?? '#4285f4',
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
    color: s.color ?? '#4285f4',
  };
}

interface Props {
  reflections: ReflectionEntry[];
  onSaveReflection: (entry: Omit<ReflectionEntry, 'id' | 'savedAt'>) => void;
  onSessionsChange?: (sessions: Session[]) => void;
  userEmail: string;
}

const DEFAULT_CATEGORIES = ['Work', 'Research', 'Classes', 'Personal'];

export default function CalendarTab({ reflections, onSaveReflection, onSessionsChange, userEmail }: Props) {
  const [messages, setMessages] = useState<Message[]>(getInitialMessages());
  const [chatHistory, setChatHistory] = useState<{ role: string; text: string }[]>([]);
  const [chatOpen, setChatOpen] = useState(true);
  const [chatLoading, setChatLoading] = useState(false);
  const [authenticated, setAuthenticated] = useState<boolean | null>(null);
  const [sessions, setSessions] = useState<Session[]>([]);
  const [refreshing, setRefreshing] = useState(false);
  const [selectedSessionId, setSelectedSessionId] = useState<string | null>(null);
  const [categories, setCategories] = useState<string[]>(DEFAULT_CATEGORIES);
  const [newEventDraft, setNewEventDraft] = useState<{ date: string; startHour: number; startMin: number; durationMins: number } | null>(null);

  function handleAddCategory(cat: string) {
    setCategories(prev => {
      if (prev.includes(cat)) return prev;
      return [...prev, cat];
    });
  }

  function handleDeleteCategory(cat: string) {
    setCategories(prev => prev.filter(c => c !== cat));
  }

  useEffect(() => { onSessionsChange?.(sessions); }, [sessions, onSessionsChange]);

  const localIds = useRef<Set<string>>(new Set());
  const inFlightController = useRef<AbortController | null>(null);
  const inFlightTimeout = useRef<ReturnType<typeof setTimeout> | null>(null);
  const abortReason = useRef<'user' | 'timeout' | null>(null);
  /** groupId → { slotIndex, events[], attendeeEmails? } for /feedback + multi-block GCal create */
  const pendingSlotMap = useRef<Map<string, { slotIndex: number; events: any[]; attendeeEmails?: string[] }>>(new Map());
  /** pending block session id → groupId */
  const pendingSessionToGroup = useRef<Map<string, string>>(new Map());
  /** attendee emails mentioned anywhere in the current chat thread — persists across turns */
  const activeAttendeeEmails = useRef<string[]>([]);

  const selectedSession = sessions.find(s => s.id === selectedSessionId) ?? null;

  useEffect(() => {
    // Reset state immediately so the previous user's events are never visible to the new user
    setSessions([]);
    localIds.current.clear();
    setAuthenticated(null);
    setCategories(DEFAULT_CATEGORIES);
    if (!userEmail) return;
    const q = `?email=${encodeURIComponent(userEmail)}`;
    // Load local sessions first, then check GCal auth — this ensures localIds is populated
    // before fetchEvents runs, so orphaned local events get pushed when GCal connects.
    fetch(`${ANALYTICS_API}/sessions?user_id=${encodeURIComponent(userEmail)}`)
      .then(r => r.json())
      .then(data => {
        const stored: Session[] = data.sessions ?? [];
        const savedLocalIds: string[] = data.local_ids ?? [];
        const storedCategories: string[] | null = data.categories ?? null;
        savedLocalIds.forEach(id => localIds.current.add(id));
        if (stored.length > 0) setSessions(stored);
        if (storedCategories && storedCategories.length > 0) setCategories(storedCategories);
      })
      .catch(() => {})
      .finally(() => {
        fetch(`${CALENDAR_API}/auth/status${q}`, { credentials: 'include' })
          .then(r => r.json())
          .then(data => setAuthenticated(data.authenticated))
          .catch(() => setAuthenticated(false));
      });
  }, [userEmail]);

  async function fetchEvents() {
    setRefreshing(true);
    const emailQ = userEmail ? `?email=${encodeURIComponent(userEmail)}` : '';
    try {
      const res = await fetch(`${CALENDAR_API}/calendar/events${emailQ}`, { credentials: 'include' });
      const data = await res.json();
      const gcalSessions = (data.events ?? [])
        .map(googleEventToSession)
        .filter(Boolean) as Session[];
      const gcalIds = new Set(gcalSessions.map(s => s.id));

      const orphaned = sessions.filter(s => localIds.current.has(s.id));
      const pushed: Session[] = [];
      for (const s of orphaned) {
        try {
          const r = await fetch(`${CALENDAR_API}/calendar/events${emailQ}`, {
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

  // Persist local sessions + categories to Firestore when not using GCal
  useEffect(() => {
    if (authenticated !== false || !userEmail) return;
    const nonPending = sessions.filter(s => !s.pending);
    fetch(`${ANALYTICS_API}/sessions`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ user_id: userEmail, sessions: nonPending, local_ids: Array.from(localIds.current), categories }),
    }).catch(() => {});
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [sessions, authenticated, userEmail, categories]);

  // Persist categories to Firestore when using GCal (sessions live in GCal, not Firestore)
  useEffect(() => {
    if (authenticated !== true || !userEmail) return;
    fetch(`${ANALYTICS_API}/sessions`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ user_id: userEmail, categories }),
    }).catch(() => {});
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [categories, authenticated, userEmail]);

  async function handleEditSession(id: string, s: Omit<Session, 'id'>) {
    setSessions(prev => prev.map(existing => existing.id === id ? { ...s, id } : existing));
    if (!authenticated) return;
    const emailQ = userEmail ? `?email=${encodeURIComponent(userEmail)}` : '';
    try {
      await fetch(`${CALENDAR_API}/calendar/events/${id}${emailQ}`, {
        method: 'PATCH',
        credentials: 'include',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(sessionToPayload(s)),
      });
      // Resync to pick up all expanded recurring instances (or remove them when recurrence cleared)
      const prevRecurrence = sessions.find(e => e.id === id)?.recurrence ?? [];
      const newRecurrence = s.recurrence ?? [];
      if (prevRecurrence.length > 0 || newRecurrence.length > 0) fetchEvents();
    } catch { /* optimistic */ }
  }

  async function handleAddSession(s: Omit<Session, 'id'>) {
    if (!authenticated) {
      const id = mkId();
      localIds.current.add(id);
      setSessions(prev => [...prev, { ...s, id }]);
      return;
    }
    const emailQ = userEmail ? `?email=${encodeURIComponent(userEmail)}` : '';
    try {
      const res = await fetch(`${CALENDAR_API}/calendar/events${emailQ}`, {
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
      const emailQ = userEmail ? `&email=${encodeURIComponent(userEmail)}` : '';
      try {
        const calId = sessions.find(s => s.id === id)?.calendarId ?? 'primary';
        await fetch(`${CALENDAR_API}/calendar/events/${id}?calendarId=${encodeURIComponent(calId)}${emailQ}`, {
          method: 'DELETE',
          credentials: 'include',
        });
      } catch { /* optimistic */ }
    }
    setSessions(prev => prev.filter(s => s.id !== id));
    setSelectedSessionId(null);
  }

  async function handleDeleteSeriesSession(recurringEventId: string) {
    const emailQ = userEmail ? `?email=${encodeURIComponent(userEmail)}` : '';
    try {
      await fetch(`${CALENDAR_API}/calendar/events/${recurringEventId}${emailQ}`, {
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
    activeAttendeeEmails.current = [];
  }

  async function handleSend(text: string) {
    if (chatLoading) return;
    const userMsg: Message = { id: mkId(), role: 'user', text };
    const atRe2 = /@([\w.+\-]+@[\w.\-]+\.\w{2,})/g;
    let m2; while ((m2 = atRe2.exec(text)) !== null) {
      const e = m2[1].toLowerCase();
      if (!activeAttendeeEmails.current.includes(e)) activeAttendeeEmails.current.push(e);
    }
    setMessages(m => [...m, userMsg]);

    const mentionedInMessage: string[] = [];
    const atRe3 = /@([\w.+\-]+@[\w.\-]+\.\w{2,})/g;
    let m3; while ((m3 = atRe3.exec(text)) !== null) mentionedInMessage.push(m3[1]);
    if (!authenticated && mentionedInMessage.length > 0) {
      setMessages(m => [...m, {
        id: mkId(),
        role: 'assistant',
        text: 'Joint scheduling requires Google Calendar. Connect your calendar using the "Connect Google Calendar" button above to schedule with others.',
      }]);
      return;
    }

    const controller = new AbortController();
    inFlightController.current = controller;
    setChatLoading(true);
    inFlightTimeout.current = setTimeout(() => {
      abortReason.current = 'timeout';
      controller.abort();
    }, 120_000);

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

        const attendeeEmails = [...activeAttendeeEmails.current];

        const toAdd: Session[] = [];
        for (const suggestion of suggestions) {
          const events: any[] =
            Array.isArray(suggestion.calendar_blocks) && suggestion.calendar_blocks.length > 0
              ? suggestion.calendar_blocks
              : [suggestion.slot];
          const groupId = mkId();
          pendingSlotMap.current.set(groupId, { slotIndex: suggestion.rank - 1, events, attendeeEmails });

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
          : 'Request timed out (>120s). The scheduling engine may be overloaded — try again.'
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
      const emailQ = userEmail ? `?email=${encodeURIComponent(userEmail)}` : '';
      for (const e of info.events) {
        if (authenticated) {
          try {
            const res = await fetch(`${CALENDAR_API}/calendar/events${emailQ}`, {
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
                attendees: info.attendeeEmails?.length ? [userEmail, ...info.attendeeEmails].filter(Boolean) : [],
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

  async function handleDisconnect() {
    const emailQ = userEmail ? `?email=${encodeURIComponent(userEmail)}` : '';
    try {
      await fetch(`${CALENDAR_API}/auth/disconnect${emailQ}`, { method: 'POST', credentials: 'include' });
    } catch { /* best-effort */ }
    setSessions([]);
    setAuthenticated(false);
  }

  const resyncBtn = (
    <>
      {authenticated === true && (
        <>
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
          <button
            onClick={handleDisconnect}
            style={{
              background: '#fff', color: '#d93025',
              border: '1px solid #d93025', borderRadius: '6px',
              padding: '0.4rem 0.75rem', fontWeight: 600,
              cursor: 'pointer', fontSize: '0.85rem',
            }}
          >
            Disconnect Calendar
          </button>
        </>
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
        <WeekCalendar
          sessions={sessions}
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
          reflections={reflections}
          categories={categories}
          onAddCategory={handleAddCategory}
          onDeleteCategory={handleDeleteCategory}
          onClose={() => setNewEventDraft(null)}
          onSave={handleSaveNew}
          onDelete={() => setNewEventDraft(null)}
          onSaveReflection={onSaveReflection}
        />
      )}
    </div>
  );
}
