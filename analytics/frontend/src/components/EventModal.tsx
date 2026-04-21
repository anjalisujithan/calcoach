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

interface Props {
  session: Session;
  reflections: ReflectionEntry[];
  categories?: string[];
  onAddCategory?: (cat: string) => void;
  onDeleteCategory?: (cat: string) => void;
  onClose: () => void;
  onSave: (id: string, s: Omit<Session, 'id'>) => void;
  onDelete: (id: string) => void;
  onSaveReflection: (entry: Omit<ReflectionEntry, 'id' | 'savedAt'>) => void;
}

export default function EventModal({ session, reflections, categories = [], onAddCategory, onDeleteCategory, onClose, onSave, onDelete, onSaveReflection }: Props) {
  const initStart = toTimeStr(session.startHour, session.startMin);
  const initEnd = addMinsStr(initStart, session.durationMins);

  const [title, setTitle] = useState(session.title);
  const [date, setDate] = useState(session.date);
  const [startTime, setStartTime] = useState(initStart);
  const [endTime, setEndTime] = useState(initEnd);
  const [color, setColor] = useState(session.color);
  const [category, setCategory] = useState(session.category ?? '');
  const [showNewCat, setShowNewCat] = useState(false);
  const [newCatInput, setNewCatInput] = useState('');
  const [editSaved, setEditSaved] = useState(false);

  const [productivity, setProductivity] = useState<number | null>(null);
  const [sessionLength, setSessionLength] = useState<'too_short' | 'just_right' | 'too_long' | null>(null);
  const [timing, setTiming] = useState<'too_early' | 'good_timing' | 'too_late' | null>(null);
  const [breaks, setBreaks] = useState<'too_many' | 'just_right' | 'too_few' | null>(null);
  const [reflText, setReflText] = useState('');
  const [reflSaved, setReflSaved] = useState(false);

  const [lastId, setLastId] = useState(session.id);
  if (session.id !== lastId) {
    setLastId(session.id);
    const s = toTimeStr(session.startHour, session.startMin);
    setTitle(session.title);
    setDate(session.date);
    setStartTime(s);
    setEndTime(addMinsStr(s, session.durationMins));
    setColor(session.color);
    setCategory(session.category ?? '');
    setShowNewCat(false);
    setNewCatInput('');
    setEditSaved(false);
    setProductivity(null);
    setSessionLength(null);
    setTiming(null);
    setBreaks(null);
    setReflText('');
    setReflSaved(false);
  }

  const sessionReflections = reflections.filter(r => r.sessionId === session.id);

  function handleSaveEdit() {
    const [h, m] = startTime.split(':').map(Number);
    onSave(session.id, {
      title: title.trim() || session.title,
      description: session.description,
      date,
      dayIndex: new Date(date + 'T12:00:00').getDay(),
      startHour: h,
      startMin: m,
      durationMins: Math.max(1, diffMinsStr(startTime, endTime)),
      color,
      recurrence: session.recurrence,
      category: category || undefined,
    });
    onClose();
  }

  function handleSaveReflection() {
    if (!productivity) return;
    onSaveReflection({
      sessionId: session.id,
      title: session.title,
      description: session.description,
      date: session.date,
      startTime,
      endTime,
      productivity,
      reflectionText: reflText.trim(),
      sessionLengthFeedback: sessionLength ?? undefined,
      timingFeedback: timing ?? undefined,
      breaksFeedback: breaks ?? undefined,
    });
    setReflSaved(true);
    setReflText('');
    setProductivity(null);
    setSessionLength(null);
    setTiming(null);
    setBreaks(null);
    setTimeout(() => setReflSaved(false), 2000);
  }

  return (
    <div
      className="modal-overlay"
      onClick={onClose}
    >
      <div
        onClick={e => e.stopPropagation()}
        style={{
          background: '#fff',
          borderRadius: '12px',
          boxShadow: '0 8px 40px rgba(0,0,0,0.18)',
          width: '680px',
          maxWidth: '95vw',
          maxHeight: '85vh',
          overflow: 'hidden',
          display: 'flex',
          flexDirection: 'column',
        }}
      >
        {/* Header */}
        <div style={{
          display: 'flex', alignItems: 'center', justifyContent: 'space-between',
          padding: '1rem 1.25rem 0.75rem',
          borderBottom: `3px solid ${session.color}`,
        }}>
          <div>
            <div style={{ fontWeight: 700, fontSize: '1.05rem' }}>{session.title}</div>
            <div style={{ fontSize: '0.8rem', color: '#666', marginTop: '0.1rem' }}>
              {session.date} &nbsp;·&nbsp;
              {fmtDisplay(session.startHour, session.startMin)}
              {' – '}
              {fmtDisplay(
                Math.floor((session.startHour * 60 + session.startMin + session.durationMins) / 60) % 24,
                (session.startMin + session.durationMins) % 60,
              )}
            </div>
          </div>
          <button onClick={onClose} style={{ background: 'none', border: 'none', fontSize: '1.2rem', cursor: 'pointer', color: '#666' }}>✕</button>
        </div>

        {/* Two columns */}
        <div style={{ display: 'flex', flex: 1, overflow: 'hidden' }}>

          {/* ── Left: Edit ── */}
          <div style={{
            flex: 1, padding: '1rem 1.25rem', overflowY: 'auto',
            borderRight: '1px solid #e0e0e0',
          }}>
            <div style={{ fontWeight: 600, fontSize: '0.85rem', color: '#555', marginBottom: '0.75rem', textTransform: 'uppercase', letterSpacing: '0.05em' }}>
              Edit
            </div>

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
                <input type="time" value={startTime} onChange={e => {
                  const dur = diffMinsStr(startTime, endTime);
                  setStartTime(e.target.value);
                  setEndTime(addMinsStr(e.target.value, dur));
                }} />
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
                  <button key={c} className={`color-swatch ${color === c ? 'selected' : ''}`} style={{ background: c }} onClick={() => setColor(c)} />
                ))}
              </div>
            </div>

            <div className="modal-field">
              <label>Category</label>
              <div style={{ display: 'flex', flexWrap: 'wrap', gap: '0.3rem', marginTop: '2px' }}>
                <button
                  type="button"
                  onClick={() => setCategory('')}
                  style={{
                    padding: '0.2rem 0.55rem', borderRadius: '999px', fontSize: '0.78rem', cursor: 'pointer',
                    border: category === '' ? '1.5px solid #4285f4' : '1.5px solid #ccc',
                    background: category === '' ? '#e8f0fe' : '#f5f5f5',
                    color: category === '' ? '#1a73e8' : '#444', fontWeight: 500,
                  }}
                >None</button>
                {categories.map((c: string) => (
                  <span key={c} style={{ display: 'inline-flex', alignItems: 'center', gap: '0.2rem' }}>
                    <button
                      type="button"
                      onClick={() => setCategory(c)}
                      style={{
                        padding: '0.2rem 0.55rem', borderRadius: '999px', fontSize: '0.78rem', cursor: 'pointer',
                        border: category === c ? '1.5px solid #4285f4' : '1.5px solid #ccc',
                        background: category === c ? '#e8f0fe' : '#f5f5f5',
                        color: category === c ? '#1a73e8' : '#444', fontWeight: 500,
                      }}
                    >{c}</button>
                    <button
                      type="button"
                      title={`Delete "${c}"`}
                      onClick={() => {
                        onDeleteCategory?.(c);
                        if (category === c) setCategory('');
                      }}
                      style={{
                        background: 'none', border: 'none', cursor: 'pointer', color: '#aaa',
                        fontSize: '0.7rem', padding: '0', lineHeight: 1,
                      }}
                    >✕</button>
                  </span>
                ))}
                {!showNewCat ? (
                  <button type="button" onClick={() => setShowNewCat(true)}
                    style={{ padding: '0.2rem 0.55rem', borderRadius: '999px', fontSize: '0.78rem', cursor: 'pointer', border: '1.5px dashed #aaa', background: 'none', color: '#666' }}>
                    + Add
                  </button>
                ) : (
                  <div style={{ display: 'flex', gap: '0.3rem', alignItems: 'center' }}>
                    <input autoFocus value={newCatInput} onChange={e => setNewCatInput(e.target.value)}
                      placeholder="Name" style={{ width: '90px', fontSize: '0.8rem', padding: '0.2rem 0.4rem' }}
                      onKeyDown={e => {
                        if (e.key === 'Enter' && newCatInput.trim()) {
                          onAddCategory?.(newCatInput.trim()); setCategory(newCatInput.trim()); setNewCatInput(''); setShowNewCat(false);
                        } else if (e.key === 'Escape') { setNewCatInput(''); setShowNewCat(false); }
                      }}
                    />
                    <button type="button" className="btn-save" style={{ padding: '0.2rem 0.5rem', fontSize: '0.78rem' }}
                      onClick={() => { if (newCatInput.trim()) { onAddCategory?.(newCatInput.trim()); setCategory(newCatInput.trim()); setNewCatInput(''); setShowNewCat(false); } }}>Add</button>
                    <button type="button" onClick={() => { setNewCatInput(''); setShowNewCat(false); }}
                      style={{ background: 'none', border: 'none', cursor: 'pointer', color: '#aaa', fontSize: '0.85rem' }}>✕</button>
                  </div>
                )}
              </div>
            </div>

            <div style={{ display: 'flex', gap: '0.5rem', marginTop: '0.75rem' }}>
              <button className="btn-save" onClick={handleSaveEdit} disabled={!title.trim()}>
                {editSaved ? '✓ Saved' : 'Save Changes'}
              </button>
              <button
                onClick={() => { onDelete(session.id); onClose(); }}
                style={{ background: '#ea4335', color: '#fff', border: 'none', borderRadius: '6px', padding: '0.4rem 0.8rem', cursor: 'pointer', fontWeight: 600, fontSize: '0.85rem' }}
              >
                Delete
              </button>
            </div>
          </div>

          {/* ── Right: Reflect ── */}
          <div style={{ flex: 1, padding: '1rem 1.25rem', overflowY: 'auto' }}>
            <div style={{ fontWeight: 600, fontSize: '0.85rem', color: '#555', marginBottom: '0.75rem', textTransform: 'uppercase', letterSpacing: '0.05em' }}>
              Reflect
            </div>

            <div style={{ fontSize: '0.82rem', color: '#555', marginBottom: '0.5rem' }}>How productive were you?</div>
            <div className="productivity-scale">
              {FACES.map(f => (
                <button key={f.score} className={`face-btn ${productivity === f.score ? 'selected' : ''}`} onClick={() => setProductivity(f.score)} title={f.label}>
                  <span className="face-emoji">{f.emoji}</span>
                  <span className="face-score">{f.score}</span>
                </button>
              ))}
            </div>
            {productivity !== null && <div className="productivity-label">{FACES[productivity - 1].label}</div>}

            {/* MCQ: session length */}
            <div style={{ fontSize: '0.82rem', color: '#555', margin: '0.75rem 0 0.35rem' }}>Was the session length right?</div>
            <div style={{ display: 'flex', gap: '0.4rem', marginBottom: '0.25rem' }}>
              {SESSION_LENGTH_OPTIONS.map(opt => (
                <button
                  key={opt.value}
                  onClick={() => setSessionLength(sessionLength === opt.value ? null : opt.value)}
                  style={{
                    padding: '0.25rem 0.6rem', borderRadius: '999px', fontSize: '0.78rem',
                    cursor: 'pointer', fontWeight: 500,
                    border: sessionLength === opt.value ? '1.5px solid #4285f4' : '1.5px solid #ccc',
                    background: sessionLength === opt.value ? '#e8f0fe' : '#f5f5f5',
                    color: sessionLength === opt.value ? '#1a73e8' : '#555',
                  }}
                >{opt.label}</button>
              ))}
            </div>

            {/* MCQ: timing */}
            <div style={{ fontSize: '0.82rem', color: '#555', margin: '0.6rem 0 0.35rem' }}>Was the timing right?</div>
            <div style={{ display: 'flex', gap: '0.4rem', marginBottom: '0.25rem' }}>
              {TIMING_OPTIONS.map(opt => (
                <button
                  key={opt.value}
                  onClick={() => setTiming(timing === opt.value ? null : opt.value)}
                  style={{
                    padding: '0.25rem 0.6rem', borderRadius: '999px', fontSize: '0.78rem',
                    cursor: 'pointer', fontWeight: 500,
                    border: timing === opt.value ? '1.5px solid #4285f4' : '1.5px solid #ccc',
                    background: timing === opt.value ? '#e8f0fe' : '#f5f5f5',
                    color: timing === opt.value ? '#1a73e8' : '#555',
                  }}
                >{opt.label}</button>
              ))}
            </div>

            {/* MCQ: breaks */}
            <div style={{ fontSize: '0.82rem', color: '#555', margin: '0.6rem 0 0.35rem' }}>How were the breaks?</div>
            <div style={{ display: 'flex', gap: '0.4rem', marginBottom: '0.25rem' }}>
              {BREAKS_OPTIONS.map(opt => (
                <button
                  key={opt.value}
                  onClick={() => setBreaks(breaks === opt.value ? null : opt.value)}
                  style={{
                    padding: '0.25rem 0.6rem', borderRadius: '999px', fontSize: '0.78rem',
                    cursor: 'pointer', fontWeight: 500,
                    border: breaks === opt.value ? '1.5px solid #4285f4' : '1.5px solid #ccc',
                    background: breaks === opt.value ? '#e8f0fe' : '#f5f5f5',
                    color: breaks === opt.value ? '#1a73e8' : '#555',
                  }}
                >{opt.label}</button>
              ))}
            </div>

            {/* Free text — optional */}
            <div style={{ fontSize: '0.82rem', color: '#555', margin: '0.6rem 0 0.35rem' }}>
              Notes <span style={{ color: '#aaa', fontWeight: 400 }}>(optional)</span>
            </div>
            <textarea
              className="rp-textarea"
              value={reflText}
              onChange={e => setReflText(e.target.value)}
              placeholder="How did it go? What did you accomplish? Any blockers?"
              rows={3}
            />

            <button className="rp-save-btn" onClick={handleSaveReflection} disabled={!productivity}>
              Save Reflection
            </button>
            {reflSaved && <div className="rp-saved-confirm">✓ Reflection saved!</div>}

            {sessionReflections.length > 0 && (
              <div className="rp-history" style={{ marginTop: '1rem' }}>
                <div style={{ fontWeight: 600, fontSize: '0.82rem', color: '#555', marginBottom: '0.5rem' }}>
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
                      <div style={{ fontSize: '0.75rem', color: '#888', marginTop: '0.2rem', display: 'flex', gap: '0.5rem', flexWrap: 'wrap' }}>
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
