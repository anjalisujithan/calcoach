import { useState } from 'react';
import { Session } from './WeekCalendar';
import { ReflectionEntry } from './ReflectionPanel';

const FACES = [
  { score: 1, emoji: '😞', label: 'Not productive' },
  { score: 2, emoji: '😕', label: 'Slightly unproductive' },
  { score: 3, emoji: '😐', label: 'Neutral' },
  { score: 4, emoji: '🙂', label: 'Productive' },
  { score: 5, emoji: '😄', label: 'Very productive' },
];

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

interface Props {
  session: Session;
  reflections: ReflectionEntry[];
  onClose: () => void;
  onSave: (id: string, s: Omit<Session, 'id'>) => void;
  onDelete: (id: string) => void;
  onSaveReflection: (entry: Omit<ReflectionEntry, 'id' | 'savedAt'>) => void;
}

export default function EventDetailPanel({ session, reflections, onClose, onSave, onDelete, onSaveReflection }: Props) {
  const initStart = toTimeStr(session.startHour, session.startMin);
  const initEnd = addMinsStr(initStart, session.durationMins);

  const [title, setTitle] = useState(session.title);
  const [date, setDate] = useState(session.date);
  const [startTime, setStartTime] = useState(initStart);
  const [endTime, setEndTime] = useState(initEnd);
  const [color, setColor] = useState(session.color);
  const [editSaved, setEditSaved] = useState(false);

  const [productivity, setProductivity] = useState<number | null>(null);
  const [reflText, setReflText] = useState('');
  const [reflSaved, setReflSaved] = useState(false);

  // Reset form when a different session is selected
  const [lastId, setLastId] = useState(session.id);
  if (session.id !== lastId) {
    setLastId(session.id);
    const s = toTimeStr(session.startHour, session.startMin);
    const e = addMinsStr(s, session.durationMins);
    setTitle(session.title);
    setDate(session.date);
    setStartTime(s);
    setEndTime(e);
    setColor(session.color);
    setEditSaved(false);
    setProductivity(null);
    setReflText('');
    setReflSaved(false);
  }

  const sessionReflections = reflections.filter(r => r.sessionId === session.id);

  function handleSaveEdit() {
    const [h, m] = startTime.split(':').map(Number);
    const dayIndex = new Date(date + 'T12:00:00').getDay();
    onSave(session.id, {
      title: title.trim() || session.title,
      description: session.description,
      date,
      dayIndex,
      startHour: h,
      startMin: m,
      durationMins: Math.max(1, diffMinsStr(startTime, endTime)),
      color,
      recurrence: session.recurrence,
    });
    setEditSaved(true);
    setTimeout(() => setEditSaved(false), 2000);
  }

  function handleSaveReflection() {
    if (!productivity || !reflText.trim()) return;
    onSaveReflection({
      sessionId: session.id,
      title: session.title,
      description: session.description,
      date: session.date,
      startTime,
      endTime,
      productivity,
      reflectionText: reflText.trim(),
    });
    setReflSaved(true);
    setReflText('');
    setProductivity(null);
    setTimeout(() => setReflSaved(false), 2000);
  }

  return (
    <div className="reflection-panel">
      <div className="reflection-panel-header" style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
        <span style={{ borderLeft: `4px solid ${session.color}`, paddingLeft: '0.5rem' }}>
          {session.title}
        </span>
        <button onClick={onClose} style={{ background: 'none', border: 'none', cursor: 'pointer', fontSize: '1.1rem', color: '#666' }}>
          ✕
        </button>
      </div>

      <div className="rp-body">

        {/* ── Edit section ── */}
        <div className="rp-section-label">Edit</div>

        <div className="modal-field">
          <label>Title</label>
          <input value={title} onChange={e => setTitle(e.target.value)} />
        </div>

        <div className="modal-field">
          <label>Date</label>
          <input type="date" value={date} onChange={e => setDate(e.target.value)} />
        </div>

        <div className="modal-row">
          <div className="modal-field">
            <label>Start</label>
            <input
              type="time"
              value={startTime}
              onChange={e => {
                const dur = diffMinsStr(startTime, endTime);
                setStartTime(e.target.value);
                setEndTime(addMinsStr(e.target.value, dur));
              }}
            />
          </div>
          <div className="modal-field">
            <label>End</label>
            <input type="time" value={endTime} onChange={e => setEndTime(e.target.value)} />
          </div>
        </div>

        <div className="modal-field">
          <label>Color</label>
          <div className="color-palette">
            {COLOR_PALETTE.map(c => (
              <button
                key={c}
                className={`color-swatch ${color === c ? 'selected' : ''}`}
                style={{ background: c }}
                onClick={() => setColor(c)}
              />
            ))}
          </div>
        </div>

        <div style={{ display: 'flex', gap: '0.5rem', marginTop: '0.75rem' }}>
          <button className="btn-save" onClick={handleSaveEdit} disabled={!title.trim()}>
            {editSaved ? '✓ Saved' : 'Save Changes'}
          </button>
          <button
            onClick={() => onDelete(session.id)}
            style={{
              background: '#ea4335', color: '#fff', border: 'none',
              borderRadius: '6px', padding: '0.4rem 0.8rem',
              cursor: 'pointer', fontWeight: 600, fontSize: '0.85rem',
            }}
          >
            Delete
          </button>
        </div>

        {/* ── Divider ── */}
        <div style={{ borderTop: '1px solid #e0e0e0', margin: '1.25rem 0' }} />

        {/* ── Reflect section ── */}
        <div className="rp-section-label">Reflect on this session</div>

        <div style={{ marginTop: '0.5rem', marginBottom: '0.25rem', fontSize: '0.82rem', color: '#555' }}>
          How productive were you?
        </div>
        <div className="productivity-scale">
          {FACES.map(f => (
            <button
              key={f.score}
              className={`face-btn ${productivity === f.score ? 'selected' : ''}`}
              onClick={() => setProductivity(f.score)}
              title={f.label}
            >
              <span className="face-emoji">{f.emoji}</span>
              <span className="face-score">{f.score}</span>
            </button>
          ))}
        </div>
        {productivity !== null && (
          <div className="productivity-label">{FACES[productivity - 1].label}</div>
        )}

        <textarea
          className="rp-textarea"
          style={{ marginTop: '0.75rem' }}
          value={reflText}
          onChange={e => setReflText(e.target.value)}
          placeholder="How did the session go? What did you accomplish? Any blockers?"
          rows={3}
        />

        <button
          className="rp-save-btn"
          onClick={handleSaveReflection}
          disabled={!productivity || !reflText.trim()}
        >
          Save Reflection
        </button>

        {reflSaved && <div className="rp-saved-confirm">✓ Reflection saved!</div>}

        {/* Past reflections */}
        {sessionReflections.length > 0 && (
          <div className="rp-history">
            <div className="rp-section-label" style={{ marginBottom: 8 }}>
              Past reflections ({sessionReflections.length})
            </div>
            {sessionReflections.map(r => (
              <div key={r.id} className="rp-history-entry">
                <div className="rp-history-header">
                  <span className="rp-history-face">{FACES[r.productivity - 1].emoji}</span>
                  <span className="rp-history-score">Productivity: {r.productivity}/5</span>
                  <span className="rp-history-date">{new Date(r.savedAt).toLocaleString()}</span>
                </div>
                <div className="rp-history-text">{r.reflectionText}</div>
              </div>
            ))}
          </div>
        )}
      </div>
    </div>
  );
}
