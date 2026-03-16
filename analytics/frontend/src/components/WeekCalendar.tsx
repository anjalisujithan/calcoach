import { useState, useRef, useEffect } from 'react';
import { format, startOfWeek, addDays, isSameDay, addWeeks, subWeeks } from 'date-fns';

export interface Session {
  id: string;
  title: string;
  description: string;
  date: string;       // 'yyyy-MM-dd'
  dayIndex: number;   // 0=Sun … 6=Sat
  startHour: number;
  startMin: number;
  durationMins: number;
  color: string;
}

interface Props {
  sessions?: Session[];
  selectedSession?: string | null;
  onSelectSession?: (id: string) => void;
  onAddSession?: (s: Omit<Session, 'id'>) => void;
}

const HOURS = Array.from({ length: 24 }, (_, i) => i);
const DAY_NAMES = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
const COLOR_PALETTE = [
  '#4285f4', '#ea4335', '#34a853', '#fbbc04',
  '#9c27b0', '#00acc1', '#e91e63', '#ff6d00',
  '#607d8b', '#795548',
];

const DEFAULT_FORM = {
  title: '',
  description: '',
  day: '1',
  startTime: '09:00',
  endTime: '10:00',
  duration: '60',
  color: '#4285f4',
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

/** Snap raw pixel-offset (= minutes from midnight) to nearest 30-min boundary */
function snapTo30(rawY: number): { hour: number; min: number } {
  const totalMins = rawY; // 60px === 60 mins
  const snapped = Math.round(totalMins / 30) * 30;
  const hour = Math.min(23, Math.floor(snapped / 60));
  const min = snapped % 60 === 60 ? 0 : snapped % 60;
  return { hour, min };
}

function fmtTime(hour: number, min: number) {
  return `${hour % 12 || 12}:${String(min).padStart(2, '0')} ${hour < 12 ? 'AM' : 'PM'}`;
}

export default function WeekCalendar({ sessions = [], selectedSession, onSelectSession, onAddSession }: Props) {
  const [weekStart, setWeekStart] = useState(() =>
    startOfWeek(new Date(), { weekStartsOn: 0 })
  );
  const [showModal, setShowModal] = useState(false);
  const [form, setForm] = useState({ ...DEFAULT_FORM });

  // Ref for the scrollable grid — used to set initial 8 AM scroll
  const weekGridRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (weekGridRef.current) {
      weekGridRef.current.scrollTop = 8 * 60; // 8 AM
    }
  }, []);

  const today = new Date();
  const days = Array.from({ length: 7 }, (_, i) => addDays(weekStart, i));
  const weekLabel = `${format(weekStart, 'MMMM d')} – ${format(addDays(weekStart, 6), 'd, yyyy')}`;

  // Ghost block: derived live from form so it updates as the user edits any field
  const ghostStartParts = form.startTime.split(':').map(Number);
  const ghostDuration = Math.max(15, diffMins(form.startTime, form.endTime) || Number(form.duration) || 60);
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
    const rect = e.currentTarget.getBoundingClientRect();
    const rawY = e.clientY - rect.top;
    const { hour, min } = snapTo30(rawY);
    const startTime = `${String(hour).padStart(2, '0')}:${String(min).padStart(2, '0')}`;
    const endTime = addMins(startTime, 60);
    setForm({ ...DEFAULT_FORM, day: String(colIdx), startTime, endTime, duration: '60' });
    setShowModal(true);
  }

  function handleSave() {
    if (!form.title.trim()) return;
    const [h, m] = form.startTime.split(':').map(Number);
    const dayIdx = Number(form.day);
    const date = format(addDays(weekStart, dayIdx), 'yyyy-MM-dd');
    onAddSession?.({
      title: form.title.trim(),
      description: form.description.trim(),
      date,
      dayIndex: dayIdx,
      startHour: h,
      startMin: m,
      durationMins: Math.max(1, diffMins(form.startTime, form.endTime)),
      color: form.color,
    });
    setShowModal(false);
    setForm({ ...DEFAULT_FORM });
  }

  function handleCancel() {
    setShowModal(false);
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
        <div className="week-body">
          {/* time gutter */}
          <div className="time-gutter">
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

              {/* Ghost block — live preview while modal is open */}
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

              {/* Confirmed sessions */}
              {sessions
                .filter(s => s.dayIndex === colIdx)
                .map(s => (
                  <div
                    key={s.id}
                    className={`session-block ${selectedSession === s.id ? 'selected' : ''}`}
                    style={{
                      top: s.startHour * 60 + s.startMin,
                      height: Math.max(s.durationMins, 22),
                      background: s.color,
                    }}
                    onClick={e => { e.stopPropagation(); onSelectSession?.(s.id); }}
                  >
                    <div className="session-title">{s.title}</div>
                    <div className="session-time">{fmtTime(s.startHour, s.startMin)}</div>
                  </div>
                ))}
            </div>
          ))}
        </div>
      </div>

      {/* Add session modal */}
      {showModal && (
        <div className="modal-overlay" onClick={handleCancel}>
          <div className="modal" onClick={e => e.stopPropagation()}>
            <h3>Add Work Session</h3>

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
              <label>Description (optional)</label>
              <textarea
                className="modal-textarea"
                value={form.description}
                onChange={e => setForm(f => ({ ...f, description: e.target.value }))}
                placeholder="What are you working on?"
                rows={3}
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

            <div className="modal-row">
              <div className="modal-field">
                <label>Start time</label>
                <input
                  type="time"
                  value={form.startTime}
                  onChange={e => {
                    const startTime = e.target.value;
                    const endTime = addMins(startTime, Number(form.duration) || 60);
                    setForm(f => ({ ...f, startTime, endTime }));
                  }}
                />
              </div>
              <div className="modal-field">
                <label>End time</label>
                <input
                  type="time"
                  value={form.endTime}
                  onChange={e => {
                    const endTime = e.target.value;
                    const mins = diffMins(form.startTime, endTime);
                    setForm(f => ({ ...f, endTime, duration: String(mins) }));
                  }}
                />
              </div>
            </div>

            <div className="modal-field">
              <label>Duration (mins)</label>
              <input
                type="number"
                min={1}
                step={15}
                value={form.duration}
                onChange={e => {
                  const duration = e.target.value;
                  const endTime = addMins(form.startTime, Number(duration) || 0);
                  setForm(f => ({ ...f, duration, endTime }));
                }}
              />
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
              <button className="btn-save" onClick={handleSave} disabled={!form.title.trim()}>Add Session</button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
