import React, { useState, useRef, useEffect } from 'react';
import { format, startOfWeek, addDays, isSameDay, addWeeks, subWeeks } from 'date-fns';

export type LocationType = 'room' | 'meeting_link' | 'address';

export interface CalendarMeta {
  id: string;
  summary: string;
  backgroundColor?: string;
  accessRole?: string;
  primary?: boolean;
}

export function getDefaultTimezone(): string {
  try { return Intl.DateTimeFormat().resolvedOptions().timeZone; } catch { return 'America/Los_Angeles'; }
}

export const TIMEZONES: string[] = (() => {
  try { return (Intl as any).supportedValuesOf('timeZone') as string[]; } catch {
    return [
      'America/New_York','America/Chicago','America/Denver','America/Los_Angeles',
      'America/Phoenix','America/Anchorage','Pacific/Honolulu','America/Toronto',
      'America/Vancouver','Europe/London','Europe/Paris','Europe/Berlin','Europe/Rome',
      'Europe/Madrid','Europe/Amsterdam','Europe/Zurich','Europe/Stockholm',
      'Asia/Tokyo','Asia/Shanghai','Asia/Hong_Kong','Asia/Singapore','Asia/Seoul',
      'Asia/Kolkata','Asia/Dubai','Asia/Bangkok','Asia/Jakarta','Australia/Sydney',
      'Australia/Melbourne','Pacific/Auckland','Pacific/Auckland',
    ];
  }
})();

export interface Session {
  id: string;
  title: string;
  description: string;
  location?: string;
  locationType?: LocationType;
  timezone?: string;
  calendarId?: string;
  visibility?: string;
  date: string;           // 'yyyy-MM-dd'
  dayIndex: number;       // 0=Sun … 6=Sat
  startHour: number;
  startMin: number;
  durationMins: number;
  color: string;
  recurrence?: string[];  // RRULE strings e.g. ["RRULE:FREQ=WEEKLY;BYDAY=MO"]
  recurringEventId?: string; // GCal series ID — present on instances of a recurring event
  category?: string;
  attendees?: { email: string; displayName?: string; self?: boolean; responseStatus?: string }[];
  pending?: boolean;      // true = AI suggestion awaiting user accept/reject
  /** All blocks in one ranked option share this id; used with pendingSlotMap on the parent */
  pendingGroupId?: string;
  /** If false, this block is part of a multi-slot suggestion — actions live on the first block only */
  pendingShowActions?: boolean;
}

export function detectLocationType(location: string): LocationType {
  if (!location) return 'room';
  if (/^https?:\/\//i.test(location)) return 'meeting_link';
  return 'room';
}

export function AddressSearch({ value, onChange, wrapperStyle }: { value: string; onChange: (v: string) => void; wrapperStyle?: React.CSSProperties }) {
  const [query, setQuery] = useState(value);
  const [suggestions, setSuggestions] = useState<string[]>([]);
  const [open, setOpen] = useState(false);
  const timer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);

  useEffect(() => {
    if (query.length < 3) { setSuggestions([]); setOpen(false); return; }
    clearTimeout(timer.current);
    timer.current = setTimeout(async () => {
      try {
        const res = await fetch(
          `https://nominatim.openstreetmap.org/search?format=json&q=${encodeURIComponent(query)}&limit=5`,
          { headers: { 'Accept-Language': 'en' } }
        );
        const data = await res.json();
        const names: string[] = data.map((d: any) => d.display_name);
        setSuggestions(names);
        setOpen(names.length > 0);
      } catch { /* ignore */ }
    }, 600);
    return () => clearTimeout(timer.current);
  }, [query]);

  return (
    <div style={{ position: 'relative', ...wrapperStyle }}>
      <input
        value={query}
        onChange={e => { setQuery(e.target.value); onChange(e.target.value); }}
        placeholder="Search for an address…"
        onFocus={() => suggestions.length > 0 && setOpen(true)}
        onBlur={() => setTimeout(() => setOpen(false), 150)}
        style={{ width: '100%', boxSizing: 'border-box' }}
      />
      {open && suggestions.length > 0 && (
        <div style={{
          position: 'absolute', top: '100%', left: 0, right: 0, background: '#fff',
          border: '1px solid #e0e0e0', borderRadius: '6px', boxShadow: '0 4px 12px rgba(0,0,0,0.1)',
          zIndex: 200, maxHeight: '180px', overflowY: 'auto',
        }}>
          {suggestions.map((s, i) => (
            <div
              key={i}
              onMouseDown={() => { onChange(s); setQuery(s); setOpen(false); setSuggestions([]); }}
              style={{
                padding: '0.4rem 0.6rem', fontSize: '0.78rem', cursor: 'pointer',
                borderBottom: i < suggestions.length - 1 ? '1px solid #f0f0f0' : 'none',
              }}
              onMouseEnter={e => (e.currentTarget.style.background = '#f8f9fa')}
              onMouseLeave={e => (e.currentTarget.style.background = '')}
            >{s}</div>
          ))}
          <div style={{ padding: '0.15rem 0.6rem', fontSize: '0.62rem', color: '#bbb', textAlign: 'right' }}>
            © OpenStreetMap contributors
          </div>
        </div>
      )}
    </div>
  );
}

interface Props {
  sessions?: Session[];
  selectedSession?: string | null;
  onSelectSession?: (id: string) => void;
  onAddSession?: (s: Omit<Session, 'id'>) => void;
  onEditSession?: (id: string, s: Omit<Session, 'id'>) => void;
  onDeleteSession?: (id: string) => void;
  onAcceptSession?: (id: string) => void;
  onRejectSession?: (id: string) => void;
  onOpenCreate?: (date: string, startHour: number, startMin: number, durationMins: number) => void;
  categories?: string[];
  onAddCategory?: (cat: string) => void;
  onDeleteCategory?: (cat: string) => void;
  calendars?: CalendarMeta[];
  toolbarExtra?: React.ReactNode;
}

const HOURS = Array.from({ length: 24 }, (_, i) => i);
const DAY_NAMES = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
const COLOR_PALETTE = [
  '#4285f4', '#ea4335', '#34a853', '#fbbc04',
  '#9c27b0', '#00acc1', '#e91e63', '#ff6d00',
  '#607d8b', '#795548',
];

const RRULE_DAY = ['SU', 'MO', 'TU', 'WE', 'TH', 'FR', 'SA'];

function buildRRule(
  repeat: string,
  customDays: number[],
  dayIdx: number,
  repeatEnds: 'never' | 'on_date' | 'after',
  repeatEndDate: string,
  repeatEndCount: number,
): string[] {
  if (repeat === 'none') return [];
  let endSuffix = '';
  if (repeatEnds === 'on_date' && repeatEndDate) {
    // Format date as YYYYMMDD for RRULE UNTIL
    endSuffix = `;UNTIL=${repeatEndDate.replace(/-/g, '')}`;
  } else if (repeatEnds === 'after' && repeatEndCount > 0) {
    endSuffix = `;COUNT=${repeatEndCount}`;
  }
  if (repeat === 'daily') return [`RRULE:FREQ=DAILY${endSuffix}`];
  if (repeat === 'weekly') return [`RRULE:FREQ=WEEKLY;BYDAY=${RRULE_DAY[dayIdx]}${endSuffix}`];
  if (repeat === 'custom' && customDays.length > 0)
    return [`RRULE:FREQ=WEEKLY;BYDAY=${customDays.map(d => RRULE_DAY[d]).join(',')}${endSuffix}`];
  return [];
}

const DEFAULT_FORM = {
  title: '',
  description: '',
  location: '',
  locationType: 'room' as LocationType,
  timezone: getDefaultTimezone(),
  day: '1',
  startTime: '09:00',
  endTime: '10:00',
  color: '#4285f4',
  repeat: 'none',
  customDays: [] as number[],
  repeatEnds: 'never' as 'never' | 'on_date' | 'after',
  repeatEndDate: '',
  repeatEndCount: 10,
  calendarId: 'primary',
  visibility: 'default',
  category: '',
  newCatInput: '',
  showNewCat: false,
};

/** Add `mins` to a "HH:mm" string, clamped to 23:59 */
function addMins(time: string, mins: number): string {
  const [h, m] = time.split(':').map(Number);
  const total = Math.min(23 * 60 + 59, h * 60 + m + mins);
  return `${String(Math.floor(total / 60)).padStart(2, '0')}:${String(total % 60).padStart(2, '0')}`;
}

/** Difference in minutes between two "HH:mm" strings (end − start). Returns 0 if negative. */
function diffMins(start: string, end: string): number {
  const [sh, sm] = start.split(':').map(Number);
  const [eh, em] = end.split(':').map(Number);
  return Math.max(0, eh * 60 + em - (sh * 60 + sm));
}

/** Assign side-by-side column slots to overlapping sessions. Returns a map of id → {col, totalCols}. */
function computeOverlapLayout(sessions: Session[]): Map<string, { col: number; totalCols: number }> {
  const result = new Map<string, { col: number; totalCols: number }>();
  if (sessions.length === 0) return result;

  const sorted = [...sessions].sort((a, b) =>
    (a.startHour * 60 + a.startMin) - (b.startHour * 60 + b.startMin)
  );

  const startOf = (s: Session) => s.startHour * 60 + s.startMin;
  const endOf   = (s: Session) => startOf(s) + s.durationMins;
  const overlaps = (a: Session, b: Session) => startOf(a) < endOf(b) && startOf(b) < endOf(a);

  const clusters: Session[][] = [];
  for (const s of sorted) {
    const cluster = clusters.find(c => c.some(cs => overlaps(cs, s)));
    if (cluster) cluster.push(s);
    else clusters.push([s]);
  }

  for (const cluster of clusters) {
    const cols: number[] = [];
    for (const s of cluster) {
      const taken = cluster
        .filter(o => o !== s && overlaps(o, s) && result.has(o.id))
        .map(o => result.get(o.id)!.col);
      let col = 0;
      while (taken.includes(col)) col++;
      cols.push(col);
      result.set(s.id, { col, totalCols: 1 });
    }
    const totalCols = Math.max(...cols) + 1;
    for (const s of cluster) {
      result.set(s.id, { col: result.get(s.id)!.col, totalCols });
    }
  }

  return result;
}

/** Snap raw pixel-offset (= minutes from midnight) to nearest 30-min boundary */
function snapTo30(rawY: number): { hour: number; min: number } {
  const totalMins = rawY;
  const snapped = Math.round(totalMins / 30) * 30;
  const hour = Math.min(23, Math.floor(snapped / 60));
  const min = snapped % 60 === 60 ? 0 : snapped % 60;
  return { hour, min };
}

function fmtTime(hour: number, min: number) {
  return `${hour % 12 || 12}:${String(min).padStart(2, '0')} ${hour < 12 ? 'AM' : 'PM'}`;
}

interface DragState {
  session: Session;
  offsetMins: number;
  currentDay: number;
  currentHour: number;
  currentMin: number;
}

interface DragGhost {
  sessionId: string;
  dayIndex: number;
  hour: number;
  min: number;
  durationMins: number;
  color: string;
  title: string;
}

export default function WeekCalendar({ sessions = [], selectedSession, onSelectSession, onAddSession, onEditSession, onDeleteSession, onAcceptSession, onRejectSession, onOpenCreate, categories = [], onAddCategory, onDeleteCategory, calendars = [], toolbarExtra }: Props) {
  const [weekStart, setWeekStart] = useState(() =>
    startOfWeek(new Date(), { weekStartsOn: 0 })
  );
  const [showModal, setShowModal] = useState(false);
  const [editingId, setEditingId] = useState<string | null>(null);
  const [form, setForm] = useState({ ...DEFAULT_FORM });
  const [dragGhost, setDragGhost] = useState<DragGhost | null>(null);

  const weekGridRef = useRef<HTMLDivElement>(null);
  const weekBodyRef = useRef<HTMLDivElement>(null);
  const gutterRef = useRef<HTMLDivElement>(null);
  const dragRef = useRef<DragState | null>(null);
  const didDragRef = useRef(false);
  // Stable refs so event listeners don't go stale
  const weekStartRef = useRef(weekStart);
  const onEditSessionRef = useRef(onEditSession);

  useEffect(() => { weekStartRef.current = weekStart; }, [weekStart]);
  useEffect(() => { onEditSessionRef.current = onEditSession; }, [onEditSession]);

  useEffect(() => {
    if (weekGridRef.current) {
      weekGridRef.current.scrollTop = 8 * 60; // 8 AM
    }
  }, []);

  // Attach drag tracking to document once — avoids mouse leaving the grid
  useEffect(() => {
    function onMove(e: MouseEvent) {
      if (!dragRef.current || !weekBodyRef.current) return;
      didDragRef.current = true;
      const bodyRect = weekBodyRef.current.getBoundingClientRect();
      const gutterWidth = gutterRef.current?.offsetWidth ?? 56;
      const relX = e.clientX - bodyRect.left - gutterWidth;
      const colWidth = (bodyRect.width - gutterWidth) / 7;
      const dayIndex = Math.max(0, Math.min(6, Math.floor(relX / colWidth)));
      // getBoundingClientRect already accounts for scroll, so no scrollTop needed
      const relY = e.clientY - bodyRect.top;
      const rawMins = Math.max(0, relY - dragRef.current.offsetMins);
      const { hour, min } = snapTo30(rawMins);
      const clampedHour = Math.min(23, hour);
      dragRef.current.currentDay = dayIndex;
      dragRef.current.currentHour = clampedHour;
      dragRef.current.currentMin = min;
      setDragGhost(g => g ? { ...g, dayIndex, hour: clampedHour, min } : null);
      document.body.style.cursor = 'grabbing';
      document.body.style.userSelect = 'none';
    }

    function onUp() {
      document.body.style.cursor = '';
      document.body.style.userSelect = '';
      if (!dragRef.current) return;
      const { session, currentDay, currentHour, currentMin } = dragRef.current;
      dragRef.current = null;
      setDragGhost(null);
      if (!didDragRef.current) return;
      // Only save if position actually changed
      if (
        currentDay !== session.dayIndex ||
        currentHour !== session.startHour ||
        currentMin !== session.startMin
      ) {
        const date = format(addDays(weekStartRef.current, currentDay), 'yyyy-MM-dd');
        onEditSessionRef.current?.(session.id, {
          ...session,
          date,
          dayIndex: currentDay,
          startHour: currentHour,
          startMin: currentMin,
        });
      }
    }

    document.addEventListener('mousemove', onMove);
    document.addEventListener('mouseup', onUp);
    return () => {
      document.removeEventListener('mousemove', onMove);
      document.removeEventListener('mouseup', onUp);
    };
  }, []);

  const today = new Date();
  const days = Array.from({ length: 7 }, (_, i) => addDays(weekStart, i));
  const weekLabel = `${format(weekStart, 'MMMM d')} – ${format(addDays(weekStart, 6), 'd, yyyy')}`;

  const ghostStartParts = form.startTime.split(':').map(Number);
  const ghostDuration = Math.max(15, diffMins(form.startTime, form.endTime) || 60);
  const ghost = showModal
    ? {
        dayIndex: Number(form.day),
        startHour: ghostStartParts[0],
        startMin: ghostStartParts[1],
        durationMins: ghostDuration,
        color: form.color,
      }
    : null;

  function handleColumnClick(e: React.MouseEvent<HTMLDivElement>, colIdx: number) {
    if (didDragRef.current) { didDragRef.current = false; return; }
    const rect = e.currentTarget.getBoundingClientRect();
    const rawY = e.clientY - rect.top;
    const { hour, min } = snapTo30(rawY);
    const startTime = `${String(hour).padStart(2, '0')}:${String(min).padStart(2, '0')}`;
    const endTime = addMins(startTime, 60);
    if (onOpenCreate) {
      const date = format(addDays(weekStart, colIdx), 'yyyy-MM-dd');
      onOpenCreate(date, hour, min, 60);
      return;
    }
    setForm({ ...DEFAULT_FORM, day: String(colIdx), startTime, endTime });
    setShowModal(true);
  }

  function handleSessionClick(e: React.MouseEvent, s: Session) {
    e.stopPropagation();
    if (didDragRef.current) { didDragRef.current = false; return; }
    onSelectSession?.(s.id);
  }

  function handleDragStart(e: React.MouseEvent, s: Session) {
    if (e.button !== 0) return;
    e.preventDefault();
    e.stopPropagation();
    didDragRef.current = false;
    const rect = (e.currentTarget as HTMLElement).getBoundingClientRect();
    const offsetMins = e.clientY - rect.top;
    dragRef.current = {
      session: s,
      offsetMins,
      currentDay: s.dayIndex,
      currentHour: s.startHour,
      currentMin: s.startMin,
    };
    setDragGhost({
      sessionId: s.id,
      dayIndex: s.dayIndex,
      hour: s.startHour,
      min: s.startMin,
      durationMins: s.durationMins,
      color: s.color,
      title: s.title,
    });
  }

  function handleSave() {
    if (!form.title.trim()) return;
    const [h, m] = form.startTime.split(':').map(Number);
    const dayIdx = Number(form.day);
    const date = format(addDays(weekStart, dayIdx), 'yyyy-MM-dd');
    const recurrence = buildRRule(form.repeat, form.customDays, dayIdx, form.repeatEnds, form.repeatEndDate, form.repeatEndCount);
    const sessionData = {
      title: form.title.trim(),
      description: form.description.trim(),
      location: form.location.trim() || undefined,
      locationType: form.location.trim() ? form.locationType : undefined,
      timezone: form.timezone || getDefaultTimezone(),
      calendarId: form.calendarId || 'primary',
      visibility: form.visibility || 'default',
      date,
      dayIndex: dayIdx,
      startHour: h,
      startMin: m,
      durationMins: Math.max(1, diffMins(form.startTime, form.endTime)),
      color: form.color,
      recurrence,
      category: form.category || undefined,
    };
    if (editingId) {
      onEditSession?.(editingId, sessionData);
    } else {
      onAddSession?.(sessionData);
    }
    setShowModal(false);
    setEditingId(null);
    setForm({ ...DEFAULT_FORM });
  }

  function handleCancel() {
    setShowModal(false);
    setEditingId(null);
    setForm({ ...DEFAULT_FORM });
  }

  return (
    <div className="calendar-panel">
      {/* toolbar */}
      <div className="calendar-toolbar">
        <button className="today-btn" onClick={() => setWeekStart(startOfWeek(new Date(), { weekStartsOn: 0 }))}>
          Today
        </button>
        <button className="cal-nav-btn" onClick={() => setWeekStart(w => subWeeks(w, 1))}>‹</button>
        <button className="cal-nav-btn" onClick={() => setWeekStart(w => addWeeks(w, 1))}>›</button>
        <span className="week-range-label">{weekLabel}</span>
        <span className="click-hint">Click any time slot to add a session</span>
        {toolbarExtra}
      </div>

      {/* grid */}
      <div className="week-grid" ref={weekGridRef}>
        {/* day headers */}
        <div className="week-header">
          <div className="time-gutter-header" />
          {days.map((d, i) => (
            <div key={i} className={`day-header ${isSameDay(d, today) ? 'today' : ''}`}>
              <span>{DAY_NAMES[i]}</span>
              <span className="day-num">{format(d, 'd')}</span>
            </div>
          ))}
        </div>

        {/* body */}
        <div className="week-body" ref={weekBodyRef}>
          {/* time gutter */}
          <div className="time-gutter" ref={gutterRef}>
            {HOURS.map(h => (
              <div key={h} className="time-label">
                {h === 0 ? '' : `${h % 12 || 12} ${h < 12 ? 'AM' : 'PM'}`}
              </div>
            ))}
          </div>

          {/* day columns — clickable */}
          {days.map((_, colIdx) => (
            <div
              key={colIdx}
              className="day-column"
              onClick={e => handleColumnClick(e, colIdx)}
            >
              {HOURS.map(h => (
                <div key={h} className="hour-line" style={{ top: h * 60, pointerEvents: 'none' }} />
              ))}

              {/* Ghost block — live preview while add-session modal is open */}
              {ghost && ghost.dayIndex === colIdx && (
                <div
                  className="session-block session-ghost"
                  style={{
                    top: ghost.startHour * 60 + ghost.startMin,
                    height: Math.max(ghost.durationMins, 22),
                    background: ghost.color,
                    pointerEvents: 'none',
                  }}
                >
                  <div className="session-title">{form.title || 'New session'}</div>
                  <div className="session-time">{fmtTime(ghost.startHour, ghost.startMin)}</div>
                </div>
              )}

              {/* Drag ghost — preview while dragging an existing session */}
              {dragGhost && dragGhost.dayIndex === colIdx && (
                <div
                  className="session-block session-ghost"
                  style={{
                    top: dragGhost.hour * 60 + dragGhost.min,
                    height: Math.max(dragGhost.durationMins, 22),
                    background: dragGhost.color,
                    opacity: 0.75,
                    pointerEvents: 'none',
                  }}
                >
                  <div className="session-title">{dragGhost.title}</div>
                  <div className="session-time">{fmtTime(dragGhost.hour, dragGhost.min)}</div>
                </div>
              )}

              {/* Sessions (confirmed + pending suggestions) */}
              {(() => {
                const daySessions = sessions.filter(
                  s => s.dayIndex === colIdx && s.date === format(days[colIdx], 'yyyy-MM-dd')
                );
                const layout = computeOverlapLayout(daySessions);
                return daySessions.map(s => {
                  const { col, totalCols } = layout.get(s.id) ?? { col: 0, totalCols: 1 };
                  const width = `calc(${100 / totalCols}% - ${totalCols > 1 ? '2px' : '0px'})`;
                  const left = `${(col / totalCols) * 100}%`;
                  const isDragging = dragGhost?.sessionId === s.id;
                  const isPending = !!s.pending;
                  const showPendingActions =
                    isPending && (s.pendingShowActions === undefined || s.pendingShowActions);
                  return (
                    <div
                      key={s.id}
                      className={`session-block ${selectedSession === s.id ? 'selected' : ''}`}
                      style={{
                        top: s.startHour * 60 + s.startMin,
                        height: Math.max(s.durationMins, 40),
                        background: isPending ? '#888' : s.color,
                        width,
                        left,
                        opacity: isDragging ? 0.3 : (isPending ? 0.45 : (totalCols > 1 ? 0.92 : 1)),
                        boxShadow: totalCols > 1 ? '2px 0 0 rgba(0,0,0,0.15)' : undefined,
                        cursor: isPending ? 'default' : (isDragging ? 'grabbing' : 'grab'),
                        border: isPending ? '2px dashed rgba(0,0,0,0.4)' : undefined,
                      }}
                      onMouseDown={isPending ? undefined : (e => handleDragStart(e, s))}
                      onClick={isPending ? undefined : (e => handleSessionClick(e, s))}
                    >
                      <div className="session-title">{isPending ? `💡 ${s.title}` : s.title}</div>
                      <div className="session-time">{fmtTime(s.startHour, s.startMin)}</div>
                      {showPendingActions ? (
                        <div style={{ position: 'absolute', bottom: '3px', left: '4px', right: '4px', display: 'flex', gap: '4px' }}>
                          <button
                            title="Accept suggestion (all blocks)"
                            onClick={e => { e.stopPropagation(); onAcceptSession?.(s.id); }}
                            style={{ flex: 1, background: 'rgba(255,255,255,0.85)', border: 'none', borderRadius: '3px', cursor: 'pointer', fontSize: '0.7rem', fontWeight: 700, color: '#1a7a1a', padding: '2px' }}
                          >✓ Add</button>
                          <button
                            title="Dismiss suggestion"
                            onClick={e => { e.stopPropagation(); onRejectSession?.(s.id); }}
                            style={{ flex: 1, background: 'rgba(255,255,255,0.85)', border: 'none', borderRadius: '3px', cursor: 'pointer', fontSize: '0.7rem', fontWeight: 700, color: '#a00', padding: '2px' }}
                          >✕ No</button>
                        </div>
                      ) : (
                        onDeleteSession && (
                          <button
                            className="session-delete-btn"
                            title="Delete event"
                            onClick={e => { e.stopPropagation(); onDeleteSession(s.id); }}
                          >✕</button>
                        )
                      )}
                    </div>
                  );
                });
              })()}
            </div>
          ))}
        </div>
      </div>

      {/* Add session modal */}
      {showModal && (
        <div className="modal-overlay" onClick={handleCancel}>
          <div className="modal" onClick={e => e.stopPropagation()}>
            <h3>{editingId ? 'Edit Session' : 'Add Work Session'}</h3>

            <div className="modal-field">
              <label>Title *</label>
              <input
                autoFocus
                value={form.title}
                onChange={e => setForm(f => ({ ...f, title: e.target.value }))}
                placeholder="e.g. CS61A Homework"
                onKeyDown={e => e.key === 'Enter' && handleSave()}
              />
            </div>

            <div className="modal-field">
              <label>Location</label>
              <div style={{ display: 'flex', gap: '0.3rem', alignItems: 'center' }}>
                {form.locationType === 'address' ? (
                  <AddressSearch
                    value={form.location}
                    onChange={loc => setForm(f => ({ ...f, location: loc }))}
                    wrapperStyle={{ flex: 1 }}
                  />
                ) : (
                  <div style={{ flex: 1 }}>
                    <input
                      value={form.location}
                      onChange={e => setForm(f => ({ ...f, location: e.target.value }))}
                      placeholder={form.locationType === 'meeting_link' ? 'Paste meeting link…' : 'Room, building, or anywhere'}
                      style={{ width: '100%', boxSizing: 'border-box' }}
                    />
                    {form.locationType === 'meeting_link' && /^https?:\/\//i.test(form.location) && (
                      <a
                        href={form.location}
                        target="_blank"
                        rel="noopener noreferrer"
                        style={{ display: 'block', marginTop: '0.25rem', fontSize: '0.76rem', color: '#1a73e8', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}
                      >↗ {form.location}</a>
                    )}
                  </div>
                )}
                <div style={{ display: 'flex', gap: '0.25rem', flexShrink: 0, alignSelf: 'flex-start' }}>
                  {([['room', '🏠', 'Room'], ['meeting_link', '🔗', 'Meeting link'], ['address', '📍', 'Address']] as [LocationType, string, string][]).map(([type, icon, title]) => (
                    <button
                      key={type}
                      type="button"
                      title={title}
                      onClick={() => setForm(f => ({ ...f, locationType: type }))}
                      style={{
                        width: '36px', height: '36px', borderRadius: '8px', fontSize: '1.05rem',
                        cursor: 'pointer', flexShrink: 0,
                        border: form.locationType === type ? '1.5px solid #4285f4' : '1.5px solid #e0e0e0',
                        background: form.locationType === type ? '#e8f0fe' : '#f8f9fa',
                        display: 'flex', alignItems: 'center', justifyContent: 'center',
                        transition: 'border-color 0.15s, background 0.15s',
                      }}
                    >{icon}</button>
                  ))}
                </div>
              </div>
            </div>

            <div className="modal-field">
              <label>Description</label>
              <textarea
                className="modal-textarea"
                value={form.description}
                onChange={e => setForm(f => ({ ...f, description: e.target.value }))}
                placeholder="Add notes or agenda…"
                rows={4}
              />
            </div>

            <div className="modal-row">
              <div className="modal-field">
                <label>Calendar</label>
                <select
                  value={form.calendarId}
                  onChange={e => setForm(f => ({ ...f, calendarId: e.target.value }))}
                >
                  {calendars.length > 0
                    ? calendars.map(c => (
                        <option key={c.id} value={c.id}>{c.summary}</option>
                      ))
                    : <option value="primary">Primary</option>
                  }
                </select>
              </div>
              <div className="modal-field">
                <label>Visibility</label>
                <select
                  value={form.visibility}
                  onChange={e => setForm(f => ({ ...f, visibility: e.target.value }))}
                >
                  <option value="default">Default</option>
                  <option value="public">Public</option>
                  <option value="private">Private</option>
                </select>
              </div>
            </div>

            <div className="modal-field">
              <label>Day</label>
              <select value={form.day} onChange={e => setForm(f => ({ ...f, day: e.target.value }))}>
                {DAY_NAMES.map((d, i) => (
                  <option key={i} value={i}>{d} — {format(addDays(weekStart, i), 'MMM d')}</option>
                ))}
              </select>
            </div>

            <div className="modal-field">
              <label>Repeat</label>
              <select value={form.repeat} onChange={e => setForm(f => ({ ...f, repeat: e.target.value, customDays: [] }))}>
                <option value="none">Does not repeat</option>
                <option value="daily">Daily</option>
                <option value="weekly">Weekly on {DAY_NAMES[Number(form.day)]}</option>
                <option value="custom">Custom…</option>
              </select>
            </div>

            {form.repeat === 'custom' && (
              <div className="modal-field">
                <label>Repeat on</label>
                <div style={{ display: 'flex', gap: '0.4rem', flexWrap: 'wrap' }}>
                  {DAY_NAMES.map((d, i) => (
                    <button
                      key={i}
                      type="button"
                      onClick={() => setForm(f => ({
                        ...f,
                        customDays: f.customDays.includes(i)
                          ? f.customDays.filter(x => x !== i)
                          : [...f.customDays, i],
                      }))}
                      style={{
                        width: '2.2rem',
                        height: '2.2rem',
                        borderRadius: '50%',
                        border: '1.5px solid #4285f4',
                        background: form.customDays.includes(i) ? '#4285f4' : '#fff',
                        color: form.customDays.includes(i) ? '#fff' : '#4285f4',
                        fontWeight: 600,
                        fontSize: '0.75rem',
                        cursor: 'pointer',
                      }}
                    >
                      {d[0]}
                    </button>
                  ))}
                </div>
              </div>
            )}

            {form.repeat !== 'none' && (
              <div className="modal-field">
                <label>Ends</label>
                <div style={{ display: 'flex', flexDirection: 'column', gap: '0.4rem' }}>
                  {(['never', 'on_date', 'after'] as const).map(opt => (
                    <label key={opt} style={{ display: 'flex', alignItems: 'center', gap: '0.5rem', cursor: 'pointer', fontSize: '0.88rem' }}>
                      <input
                        type="radio"
                        name="repeatEnds"
                        value={opt}
                        checked={form.repeatEnds === opt}
                        onChange={() => setForm(f => ({ ...f, repeatEnds: opt }))}
                        style={{ cursor: 'pointer' }}
                      />
                      {opt === 'never' && 'Never'}
                      {opt === 'on_date' && (
                        <span style={{ display: 'flex', alignItems: 'center', gap: '0.4rem' }}>
                          On date
                          <input
                            type="date"
                            value={form.repeatEndDate}
                            min={form.repeatEnds === 'on_date' ? undefined : undefined}
                            onChange={e => setForm(f => ({ ...f, repeatEndDate: e.target.value, repeatEnds: 'on_date' }))}
                            style={{ fontSize: '0.82rem', padding: '0.1rem 0.3rem' }}
                          />
                        </span>
                      )}
                      {opt === 'after' && (
                        <span style={{ display: 'flex', alignItems: 'center', gap: '0.4rem' }}>
                          After
                          <input
                            type="number"
                            min={1}
                            max={999}
                            value={form.repeatEndCount}
                            onChange={e => setForm(f => ({ ...f, repeatEndCount: Math.max(1, parseInt(e.target.value) || 1), repeatEnds: 'after' }))}
                            style={{ width: '52px', fontSize: '0.82rem', padding: '0.1rem 0.3rem' }}
                          />
                          occurrences
                        </span>
                      )}
                    </label>
                  ))}
                </div>
              </div>
            )}

            <div className="modal-row">
              <div className="modal-field">
                <label>Start time</label>
                <input
                  type="time"
                  value={form.startTime}
                  onChange={e => {
                    const startTime = e.target.value;
                    const dur = diffMins(form.startTime, form.endTime) || 60;
                    const endTime = addMins(startTime, dur);
                    setForm(f => ({ ...f, startTime, endTime }));
                  }}
                />
              </div>
              <div className="modal-field">
                <label>End time</label>
                <input
                  type="time"
                  value={form.endTime}
                  onChange={e => setForm(f => ({ ...f, endTime: e.target.value }))}
                />
              </div>
            </div>

            <div className="modal-field">
              <label>Timezone</label>
              <input
                list="tz-list-add"
                value={form.timezone}
                onChange={e => setForm(f => ({ ...f, timezone: e.target.value }))}
                placeholder="e.g. America/New_York"
              />
              <datalist id="tz-list-add">
                {TIMEZONES.map(tz => <option key={tz} value={tz} />)}
              </datalist>
            </div>

            <div className="modal-field">
              <label>Category</label>
              <div style={{ display: 'flex', flexWrap: 'wrap', gap: '0.3rem', marginTop: '2px' }}>
                <button type="button" onClick={() => setForm(f => ({ ...f, category: '' }))}
                  style={{ padding: '0.2rem 0.55rem', borderRadius: '999px', fontSize: '0.78rem', cursor: 'pointer', border: form.category === '' ? '1.5px solid #4285f4' : '1.5px solid #ccc', background: form.category === '' ? '#e8f0fe' : '#f5f5f5', color: form.category === '' ? '#1a73e8' : '#444', fontWeight: 500 }}>
                  None
                </button>
                {categories.map((c: string) => (
                  <span key={c} style={{ display: 'inline-flex', alignItems: 'center', gap: '0.2rem' }}>
                    <button type="button" onClick={() => setForm(f => ({ ...f, category: c }))}
                      style={{ padding: '0.2rem 0.55rem', borderRadius: '999px', fontSize: '0.78rem', cursor: 'pointer', border: form.category === c ? '1.5px solid #4285f4' : '1.5px solid #ccc', background: form.category === c ? '#e8f0fe' : '#f5f5f5', color: form.category === c ? '#1a73e8' : '#444', fontWeight: 500 }}>
                      {c}
                    </button>
                    <button type="button" title={`Delete "${c}"`}
                      onClick={() => { onDeleteCategory?.(c); if (form.category === c) setForm(f => ({ ...f, category: '' })); }}
                      style={{ background: 'none', border: 'none', cursor: 'pointer', color: '#aaa', fontSize: '0.7rem', padding: '0', lineHeight: 1 }}>
                      ✕
                    </button>
                  </span>
                ))}
                {!form.showNewCat ? (
                  <button type="button" onClick={() => setForm(f => ({ ...f, showNewCat: true }))}
                    style={{ padding: '0.2rem 0.55rem', borderRadius: '999px', fontSize: '0.78rem', cursor: 'pointer', border: '1.5px dashed #aaa', background: 'none', color: '#666' }}>
                    + Add
                  </button>
                ) : (
                  <div style={{ display: 'flex', gap: '0.3rem', alignItems: 'center' }}>
                    <input autoFocus value={form.newCatInput} onChange={e => setForm(f => ({ ...f, newCatInput: e.target.value }))}
                      placeholder="Name" style={{ width: '90px', fontSize: '0.8rem', padding: '0.2rem 0.4rem' }}
                      onKeyDown={e => {
                        if (e.key === 'Enter' && form.newCatInput.trim()) {
                          onAddCategory?.(form.newCatInput.trim());
                          setForm(f => ({ ...f, category: f.newCatInput.trim(), newCatInput: '', showNewCat: false }));
                        } else if (e.key === 'Escape') {
                          setForm(f => ({ ...f, newCatInput: '', showNewCat: false }));
                        }
                      }}
                    />
                    <button type="button" className="btn-save" style={{ padding: '0.2rem 0.5rem', fontSize: '0.78rem' }}
                      onClick={() => { if (form.newCatInput.trim()) { onAddCategory?.(form.newCatInput.trim()); setForm(f => ({ ...f, category: f.newCatInput.trim(), newCatInput: '', showNewCat: false })); } }}>
                      Add
                    </button>
                    <button type="button" onClick={() => setForm(f => ({ ...f, newCatInput: '', showNewCat: false }))}
                      style={{ background: 'none', border: 'none', cursor: 'pointer', color: '#aaa', fontSize: '0.85rem' }}>✕</button>
                  </div>
                )}
              </div>
            </div>

            <div className="modal-field">
              <label>Color</label>
              <div className="color-palette">
                {COLOR_PALETTE.map(c => (
                  <button
                    key={c}
                    className={`color-swatch ${form.color === c ? 'selected' : ''}`}
                    style={{ background: c }}
                    onClick={() => setForm(f => ({ ...f, color: c }))}
                    title={c}
                  />
                ))}
              </div>
            </div>

            <div className="modal-actions">
              <button className="btn-cancel" onClick={handleCancel}>Cancel</button>
              <button className="btn-save" onClick={handleSave} disabled={!form.title.trim()}>{editingId ? 'Save Changes' : 'Add Session'}</button>
            </div>
          </div>
        </div>
      )}

    </div>
  );
}
