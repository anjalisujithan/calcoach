import React, { useState, useRef, useEffect } from 'react';
import { format, startOfWeek, addDays, isSameDay, addWeeks, subWeeks } from 'date-fns';

export interface Session {
  id: string;
  title: string;
  description: string;
  date: string;           // 'yyyy-MM-dd'
  dayIndex: number;       // 0=Sun … 6=Sat
  startHour: number;
  startMin: number;
  durationMins: number;
  color: string;
  recurrence?: string[];  // RRULE strings e.g. ["RRULE:FREQ=WEEKLY;BYDAY=MO"]
  category?: string;
}

interface Props {
  sessions?: Session[];
  selectedSession?: string | null;
  onSelectSession?: (id: string) => void;
  onAddSession?: (s: Omit<Session, 'id'>) => void;
  onEditSession?: (id: string, s: Omit<Session, 'id'>) => void;
  onDeleteSession?: (id: string) => void;
  categories?: string[];
  onAddCategory?: (cat: string) => void;
  onDeleteCategory?: (cat: string) => void;
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

function buildRRule(repeat: string, customDays: number[], dayIdx: number): string[] {
  if (repeat === 'daily') return ['RRULE:FREQ=DAILY'];
  if (repeat === 'weekly') return [`RRULE:FREQ=WEEKLY;BYDAY=${RRULE_DAY[dayIdx]}`];
  if (repeat === 'custom' && customDays.length > 0)
    return [`RRULE:FREQ=WEEKLY;BYDAY=${customDays.map(d => RRULE_DAY[d]).join(',')}`];
  return [];
}

const DEFAULT_FORM = {
  title: '',
  description: '',
  day: '1',
  startTime: '09:00',
  endTime: '10:00',
  color: '#4285f4',
  repeat: 'none',
  customDays: [] as number[],
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

export default function WeekCalendar({ sessions = [], selectedSession, onSelectSession, onAddSession, onEditSession, onDeleteSession, categories = [], onAddCategory, onDeleteCategory, toolbarExtra }: Props) {
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
    const recurrence = buildRRule(form.repeat, form.customDays, dayIdx);
    const sessionData = {
      title: form.title.trim(),
      description: form.description.trim(),
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

              {/* Confirmed sessions */}
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
                  return (
                    <div
                      key={s.id}
                      className={`session-block ${selectedSession === s.id ? 'selected' : ''}`}
                      style={{
                        top: s.startHour * 60 + s.startMin,
                        height: Math.max(s.durationMins, 22),
                        background: s.color,
                        width,
                        left,
                        opacity: isDragging ? 0.3 : (totalCols > 1 ? 0.92 : 1),
                        boxShadow: totalCols > 1 ? '2px 0 0 rgba(0,0,0,0.15)' : undefined,
                        cursor: isDragging ? 'grabbing' : 'grab',
                      }}
                      onMouseDown={e => handleDragStart(e, s)}
                      onClick={e => handleSessionClick(e, s)}
                    >
                      <div className="session-title">{s.title}</div>
                      <div className="session-time">{fmtTime(s.startHour, s.startMin)}</div>
                      {onDeleteSession && (
                        <button
                          className="session-delete-btn"
                          title="Delete event"
                          onClick={e => { e.stopPropagation(); onDeleteSession(s.id); }}
                        >✕</button>
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
