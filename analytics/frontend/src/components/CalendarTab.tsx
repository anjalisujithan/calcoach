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
    color: event.extendedProperties?.private?.calcoachColor ?? GCAL_COLORS[event.colorId] ?? '#FF1493',
    recurrence: event.recurrence,
    recurringEventId: event.recurringEventId,
    attendees: event.attendees ?? [],
  };
}

// Defensive cleanup for the events_to_create payload coming back from /chat.
// The model occasionally emits sibling COUNT/UNTIL fields instead of folding them
// into the RRULE string, and sometimes ships a recurrence rule without a date or
// start time. We move COUNT/UNTIL into the RRULE and drop entries that are missing
// the bits the calendar backend requires (it would 422 anyway).
function sanitizeRecurringEvent(event: any): any | null {
  if (!event || typeof event !== 'object') return null;
  const out: any = { ...event };

  let recurrence: string[] = Array.isArray(out.recurrence)
    ? [...out.recurrence]
    : typeof out.recurrence === 'string'
      ? [out.recurrence]
      : [];

  if (recurrence.length > 0) {
    let rule = String(recurrence[0] || '').trim();
    if (rule && !/^RRULE:/i.test(rule)) rule = `RRULE:${rule}`;
    const folded = (key: string) => {
      const v = out[key];
      if (v == null || v === '') return;
      if (rule && !new RegExp(`(^|;)${key}=`, 'i').test(rule)) {
        rule = `${rule};${key}=${v}`;
      }
      delete out[key];
    };
    folded('COUNT'); folded('UNTIL'); folded('FREQ'); folded('BYDAY'); folded('INTERVAL');
    recurrence = rule ? [rule] : [];
    out.recurrence = recurrence;
  }

  const hasRecurrence = recurrence.length > 0;
  const missingDate = !out.date || typeof out.date !== 'string';
  const missingStart = out.startHour == null || out.startMin == null;
  const missingDuration = !out.durationMins;

  if (missingDate || missingStart || missingDuration) {
    if (hasRecurrence) return null; // partial recurring event — surface a clarification instead
    return null;
  }
  return out;
}

// Visual fan-out for a recurring suggestion: given the master block (with its
// RRULE), generate up to `maxOccurrences` upcoming preview blocks so the user can
// see the proposed series painted across the calendar before accepting. The
// previews are display-only — `pendingSlotMap` still stores just the master, so
// accept POSTs a single recurring event (not one POST per preview).
const RRULE_BYDAY_TO_INDEX: Record<string, number> = {
  SU: 0, MO: 1, TU: 2, WE: 3, TH: 4, FR: 5, SA: 6,
};

function expandRecurringPreview(master: any, maxOccurrences: number = 8): any[] {
  if (!master || !master.date) return [master];
  const recArr: string[] = Array.isArray(master.recurrence) ? master.recurrence : [];
  const rrule = (recArr[0] || '').toString();
  if (!rrule) return [master];

  const bydayMatch = /BYDAY=([A-Z,]+)/i.exec(rrule);
  const untilMatch = /UNTIL=(\d{8})/i.exec(rrule);
  const countMatch = /COUNT=(\d+)/i.exec(rrule);
  const dailyMatch = /FREQ=DAILY/i.test(rrule);

  const start = new Date(`${master.date}T00:00:00`);
  if (Number.isNaN(start.getTime())) return [master];

  let targetWeekdays: number[] = [];
  if (bydayMatch) {
    targetWeekdays = bydayMatch[1].split(',')
      .map(c => RRULE_BYDAY_TO_INDEX[c.trim().toUpperCase()])
      .filter(d => d !== undefined);
  } else if (dailyMatch) {
    targetWeekdays = [0, 1, 2, 3, 4, 5, 6];
  } else {
    targetWeekdays = [start.getDay()];
  }
  if (targetWeekdays.length === 0) targetWeekdays = [start.getDay()];

  let untilDate: Date | null = null;
  if (untilMatch) {
    const u = untilMatch[1];
    const dt = new Date(`${u.slice(0, 4)}-${u.slice(4, 6)}-${u.slice(6, 8)}T23:59:59`);
    if (!Number.isNaN(dt.getTime())) untilDate = dt;
  }
  const limit = countMatch
    ? Math.min(parseInt(countMatch[1], 10), maxOccurrences)
    : maxOccurrences;

  const occurrences: any[] = [];
  const cursor = new Date(start);
  let safety = 0;
  while (occurrences.length < limit && safety < 90) {
    safety += 1;
    if (untilDate && cursor > untilDate) break;
    if (cursor >= start && targetWeekdays.includes(cursor.getDay())) {
      const yyyy = cursor.getFullYear();
      const mm = String(cursor.getMonth() + 1).padStart(2, '0');
      const dd = String(cursor.getDate()).padStart(2, '0');
      occurrences.push({ ...master, date: `${yyyy}-${mm}-${dd}` });
    }
    cursor.setDate(cursor.getDate() + 1);
  }
  return occurrences.length > 0 ? occurrences : [master];
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
    color: s.color ?? '#FF1493',
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
  /** groupId → { slotIndex, events[], attendeeEmails?, isMultiTask?, taskIndex? } for /feedback + multi-block GCal create */
  const pendingSlotMap = useRef<Map<string, { slotIndex: number; events: any[]; attendeeEmails?: string[]; isMultiTask?: boolean; taskIndex?: number }>>(new Map());
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
    } catch {
      // ignore fetch errors; refreshing flag is cleared in finally
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

        const isMultiTask = data.multi_task ?? false;
        const attendeeEmails = [...activeAttendeeEmails.current];
        const TASK_COLORS = ['#FF1493', '#0f9d58', '#f4b400', '#db4437', '#ab47bc', '#00acc1'];
        const OPTION_COLORS = ['#FF1493', '#0f9d58', '#f4b400', '#db4437', '#ab47bc', '#00acc1'];

        const toAdd: Session[] = [];
        for (const suggestion of suggestions) {
          const events: any[] =
            Array.isArray(suggestion.calendar_blocks) && suggestion.calendar_blocks.length > 0
              ? suggestion.calendar_blocks
              : [suggestion.slot];
          const taskIndex: number = suggestion.task_index ?? 0;
          const groupId = mkId();
          // For recurring suggestions, the master event(s) carry an RRULE — those
          // are what we POST on accept (one POST creates the whole series). The
          // visual preview blocks are generated separately so the user can see
          // the series painted across the calendar before approving.
          const isRecurringSuggestion = events.some((e: any) => Array.isArray(e.recurrence) && e.recurrence.length > 0);
          const visualBlocks: any[] = isRecurringSuggestion && events.length === 1
            ? expandRecurringPreview(events[0], 8)
            : events;
          pendingSlotMap.current.set(groupId, { slotIndex: suggestion.rank - 1, events, attendeeEmails, isMultiTask, taskIndex });
          const blockColor = isMultiTask
            ? TASK_COLORS[taskIndex % TASK_COLORS.length]
            : OPTION_COLORS[(suggestion.rank - 1) % OPTION_COLORS.length];
          const baseTitle = visualBlocks[0]?.title ?? events[0]?.title ?? '';
          const taskLabel = isMultiTask && suggestion.task_name ? `${suggestion.task_name} #${suggestion.rank}` : `#${suggestion.rank} ${baseTitle}`;

          visualBlocks.forEach((event: any, i: number) => {
            const pendingId = mkId();
            pendingSessionToGroup.current.set(pendingId, groupId);
            toAdd.push({
              id: pendingId,
              title: i === 0 ? taskLabel : event.title ?? '',
              description: event.description ?? '',
              date: event.date,
              dayIndex: new Date(event.date + 'T00:00:00').getDay(),
              startHour: event.startHour,
              startMin: event.startMin,
              durationMins: event.durationMins,
              color: blockColor,
              pending: true,
              pendingGroupId: groupId,
              pendingShowActions: i === 0,
              recurrence: event.recurrence ?? [],
            });
          });
        }
        setSessions(prev => [...prev.filter(s => !s.pending), ...toAdd]);
      }

      // Backwards-compat: direct events_to_create (non-scheduling replies)
      const newEvents = data.events_to_create ?? [];
      if (newEvents.length > 0) {
        let hasRecurring = false;
        let droppedCount = 0;
        for (const rawEvent of newEvents) {
          const event = sanitizeRecurringEvent(rawEvent);
          if (!event) {
            droppedCount += 1;
            continue;
          }
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
            color: '#FF1493',
            recurrence,
          });
        }
        // Resync to load all expanded instances from GCal
        if (hasRecurring) fetchEvents();
        if (droppedCount > 0) {
          setMessages(m => [...m, {
            id: mkId(),
            role: 'assistant',
            text: "I had the recurrence rule but I'm missing the start time or duration. What time should it run and how long is each session?",
          }]);
        }
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

  async function handleSendMultiTask(tasks: { name: string; duration?: string; attendees: string[] }[], allAttendeeEmails: string[] = []) {
    if (chatLoading || tasks.length < 2) return;
    const summaryText = `Schedule these tasks for me: ${tasks.map(t => t.name + (t.duration ? ` (${t.duration})` : '')).join(', ')}`;
    const userMsg: Message = { id: mkId(), role: 'user', text: summaryText };
    setMessages(m => [...m, userMsg]);

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
          message: summaryText,
          requester_email: userEmail,
          history: chatHistory,
          tasks,
          attendees: allAttendeeEmails,
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

      const suggestions: any[] = data.pending_suggestions ?? [];
      if (suggestions.length > 0) {
        pendingSlotMap.current.clear();
        pendingSessionToGroup.current.clear();
        const TASK_COLORS = ['#FF1493', '#0f9d58', '#f4b400', '#db4437', '#ab47bc', '#00acc1'];
        const toAdd: Session[] = [];
        for (const suggestion of suggestions) {
          const events: any[] =
            Array.isArray(suggestion.calendar_blocks) && suggestion.calendar_blocks.length > 0
              ? suggestion.calendar_blocks
              : [suggestion.slot];
          const taskIndex: number = suggestion.task_index ?? 0;
          const taskAttendees: string[] = tasks[taskIndex]?.attendees ?? [];
          const groupId = mkId();
          const isRecurringSuggestion = events.some((e: any) => Array.isArray(e.recurrence) && e.recurrence.length > 0);
          const visualBlocks: any[] = isRecurringSuggestion && events.length === 1
            ? expandRecurringPreview(events[0], 8)
            : events;
          pendingSlotMap.current.set(groupId, { slotIndex: suggestion.rank - 1, events, attendeeEmails: taskAttendees, isMultiTask: true, taskIndex });
          const blockColor = TASK_COLORS[taskIndex % TASK_COLORS.length];
          const baseTitle = visualBlocks[0]?.title ?? events[0]?.title ?? '';
          const taskLabel = suggestion.task_name ? `${suggestion.task_name} #${suggestion.rank}` : `#${suggestion.rank} ${baseTitle}`;
          visualBlocks.forEach((event: any, i: number) => {
            const pendingId = mkId();
            pendingSessionToGroup.current.set(pendingId, groupId);
            toAdd.push({
              id: pendingId,
              title: i === 0 ? taskLabel : event.title ?? '',
              description: event.description ?? '',
              date: event.date,
              dayIndex: new Date(event.date + 'T00:00:00').getDay(),
              startHour: event.startHour,
              startMin: event.startMin,
              durationMins: event.durationMins,
              color: blockColor,
              pending: true,
              pendingGroupId: groupId,
              pendingShowActions: i === 0,
              recurrence: event.recurrence ?? [],
            });
          });
        }
        setSessions(prev => [...prev.filter(s => !s.pending), ...toAdd]);
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
                recurrence: e.recurrence ?? [],
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
              color: e.color ?? sessions.find(s => s.id === id)?.color ?? '#FF1493',
              recurrence: e.recurrence ?? [],
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
          color: e.color ?? sessions.find(s => s.id === id)?.color ?? '#FF1493',
          recurrence: e.recurrence ?? [],
        });
      }
    }

    if (info.isMultiTask) {
      // Multi-task: remove ALL alternatives for the same task (same taskIndex), keep other tasks
      const acceptedTaskIndex = info.taskIndex ?? 0;
      const removedGroupIds = new Set<string>();
      Array.from(pendingSlotMap.current.entries()).forEach(([gid, gInfo]) => {
        if ((gInfo.taskIndex ?? 0) === acceptedTaskIndex) removedGroupIds.add(gid);
      });
      removedGroupIds.forEach(gid => pendingSlotMap.current.delete(gid));
      Array.from(pendingSessionToGroup.current.entries()).forEach(([sid, gid]) => {
        if (removedGroupIds.has(gid)) pendingSessionToGroup.current.delete(sid);
      });
      setSessions(prev => {
        const withoutThisTask = prev.filter(s => !s.pendingGroupId || !removedGroupIds.has(s.pendingGroupId));
        return [...withoutThisTask, ...newRows];
      });
    } else {
      // Single-task: allow mixing and matching options by only removing the accepted group.
      pendingSlotMap.current.delete(groupId);
      Array.from(pendingSessionToGroup.current.entries()).forEach(([sid, gid]) => {
        if (gid === groupId) pendingSessionToGroup.current.delete(sid);
      });
      setSessions(prev => {
        const withoutAcceptedGroup = prev.filter(s => (s.pendingGroupId ?? s.id) !== groupId);
        return [...withoutAcceptedGroup, ...newRows];
      });
    }

    // If any accepted event has recurrence, resync to load all expanded instances
    if (info.events.some((e: any) => (e.recurrence ?? []).length > 0)) {
      fetchEvents();
    }
  }

  async function handleAcceptAll() {
    const groups = Array.from(pendingSlotMap.current.entries());
    if (groups.length === 0) return;

    const stripRank = (t: string) => t.replace(/^#\d+\s+/, '');
    const emailQ = userEmail ? `?email=${encodeURIComponent(userEmail)}` : '';
    const allNewRows: Session[] = [];

    for (const [, info] of groups) {
      try {
        await fetch(`${ANALYTICS_API}/feedback`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ slot_index: info.slotIndex, feedback: 'accepted' }),
        });
      } catch { /* non-critical */ }

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
                recurrence: e.recurrence ?? [],
                attendees: info.attendeeEmails?.length ? [userEmail, ...info.attendeeEmails].filter(Boolean) : [],
              }),
            });
            const d = await res.json();
            allNewRows.push({
              id: d.event?.id ?? mkId(),
              title: stripRank(e.title ?? ''),
              description: e.description ?? '',
              date: e.date,
              dayIndex: new Date(e.date + 'T00:00:00').getDay(),
              startHour: e.startHour,
              startMin: e.startMin,
              durationMins: e.durationMins,
              color: e.color ?? '#FF1493',
              recurrence: e.recurrence ?? [],
            });
            continue;
          } catch { /* fall through to local */ }
        }
        const tid = mkId();
        localIds.current.add(tid);
        allNewRows.push({
          id: tid,
          title: stripRank(e.title ?? ''),
          description: e.description ?? '',
          date: e.date,
          dayIndex: new Date(e.date + 'T00:00:00').getDay(),
          startHour: e.startHour,
          startMin: e.startMin,
          durationMins: e.durationMins,
          color: e.color ?? '#FF1493',
          recurrence: e.recurrence ?? [],
        });
      }
    }

    setSessions(prev => [...prev.filter(s => !s.pending), ...allNewRows]);
    pendingSlotMap.current.clear();
    pendingSessionToGroup.current.clear();

    if (groups.some(([, info]) => info.events.some((e: any) => (e.recurrence ?? []).length > 0))) {
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

  function handleRejectAll() {
    const groups = Array.from(pendingSlotMap.current.entries());
    for (const [, info] of groups) {
      fetch(`${ANALYTICS_API}/feedback`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ slot_index: info.slotIndex, feedback: 'rejected' }),
      }).catch(() => {});
    }
    pendingSlotMap.current.clear();
    pendingSessionToGroup.current.clear();
    setSessions(prev => prev.filter(s => !s.pending));
    setMessages(m => [...m, {
      id: mkId(),
      role: 'assistant',
      text: "No problem! Let me know what didn't work — for example, different times of day, specific days to avoid, a shorter or longer session, or any other preferences — and I'll suggest better options.",
    }]);
    if (!chatOpen) setChatOpen(true);
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
              background: refreshing ? '#ccc' : '#FF1493',
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
          onSendMultiTask={handleSendMultiTask}
          mentionSearchEndpoint={`${ANALYTICS_API}/users/search`}
          currentUserEmail={userEmail}
          isLoading={chatLoading}
          onStop={handleStopChat}
          onReset={handleRestartChat}
          onClose={() => setChatOpen(false)}
          extraActions={sessions.some(s => s.pending) ? (
            <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
              <button
                onClick={handleAcceptAll}
                style={{
                  width: '100%',
                  padding: '0.45rem 0.75rem',
                  background: '#1a7a1a',
                  color: '#fff',
                  border: 'none',
                  borderRadius: '6px',
                  fontWeight: 600,
                  fontSize: '0.85rem',
                  cursor: 'pointer',
                }}
              >
                Accept All Suggestions
              </button>
              <button
                onClick={handleRejectAll}
                style={{
                  width: '100%',
                  padding: '0.45rem 0.75rem',
                  background: '#fff',
                  color: '#d93025',
                  border: '1px solid #d93025',
                  borderRadius: '6px',
                  fontWeight: 600,
                  fontSize: '0.85rem',
                  cursor: 'pointer',
                }}
              >
                Reject All Suggestions
              </button>
            </div>
          ) : undefined}
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
            color: '#FF1493',
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
