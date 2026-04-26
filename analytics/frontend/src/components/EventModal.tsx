import { useState, useRef, useEffect } from 'react';
import { Session, LocationType, CalendarMeta, AddressSearch, detectLocationType, getDefaultTimezone, TIMEZONES } from './WeekCalendar';
import { ReflectionEntry } from './ReflectionPanel';

const FACES = [
  { score: 1, emoji: '😞', label: 'Not productive' },
  { score: 2, emoji: '😕', label: 'Slightly unproductive' },
  { score: 3, emoji: '😐', label: 'Neutral' },
  { score: 4, emoji: '🙂', label: 'Productive' },
  { score: 5, emoji: '😄', label: 'Very productive' },
];

const SESSION_LENGTH_OPTIONS: { value: 'too_short' | 'just_right' | 'too_long'; label: string }[] = [
  { value: 'too_short', label: 'Too short' },
  { value: 'just_right', label: 'Just right' },
  { value: 'too_long', label: 'Too long' },
];

const TIMING_OPTIONS: { value: 'too_early' | 'good_timing' | 'too_late'; label: string }[] = [
  { value: 'too_early', label: 'Too early' },
  { value: 'good_timing', label: 'Good timing' },
  { value: 'too_late', label: 'Too late' },
];

const BREAKS_OPTIONS: { value: 'too_many' | 'just_right' | 'too_few'; label: string }[] = [
  { value: 'too_many', label: 'Too many breaks' },
  { value: 'just_right', label: 'Just right' },
  { value: 'too_few', label: 'Too few breaks' },
];

const DAYS_LONG = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];
const DAYS_SHORT = ['SU', 'MO', 'TU', 'WE', 'TH', 'FR', 'SA'];

function buildRrule(key: string, date: string): string[] {
  if (key === 'none') return [];
  if (key === 'daily') return ['RRULE:FREQ=DAILY'];
  if (key === 'weekly') {
    const dow = DAYS_SHORT[new Date(date + 'T12:00:00').getDay()];
    return [`RRULE:FREQ=WEEKLY;BYDAY=${dow}`];
  }
  if (key === 'weekdays') return ['RRULE:FREQ=WEEKLY;BYDAY=MO,TU,WE,TH,FR'];
  if (key === 'biweekly') {
    const dow = DAYS_SHORT[new Date(date + 'T12:00:00').getDay()];
    return [`RRULE:FREQ=WEEKLY;INTERVAL=2;BYDAY=${dow}`];
  }
  if (key === 'monthly') return ['RRULE:FREQ=MONTHLY'];
  return [];
}

function rruleToKey(recurrence?: string[]): string {
  if (!recurrence || recurrence.length === 0) return 'none';
  const r = recurrence[0].toUpperCase();
  if (r.includes('FREQ=DAILY')) return 'daily';
  if (r.includes('FREQ=MONTHLY')) return 'monthly';
  if (r.includes('FREQ=WEEKLY') && r.includes('INTERVAL=2')) return 'biweekly';
  if (r.includes('BYDAY=MO,TU,WE,TH,FR')) return 'weekdays';
  if (r.includes('FREQ=WEEKLY')) return 'weekly';
  return 'none';
}

const COLOR_PALETTE = [
  '#4285f4', '#ea4335', '#34a853', '#fbbc04',
  '#9c27b0', '#00acc1', '#e91e63', '#ff6d00',
  '#607d8b', '#795548',
];

function pad2(n: number) { return String(n).padStart(2, '0'); }
function toTimeStr(h: number, m: number) { return `${pad2(h)}:${pad2(m)}`; }
function addMinsStr(t: string, mins: number) {
  const [h, m] = t.split(':').map(Number);
  const total = Math.min(23 * 60 + 59, h * 60 + m + mins);
  return `${pad2(Math.floor(total / 60))}:${pad2(total % 60)}`;
}
function diffMinsStr(start: string, end: string) {
  const [sh, sm] = start.split(':').map(Number);
  const [eh, em] = end.split(':').map(Number);
  return Math.max(0, eh * 60 + em - (sh * 60 + sm));
}
function fmtDisplay(h: number, m: number) {
  return `${h % 12 || 12}:${pad2(m)} ${h < 12 ? 'AM' : 'PM'}`;
}
function fmtTime(hhmm: string) {
  const [h, m] = hhmm.split(':').map(Number);
  return fmtDisplay(h, m);
}

// Times from 12:00 AM to 11:45 PM in 15-min steps
const TIME_OPTIONS: string[] = [];
for (let h = 0; h < 24; h++) {
  for (let m = 0; m < 60; m += 15) {
    TIME_OPTIONS.push(toTimeStr(h, m));
  }
}

interface TimePickerProps {
  value: string;           // HH:MM
  onChange: (v: string) => void;
  label: string;
  minTime?: string;        // optional minimum (for end-time constraint)
}

function parseTimeInput(text: string): string | null {
  const s = text.trim().toLowerCase();
  let isPm: boolean | null = null;
  let rest = s;
  if (rest.endsWith('pm')) { isPm = true; rest = rest.slice(0, -2).trim(); }
  else if (rest.endsWith('am')) { isPm = false; rest = rest.slice(0, -2).trim(); }

  let h: number, m = 0;
  if (rest.includes(':')) {
    const parts = rest.split(':');
    h = parseInt(parts[0]);
    m = parseInt(parts[1]) || 0;
  } else {
    const digits = rest.replace(/\D/g, '');
    if (!digits.length) return null;
    if (digits.length <= 2) { h = parseInt(digits); }
    else if (digits.length === 3) { h = parseInt(digits[0]); m = parseInt(digits.slice(1)); }
    else { h = parseInt(digits.slice(0, 2)); m = parseInt(digits.slice(2, 4)); }
  }

  if (isNaN(h) || isNaN(m) || m < 0 || m > 59) return null;
  if (isPm === true && h !== 12) h += 12;
  else if (isPm === false && h === 12) h = 0;
  if (h < 0 || h > 23) return null;
  return toTimeStr(h, m);
}

function TimePickerInput({ value, onChange, label, minTime }: TimePickerProps) {
  const [open, setOpen] = useState(false);
  const [inputText, setInputText] = useState(() => fmtTime(value));
  const wrapRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLInputElement>(null);
  const highlightRef = useRef<HTMLLIElement>(null);

  // Keep a stable ref to the latest commit logic so the outside-click effect never goes stale
  const commitRef = useRef<() => void>(() => {});
  commitRef.current = () => {
    const parsed = parseTimeInput(inputText);
    if (parsed && (!minTime || parsed > minTime)) {
      onChange(parsed);
      setInputText(fmtTime(parsed));
    } else {
      setInputText(fmtTime(value));
    }
    setOpen(false);
  };

  // Sync display text when value changes externally (not while user is editing)
  useEffect(() => {
    if (!open) setInputText(fmtTime(value));
  }, [value, open]);

  // Close + commit on outside click
  useEffect(() => {
    if (!open) return;
    function onDown(e: MouseEvent) {
      if (wrapRef.current && !wrapRef.current.contains(e.target as Node)) {
        commitRef.current();
      }
    }
    document.addEventListener('mousedown', onDown);
    return () => document.removeEventListener('mousedown', onDown);
  }, [open]);

  // Scroll highlighted option into view whenever it changes
  useEffect(() => {
    if (open && highlightRef.current) {
      highlightRef.current.scrollIntoView({ block: 'nearest' });
    }
  });

  const options = minTime ? TIME_OPTIONS.filter(t => t > minTime) : TIME_OPTIONS;

  // Nearest option to whatever the user has typed (for highlight + auto-scroll)
  const parsedInput = parseTimeInput(inputText);
  const highlightedOption = parsedInput
    ? (options.find(t => t >= parsedInput) ?? options[options.length - 1])
    : (options.find(t => t === value) ?? options[0]);

  return (
    <div ref={wrapRef} style={{ position: 'relative' }}>
      <label style={{ display: 'block', fontSize: '12px', color: '#5f6368', fontWeight: 500, marginBottom: '4px' }}>
        {label}
      </label>
      <input
        ref={inputRef}
        type="text"
        value={inputText}
        onChange={e => { setInputText(e.target.value); setOpen(true); }}
        onFocus={() => { setOpen(true); setTimeout(() => inputRef.current?.select(), 0); }}
        onKeyDown={e => {
          if (e.key === 'Enter') { e.preventDefault(); commitRef.current(); }
          else if (e.key === 'Tab') { commitRef.current(); }
          else if (e.key === 'Escape') { setInputText(fmtTime(value)); setOpen(false); }
        }}
        style={{
          width: '100%',
          padding: '8px 10px',
          border: `1px solid ${open ? '#1a73e8' : '#dadce0'}`,
          borderRadius: '4px',
          fontSize: '14px',
          color: '#202124',
          outline: 'none',
          transition: 'border-color 0.15s',
          boxSizing: 'border-box',
        }}
      />

      {open && (
        <ul
          style={{
            position: 'absolute',
            top: 'calc(100% + 4px)',
            left: 0,
            zIndex: 999,
            background: '#fff',
            border: '1px solid #dadce0',
            borderRadius: '8px',
            boxShadow: '0 4px 16px rgba(0,0,0,0.15)',
            margin: 0,
            padding: '4px 0',
            listStyle: 'none',
            width: '140px',
            maxHeight: '220px',
            overflowY: 'auto',
          }}
        >
          {options.map(t => {
            const isHighlighted = t === highlightedOption;
            return (
              <li
                key={t}
                ref={isHighlighted ? highlightRef : undefined}
                // preventDefault keeps the input focused so blur doesn't fire
                onMouseDown={e => { e.preventDefault(); onChange(t); setInputText(fmtTime(t)); setOpen(false); }}
                style={{
                  padding: '7px 14px',
                  fontSize: '13.5px',
                  cursor: 'pointer',
                  background: isHighlighted ? '#e8f0fe' : 'transparent',
                  color: isHighlighted ? '#1a73e8' : '#202124',
                  fontWeight: isHighlighted ? 600 : 400,
                  borderRadius: '4px',
                  margin: '0 4px',
                  transition: 'background 0.1s',
                }}
                onMouseEnter={e => {
                  if (!isHighlighted) (e.currentTarget as HTMLElement).style.background = '#f1f3f4';
                }}
                onMouseLeave={e => {
                  if (!isHighlighted) (e.currentTarget as HTMLElement).style.background = 'transparent';
                }}
              >
                {fmtTime(t)}
              </li>
            );
          })}
        </ul>
      )}
    </div>
  );
}

// Convert Google-Calendar-style HTML descriptions into plain text so the
// textarea shows readable content instead of raw <br>, <a href="…">, etc.
function stripHtml(raw: string): string {
  if (!raw) return '';
  const normalized = raw
    .replace(/<br\s*\/?>/gi, '\n')
    .replace(/<\/(p|div|li|h[1-6])>/gi, '\n')
    .replace(/<[^>]+>/g, '');
  // Decode HTML entities (e.g. &amp;, &nbsp;, &#39;) via the browser.
  const el = document.createElement('textarea');
  el.innerHTML = normalized;
  return el.value.replace(/\n{3,}/g, '\n\n').trim();
}

interface Props {
  session: Session;
  reflections: ReflectionEntry[];
  categories?: string[];
  onAddCategory?: (cat: string) => void;
  onDeleteCategory?: (cat: string) => void;
  calendars?: CalendarMeta[];
  onClose: () => void;
  onSave: (id: string, s: Omit<Session, 'id'>) => void;
  onDelete: (id: string) => void;
  onDeleteSeries?: (recurringEventId: string) => void;
  onSaveReflection: (entry: Omit<ReflectionEntry, 'id' | 'savedAt'>) => void;
}

export default function EventModal({ session, reflections, categories = [], onAddCategory, onDeleteCategory, calendars = [], onClose, onSave, onDelete, onDeleteSeries, onSaveReflection }: Props) {
  const isNew = session.id === '__new__';
  const initStart = toTimeStr(session.startHour, session.startMin);
  const initEnd = addMinsStr(initStart, session.durationMins);

  const [title, setTitle] = useState(session.title);
  const [location, setLocation] = useState(session.location ?? '');
  const [locationType, setLocationType] = useState<LocationType>(
    session.locationType ?? detectLocationType(session.location ?? '')
  );
  const [timezone, setTimezone] = useState(session.timezone ?? getDefaultTimezone());
  const [description, setDescription] = useState(stripHtml(session.description ?? ''));
  const [calendarId, setCalendarId] = useState(session.calendarId ?? 'primary');
  const [visibility, setVisibility] = useState(session.visibility ?? 'default');
  const [date, setDate] = useState(session.date);
  const [startTime, setStartTime] = useState(initStart);
  const [endTime, setEndTime] = useState(initEnd);
  const [color, setColor] = useState(session.color);
  const [category, setCategory] = useState(session.category ?? '');
  const [showNewCat, setShowNewCat] = useState(false);
  const [newCatInput, setNewCatInput] = useState('');
  const [editSaved, setEditSaved] = useState(false);
  const [recurrenceKey, setRecurrenceKey] = useState<string>(() => rruleToKey(session.recurrence));
  const [moreInfoOpen, setMoreInfoOpen] = useState(false);
  const moreInfoRef = useRef<HTMLDivElement | null>(null);

  const [productivity, setProductivity] = useState<number | null>(null);
  const [sessionLength, setSessionLength] = useState<'too_short' | 'just_right' | 'too_long' | null>(null);
  const [timing, setTiming] = useState<'too_early' | 'good_timing' | 'too_late' | null>(null);
  const [breaks, setBreaks] = useState<'too_many' | 'just_right' | 'too_few' | null>(null);
  const [reflText, setReflText] = useState('');
  const [reflSaved, setReflSaved] = useState(false);

  // Fetch base event's recurrence rule when this is a recurring instance (instances don't carry the RRULE)
  useEffect(() => {
    if (!session.recurringEventId || (session.recurrence && session.recurrence.length > 0)) return;
    fetch(
      `${process.env.REACT_APP_CALENDAR_API ?? 'http://localhost:8000'}/calendar/events/${session.recurringEventId}?calendarId=${encodeURIComponent(session.calendarId ?? 'primary')}`,
      { credentials: 'include' },
    )
      .then(r => (r.ok ? r.json() : null))
      .then(data => {
        const rule = rruleToKey(data?.event?.recurrence);
        if (rule !== 'none') setRecurrenceKey(rule);
      })
      .catch(() => {});
  }, [session.id, session.recurringEventId]);

  // When "More Info" expands, scroll the left column so the newly revealed
  // fields come into view. We wait one frame so the expanded panel is laid out.
  useEffect(() => {
    if (!moreInfoOpen) return;
    requestAnimationFrame(() => {
      moreInfoRef.current?.scrollIntoView({ behavior: 'smooth', block: 'start' });
    });
  }, [moreInfoOpen]);

  const [lastId, setLastId] = useState(session.id);
  if (session.id !== lastId) {
    setLastId(session.id);
    const s = toTimeStr(session.startHour, session.startMin);
    setTitle(session.title);
    setLocation(session.location ?? '');
    setLocationType(session.locationType ?? detectLocationType(session.location ?? ''));
    setTimezone(session.timezone ?? getDefaultTimezone());
    setDescription(stripHtml(session.description ?? ''));
    setCalendarId(session.calendarId ?? 'primary');
    setVisibility(session.visibility ?? 'default');
    setDate(session.date);
    setStartTime(s);
    setEndTime(addMinsStr(s, session.durationMins));
    setColor(session.color);
    setCategory(session.category ?? '');
    setShowNewCat(false);
    setNewCatInput('');
    setEditSaved(false);
    setRecurrenceKey(rruleToKey(session.recurrence));  // will be overridden by fetch below if it's a recurring instance
    setMoreInfoOpen(false);
    setProductivity(null);
    setSessionLength(null);
    setTiming(null);
    setBreaks(null);
    setReflText('');
    setReflSaved(false);
  }

  const sessionReflections = reflections.filter(r => r.sessionId === session.id);

  function handleStartChange(t: string) {
    const dur = diffMinsStr(startTime, endTime);
    setStartTime(t);
    setEndTime(addMinsStr(t, dur));
  }

  function doSaveEdit() {
    const [h, m] = startTime.split(':').map(Number);
    onSave(session.id, {
      title: title.trim() || session.title,
      description,
      location: location || undefined,
      locationType: location ? locationType : undefined,
      timezone: timezone || getDefaultTimezone(),
      calendarId: calendarId || 'primary',
      visibility: visibility || 'default',
      date,
      dayIndex: new Date(date + 'T12:00:00').getDay(),
      startHour: h,
      startMin: m,
      durationMins: Math.max(1, diffMinsStr(startTime, endTime)),
      color,
      recurrence: buildRrule(recurrenceKey, date),
      category: category || undefined,
    });
  }

  function doSaveReflection() {
    if (!productivity) return;
    onSaveReflection({
      sessionId: session.id,
      title: title.trim() || session.title,
      description,
      location: location || undefined,
      date,
      startTime,
      endTime,
      productivity,
      reflectionText: reflText.trim(),
      sessionLengthFeedback: sessionLength ?? undefined,
      timingFeedback: timing ?? undefined,
      breaksFeedback: breaks ?? undefined,
    });
  }

  function handleSaveEdit() {
    doSaveEdit();
    doSaveReflection();
    onClose();
  }

  function handleSaveReflection() {
    if (!productivity) return;
    doSaveEdit();
    doSaveReflection();
    setReflSaved(true);
    setReflText('');
    setProductivity(null);
    setSessionLength(null);
    setTiming(null);
    setBreaks(null);
    onClose();
  }

  const pillBtn = (selected: boolean): React.CSSProperties => ({
    padding: '5px 12px',
    borderRadius: '999px',
    fontSize: '12.5px',
    cursor: 'pointer',
    fontWeight: 500,
    border: selected ? '1.5px solid #4285f4' : '1.5px solid #dadce0',
    background: selected ? '#e8f0fe' : '#f8f9fa',
    color: selected ? '#1a73e8' : '#5f6368',
    transition: 'all 0.12s',
    whiteSpace: 'nowrap' as const,
  });

  const sectionLabel: React.CSSProperties = {
    fontSize: '11px',
    fontWeight: 600,
    color: '#80868b',
    textTransform: 'uppercase',
    letterSpacing: '0.06em',
    marginBottom: '10px',
  };

  return (
    <div className="modal-overlay" onClick={onClose}>
      <div
        onClick={e => e.stopPropagation()}
        style={{
          background: '#fff',
          borderRadius: '12px',
          boxShadow: '0 8px 40px rgba(0,0,0,0.18)',
          width: '900px',
          maxWidth: '96vw',
          maxHeight: '92vh',
          overflow: 'hidden',
          display: 'flex',
          flexDirection: 'column',
        }}
      >
        {/* Header */}
        <div style={{
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'space-between',
          padding: '14px 20px 12px',
          borderBottom: `3px solid ${color}`,
          flexShrink: 0,
        }}>
          <div>
            {isNew ? (
              <div style={{ fontWeight: 700, fontSize: '1rem', color: '#202124' }}>New Event</div>
            ) : (
              <>
                <div style={{ display: 'flex', alignItems: 'center', gap: '8px' }}>
                  <div style={{ fontWeight: 700, fontSize: '1rem', color: '#202124' }}>{session.title}</div>
                  {(session.recurringEventId || (session.recurrence && session.recurrence.length > 0)) && (
                    <span style={{
                      fontSize: '11px',
                      fontWeight: 600,
                      color: '#1a73e8',
                      background: '#e8f0fe',
                      borderRadius: '10px',
                      padding: '2px 8px',
                      whiteSpace: 'nowrap',
                    }}>↻ Repeating</span>
                  )}
                </div>
                <div style={{ fontSize: '12px', color: '#5f6368', marginTop: '2px' }}>
                  {session.date}&nbsp;&nbsp;·&nbsp;&nbsp;
                  {fmtDisplay(session.startHour, session.startMin)}
                  {' – '}
                  {fmtDisplay(
                    Math.floor((session.startHour * 60 + session.startMin + session.durationMins) / 60) % 24,
                    (session.startMin + session.durationMins) % 60,
                  )}
                </div>
                {(() => {
                  const others = (session.attendees ?? []).filter(a => !a.self);
                  if (others.length === 0) return null;
                  return (
                    <div style={{ display: 'flex', flexWrap: 'wrap', gap: '6px', marginTop: '6px' }}>
                      {others.map(a => (
                        <span
                          key={a.email}
                          title={a.email}
                          style={{
                            display: 'inline-flex',
                            alignItems: 'center',
                            gap: '4px',
                            fontSize: '11px',
                            color: '#3c4043',
                            background: '#f1f3f4',
                            borderRadius: '12px',
                            padding: '2px 8px',
                            fontWeight: 500,
                          }}
                        >
                          <span style={{ fontSize: '10px' }}>👤</span>
                          {a.displayName || a.email}
                        </span>
                      ))}
                    </div>
                  );
                })()}
              </>
            )}
          </div>
          <button
            onClick={onClose}
            style={{ background: 'none', border: 'none', fontSize: '18px', cursor: 'pointer', color: '#80868b', lineHeight: 1, padding: '4px 6px', borderRadius: '4px' }}
          >✕</button>
        </div>

        {/* Two columns */}
        <div style={{ display: 'flex', flex: 1, overflow: 'hidden', minHeight: 0 }}>

          {/* ── Left: Edit ── */}
          <div style={{
            flex: '0 0 500px',
            padding: '20px 24px',
            overflowY: 'auto',
            borderRight: '1px solid #e8eaed',
            display: 'flex',
            flexDirection: 'column',
            gap: '14px',
          }}>
            {/* Title */}
            <div className="modal-field">
              <label>Title</label>
              <input value={title} onChange={e => setTitle(e.target.value)} placeholder="Event title" />
            </div>

            <div className="modal-field">
              <label>Date</label>
              <input type="date" value={date} onChange={e => setDate(e.target.value)} />
            </div>

            {/* Time row — Google Calendar style pickers */}
            <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: '10px' }}>
              <TimePickerInput
                label="Start"
                value={startTime}
                onChange={handleStartChange}
              />
              <TimePickerInput
                label="End"
                value={endTime}
                onChange={setEndTime}
                minTime={startTime}
              />
            </div>

            <div className="modal-field">
              <label>Location</label>
              <div style={{ display: 'flex', gap: '0.3rem', alignItems: 'center' }}>
                {locationType === 'address' ? (
                  <AddressSearch value={location} onChange={setLocation} wrapperStyle={{ flex: 1 }} />
                ) : (
                  <div style={{ flex: 1 }}>
                    <input
                      value={location}
                      onChange={e => setLocation(e.target.value)}
                      placeholder={locationType === 'meeting_link' ? 'Paste meeting link…' : 'Room, building, or anywhere'}
                      style={{ width: '100%', boxSizing: 'border-box' }}
                    />
                    {locationType === 'meeting_link' && /^https?:\/\//i.test(location) && (
                      <a
                        href={location}
                        target="_blank"
                        rel="noopener noreferrer"
                        style={{ display: 'block', marginTop: '0.25rem', fontSize: '0.76rem', color: '#1a73e8', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}
                      >↗ {location}</a>
                    )}
                  </div>
                )}
                <div style={{ display: 'flex', gap: '0.25rem', flexShrink: 0, alignSelf: 'flex-start' }}>
                  {([['room', '🏠', 'Room'], ['meeting_link', '🔗', 'Meeting link'], ['address', '📍', 'Address']] as [LocationType, string, string][]).map(([type, icon, ttl]) => (
                    <button
                      key={type}
                      type="button"
                      title={ttl}
                      onClick={() => setLocationType(type)}
                      style={{
                        width: '36px', height: '36px', borderRadius: '8px', fontSize: '1.05rem',
                        cursor: 'pointer', flexShrink: 0,
                        border: locationType === type ? '1.5px solid #4285f4' : '1.5px solid #e0e0e0',
                        background: locationType === type ? '#e8f0fe' : '#f8f9fa',
                        display: 'flex', alignItems: 'center', justifyContent: 'center',
                        transition: 'border-color 0.15s, background 0.15s',
                      }}
                    >{icon}</button>
                  ))}
                </div>
              </div>
            </div>

            {/* Recurrence */}
            <div className="modal-field">
              <label>Repeat</label>
              <select
                value={recurrenceKey}
                onChange={e => setRecurrenceKey(e.target.value)}
                style={{
                  width: '100%',
                  padding: '8px 10px',
                  border: '1px solid #dadce0',
                  borderRadius: '4px',
                  fontSize: '14px',
                  color: '#202124',
                  background: '#fff',
                  outline: 'none',
                  cursor: 'pointer',
                }}
              >
                <option value="none">Does not repeat</option>
                <option value="daily">Every day</option>
                <option value="weekly">Every week on {DAYS_LONG[new Date(date + 'T12:00:00').getDay()]}</option>
                <option value="weekdays">Every weekday (Mon – Fri)</option>
                <option value="biweekly">Every 2 weeks on {DAYS_LONG[new Date(date + 'T12:00:00').getDay()]}</option>
                <option value="monthly">Every month</option>
              </select>
            </div>

            {/* Color */}
            <div className="modal-field">
              <label>Color</label>
              <div className="color-palette" style={{ marginTop: '4px' }}>
                {COLOR_PALETTE.map(c => (
                  <button key={c} className={`color-swatch ${color === c ? 'selected' : ''}`} style={{ background: c }} onClick={() => setColor(c)} />
                ))}
              </div>
            </div>

            {/* Actions */}
            <div style={{ display: 'flex', gap: '8px', paddingTop: '4px', flexWrap: 'wrap' }}>
              <button className="btn-save" onClick={handleSaveEdit} disabled={!title.trim()}>
                {isNew ? 'Add Session' : (editSaved ? '✓ Saved' : 'Save Changes')}
              </button>
              {!isNew && (
                <button
                  onClick={() => { onDelete(session.id); onClose(); }}
                  style={{ background: '#fce8e6', color: '#c5221f', border: 'none', borderRadius: '6px', padding: '8px 14px', cursor: 'pointer', fontWeight: 500, fontSize: '13px' }}
                >
                  Delete
                </button>
              )}
              {!isNew && onDeleteSeries && session.recurringEventId && (
                <button
                  onClick={() => { onDeleteSeries(session.recurringEventId!); onClose(); }}
                  style={{ background: '#fce8e6', color: '#c5221f', border: 'none', borderRadius: '6px', padding: '8px 14px', cursor: 'pointer', fontWeight: 500, fontSize: '13px' }}
                >
                  Delete All Repeating Events
                </button>
              )}
            </div>

            {/* More Info collapsible — at the bottom so it never shifts the Save button */}
            <div ref={moreInfoRef} style={{ scrollMarginTop: '8px' }}>
              <button
                type="button"
                onClick={() => setMoreInfoOpen(o => !o)}
                style={{
                  display: 'flex',
                  alignItems: 'center',
                  gap: '6px',
                  background: 'none',
                  border: '1px solid #dadce0',
                  borderRadius: '6px',
                  padding: '6px 12px',
                  fontSize: '13px',
                  fontWeight: 500,
                  color: '#5f6368',
                  cursor: 'pointer',
                  width: '100%',
                  justifyContent: 'space-between',
                  transition: 'background 0.12s',
                }}
                onMouseEnter={e => (e.currentTarget.style.background = '#f1f3f4')}
                onMouseLeave={e => (e.currentTarget.style.background = 'none')}
              >
                <span>More Info</span>
                <span style={{ fontSize: '10px', transition: 'transform 0.15s', display: 'inline-block', transform: moreInfoOpen ? 'rotate(180deg)' : 'rotate(0deg)' }}>▼</span>
              </button>

              {moreInfoOpen && (
                <div style={{ display: 'flex', flexDirection: 'column', gap: '14px', marginTop: '12px', paddingTop: '12px', borderTop: '1px solid #f1f3f4' }}>
                  {/* Category */}
                  <div className="modal-field">
                    <label>Category</label>
                    <div style={{ display: 'flex', flexWrap: 'wrap', gap: '5px', marginTop: '4px' }}>
                      <button type="button" onClick={() => setCategory('')} style={pillBtn(category === '')}>None</button>
                      {categories.map((c: string) => (
                        <span key={c} style={{ display: 'inline-flex', alignItems: 'center', gap: '2px' }}>
                          <button type="button" onClick={() => setCategory(c)} style={pillBtn(category === c)}>{c}</button>
                          <button
                            type="button"
                            title={`Delete "${c}"`}
                            onClick={() => { onDeleteCategory?.(c); if (category === c) setCategory(''); }}
                            style={{ background: 'none', border: 'none', cursor: 'pointer', color: '#bbb', fontSize: '10px', padding: '0', lineHeight: 1 }}
                          >✕</button>
                        </span>
                      ))}
                      {!showNewCat ? (
                        <button type="button" onClick={() => setShowNewCat(true)}
                          style={{ ...pillBtn(false), border: '1.5px dashed #bdc1c6', background: 'none' }}>
                          + Add
                        </button>
                      ) : (
                        <div style={{ display: 'flex', gap: '4px', alignItems: 'center', width: '100%', marginTop: '2px' }}>
                          <input
                            autoFocus
                            value={newCatInput}
                            onChange={e => setNewCatInput(e.target.value)}
                            placeholder="Category name"
                            style={{ flex: 1, fontSize: '12px', padding: '4px 8px', border: '1px solid #dadce0', borderRadius: '4px', outline: 'none' }}
                            onKeyDown={e => {
                              if (e.key === 'Enter' && newCatInput.trim()) {
                                onAddCategory?.(newCatInput.trim()); setCategory(newCatInput.trim()); setNewCatInput(''); setShowNewCat(false);
                              } else if (e.key === 'Escape') { setNewCatInput(''); setShowNewCat(false); }
                            }}
                          />
                          <button type="button" className="btn-save" style={{ padding: '4px 10px', fontSize: '12px' }}
                            onClick={() => { if (newCatInput.trim()) { onAddCategory?.(newCatInput.trim()); setCategory(newCatInput.trim()); setNewCatInput(''); setShowNewCat(false); } }}>
                            Add
                          </button>
                          <button type="button" onClick={() => { setNewCatInput(''); setShowNewCat(false); }}
                            style={{ background: 'none', border: 'none', cursor: 'pointer', color: '#aaa', fontSize: '14px' }}>✕</button>
                        </div>
                      )}
                    </div>
                  </div>

                  <div className="modal-field">
                    <label>Description</label>
                    <textarea
                      className="modal-textarea"
                      value={description}
                      onChange={e => setDescription(e.target.value)}
                      placeholder=""
                      rows={4}
                    />
                  </div>

                  <div className="modal-field">
                    <label>Timezone</label>
                    <input
                      list="tz-list-edit"
                      value={timezone}
                      onChange={e => setTimezone(e.target.value)}
                      placeholder="e.g. America/New_York"
                    />
                    <datalist id="tz-list-edit">
                      {TIMEZONES.map(tz => <option key={tz} value={tz} />)}
                    </datalist>
                  </div>
                </div>
              )}
            </div>
          </div>

          {/* ── Right: Reflect ── */}
          <div style={{
            flex: 1,
            padding: '20px 24px',
            overflowY: 'auto',
            display: 'flex',
            flexDirection: 'column',
            gap: '14px',
          }}>
            <div style={sectionLabel}>Session Reflection</div>

            {/* Productivity */}
            <div>
              <div style={{ fontSize: '12px', color: '#5f6368', marginBottom: '8px' }}>How productive were you?</div>
              <div className="productivity-scale">
                {FACES.map(f => (
                  <button key={f.score} className={`face-btn ${productivity === f.score ? 'selected' : ''}`} onClick={() => setProductivity(f.score)} title={f.label}>
                    <span className="face-emoji">{f.emoji}</span>
                    <span className="face-score">{f.score}</span>
                  </button>
                ))}
              </div>
              {productivity !== null && (
                <div className="productivity-label" style={{ marginTop: '4px' }}>{FACES[productivity - 1].label}</div>
              )}
            </div>

            {/* MCQ row: session length */}
            <div>
              <div style={{ fontSize: '12px', color: '#5f6368', marginBottom: '6px' }}>Was the session length right?</div>
              <div style={{ display: 'flex', gap: '6px', flexWrap: 'wrap' }}>
                {SESSION_LENGTH_OPTIONS.map(opt => (
                  <button key={opt.value} onClick={() => setSessionLength(sessionLength === opt.value ? null : opt.value)} style={pillBtn(sessionLength === opt.value)}>
                    {opt.label}
                  </button>
                ))}
              </div>
            </div>

            {/* MCQ row: timing */}
            <div>
              <div style={{ fontSize: '12px', color: '#5f6368', marginBottom: '6px' }}>Was the timing right?</div>
              <div style={{ display: 'flex', gap: '6px', flexWrap: 'wrap' }}>
                {TIMING_OPTIONS.map(opt => (
                  <button key={opt.value} onClick={() => setTiming(timing === opt.value ? null : opt.value)} style={pillBtn(timing === opt.value)}>
                    {opt.label}
                  </button>
                ))}
              </div>
            </div>

            {/* MCQ row: breaks */}
            <div>
              <div style={{ fontSize: '12px', color: '#5f6368', marginBottom: '6px' }}>How were the breaks?</div>
              <div style={{ display: 'flex', gap: '6px', flexWrap: 'wrap' }}>
                {BREAKS_OPTIONS.map(opt => (
                  <button key={opt.value} onClick={() => setBreaks(breaks === opt.value ? null : opt.value)} style={pillBtn(breaks === opt.value)}>
                    {opt.label}
                  </button>
                ))}
              </div>
            </div>

            {/* Notes */}
            <div>
              <div style={{ fontSize: '12px', color: '#5f6368', marginBottom: '6px' }}>
                Notes <span style={{ color: '#bbb', fontWeight: 400 }}>(optional)</span>
              </div>
              <textarea
                className="rp-textarea"
                value={reflText}
                onChange={e => setReflText(e.target.value)}
                placeholder="How did it go? What did you accomplish?"
                rows={3}
              />
            </div>

            <div>
              <button className="rp-save-btn" onClick={handleSaveReflection} disabled={!productivity}>
                Save Reflection
              </button>
              {reflSaved && <div className="rp-saved-confirm" style={{ marginTop: '6px' }}>✓ Reflection saved!</div>}
            </div>

            {/* Past reflections */}
            {sessionReflections.length > 0 && (
              <div className="rp-history">
                <div style={{ fontWeight: 600, fontSize: '12px', color: '#5f6368', marginBottom: '8px' }}>
                  Past reflections ({sessionReflections.length})
                </div>
                {sessionReflections.map(r => (
                  <div key={r.id} className="rp-history-entry">
                    <div className="rp-history-header">
                      <span className="rp-history-face">{FACES[r.productivity - 1].emoji}</span>
                      <span className="rp-history-score">Productivity: {r.productivity}/5</span>
                      <span className="rp-history-date">{new Date(r.savedAt).toLocaleString()}</span>
                    </div>
                    {(r.sessionLengthFeedback || r.timingFeedback || r.breaksFeedback) && (
                      <div style={{ fontSize: '11px', color: '#9aa0a6', marginTop: '3px', display: 'flex', gap: '8px', flexWrap: 'wrap' }}>
                        {r.sessionLengthFeedback && <span>Length: {r.sessionLengthFeedback.replace(/_/g, ' ')}</span>}
                        {r.timingFeedback && <span>Timing: {r.timingFeedback.replace(/_/g, ' ')}</span>}
                        {r.breaksFeedback && <span>Breaks: {r.breaksFeedback.replace(/_/g, ' ')}</span>}
                      </div>
                    )}
                    {r.reflectionText && <div className="rp-history-text">{r.reflectionText}</div>}
                  </div>
                ))}
              </div>
            )}
          </div>
        </div>
      </div>
    </div>
  );
}
