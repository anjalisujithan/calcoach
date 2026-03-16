import { useState } from 'react';
import { format, startOfWeek, addDays, isSameDay, addWeeks, subWeeks } from 'date-fns';

export interface Session {
  id: string;
  title: string;
  dayIndex: number; // 0=Sun … 6=Sat
  startHour: number;
  startMin: number;
  durationMins: number;
  reflection?: string;
}

interface Props {
  sessions?: Session[];
  selectedSession?: string | null;
  onSelectSession?: (id: string) => void;
  onAddSession?: (s: Omit<Session, 'id'>) => void;
  showAddButton?: boolean;
}

const HOURS = Array.from({ length: 24 }, (_, i) => i);
const DAY_NAMES = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
const COLORS = ['#4285f4', '#ea4335', '#34a853', '#fbbc04', '#9c27b0', '#00acc1', '#e91e63'];

export default function WeekCalendar({
  sessions = [],
  selectedSession,
  onSelectSession,
  onAddSession,
  showAddButton = false,
}: Props) {
  const [weekStart, setWeekStart] = useState(() =>
    startOfWeek(new Date(), { weekStartsOn: 0 })
  );
  const [showModal, setShowModal] = useState(false);
  const [form, setForm] = useState({
    title: '',
    day: '1',
    startTime: '09:00',
    duration: '60',
  });

  const today = new Date();
  const days = Array.from({ length: 7 }, (_, i) => addDays(weekStart, i));

  const weekLabel = `${format(weekStart, 'MMMM d')} – ${format(addDays(weekStart, 6), 'd, yyyy')}`;

  function handleSave() {
    if (!form.title) return;
    const [h, m] = form.startTime.split(':').map(Number);
    onAddSession?.({
      title: form.title,
      dayIndex: Number(form.day),
      startHour: h,
      startMin: m,
      durationMins: Number(form.duration),
    });
    setShowModal(false);
    setForm({ title: '', day: '1', startTime: '09:00', duration: '60' });
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
      </div>

      {/* grid */}
      <div className="week-grid">
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

          {/* day columns */}
          {days.map((_, colIdx) => (
            <div key={colIdx} className="day-column">
              {HOURS.map(h => (
                <div key={h} className="hour-line" style={{ top: h * 60 }} />
              ))}
              {sessions
                .filter(s => s.dayIndex === colIdx)
                .map((s, si) => (
                  <div
                    key={s.id}
                    className={`session-block ${selectedSession === s.id ? 'selected' : ''}`}
                    style={{
                      top: s.startHour * 60 + s.startMin,
                      height: Math.max(s.durationMins, 20),
                      background: COLORS[si % COLORS.length],
                    }}
                    onClick={() => onSelectSession?.(s.id)}
                  >
                    <div className="session-title">{s.title}</div>
                    <div className="session-time">
                      {`${s.startHour % 12 || 12}:${String(s.startMin).padStart(2, '0')} ${s.startHour < 12 ? 'AM' : 'PM'}`}
                    </div>
                  </div>
                ))}
            </div>
          ))}
        </div>
      </div>

      {showAddButton && (
        <div className="add-session-bar">
          <button className="add-session-btn" onClick={() => setShowModal(true)}>
            + Add Work Session
          </button>
        </div>
      )}

      {showModal && (
        <div className="modal-overlay" onClick={() => setShowModal(false)}>
          <div className="modal" onClick={e => e.stopPropagation()}>
            <h3>Add Work Session</h3>
            <div className="modal-field">
              <label>Title</label>
              <input
                value={form.title}
                onChange={e => setForm(f => ({ ...f, title: e.target.value }))}
                placeholder="e.g. CS61A Homework"
              />
            </div>
            <div className="modal-field">
              <label>Day</label>
              <select value={form.day} onChange={e => setForm(f => ({ ...f, day: e.target.value }))}>
                {DAY_NAMES.map((d, i) => <option key={i} value={i}>{d}</option>)}
              </select>
            </div>
            <div className="modal-row">
              <div className="modal-field">
                <label>Start time</label>
                <input
                  type="time"
                  value={form.startTime}
                  onChange={e => setForm(f => ({ ...f, startTime: e.target.value }))}
                />
              </div>
              <div className="modal-field">
                <label>Duration (mins)</label>
                <input
                  type="number"
                  min={15}
                  step={15}
                  value={form.duration}
                  onChange={e => setForm(f => ({ ...f, duration: e.target.value }))}
                />
              </div>
            </div>
            <div className="modal-actions">
              <button className="btn-cancel" onClick={() => setShowModal(false)}>Cancel</button>
              <button className="btn-save" onClick={handleSave}>Add</button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
