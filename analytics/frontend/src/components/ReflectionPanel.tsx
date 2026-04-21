import { useState } from 'react';
import { Session } from './WeekCalendar';

export interface ReflectionEntry {
  id: string;
  sessionId: string;
  title: string;
  description: string;
  date: string;
  startTime: string;  // "HH:mm"
  endTime: string;    // "HH:mm"
  productivity: number; // 1–5
  reflectionText: string;
  savedAt: string;    // ISO timestamp
  category?: string;
  // MCQ feedback fields — used as delayed RL reward signals
  sessionLengthFeedback?: 'too_short' | 'just_right' | 'too_long';
  timingFeedback?: 'too_early' | 'good_timing' | 'too_late';
  breaksFeedback?: 'too_many' | 'just_right' | 'too_few';
}

interface Props {
  selectedSession: Session | null;
  reflections: ReflectionEntry[];
  onSave: (entry: Omit<ReflectionEntry, 'id' | 'savedAt'>) => void;
  onClose?: () => void;
}

const FACES: { score: number; emoji: string; label: string }[] = [
  { score: 1, emoji: '😞', label: 'Not productive' },
  { score: 2, emoji: '😕', label: 'Slightly unproductive' },
  { score: 3, emoji: '😐', label: 'Neutral' },
  { score: 4, emoji: '🙂', label: 'Productive' },
  { score: 5, emoji: '😄', label: 'Very productive' },
];

function fmtTime(hour: number, min: number) {
  return `${String(hour).padStart(2, '0')}:${String(min).padStart(2, '0')}`;
}

function addMinutes(hour: number, min: number, duration: number) {
  const total = hour * 60 + min + duration;
  return fmtTime(Math.floor(total / 60) % 24, total % 60);
}

function fmtDisplay(hour: number, min: number) {
  const h = hour % 12 || 12;
  const suffix = hour < 12 ? 'AM' : 'PM';
  return `${h}:${String(min).padStart(2, '0')} ${suffix}`;
}

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

export default function ReflectionPanel({ selectedSession, reflections, onSave, onClose }: Props) {
  const [productivity, setProductivity] = useState<number | null>(null);
  const [sessionLength, setSessionLength] = useState<'too_short' | 'just_right' | 'too_long' | null>(null);
  const [timing, setTiming] = useState<'too_early' | 'good_timing' | 'too_late' | null>(null);
  const [breaks, setBreaks] = useState<'too_many' | 'just_right' | 'too_few' | null>(null);
  const [text, setText] = useState('');
  const [saved, setSaved] = useState(false);

  // Reset form when selected session changes
  const sessionKey = selectedSession?.id ?? '';
  const [lastKey, setLastKey] = useState('');
  if (sessionKey !== lastKey) {
    setLastKey(sessionKey);
    setProductivity(null);
    setSessionLength(null);
    setTiming(null);
    setBreaks(null);
    setText('');
    setSaved(false);
  }

  const sessionReflections = reflections.filter(r => r.sessionId === selectedSession?.id);

  function handleSave() {
    if (!selectedSession || !productivity) return;
    onSave({
      sessionId: selectedSession.id,
      title: selectedSession.title,
      description: selectedSession.description,
      date: selectedSession.date,
      startTime: fmtTime(selectedSession.startHour, selectedSession.startMin),
      endTime: addMinutes(selectedSession.startHour, selectedSession.startMin, selectedSession.durationMins),
      productivity,
      reflectionText: text.trim(),
      category: selectedSession.category,
      sessionLengthFeedback: sessionLength ?? undefined,
      timingFeedback: timing ?? undefined,
      breaksFeedback: breaks ?? undefined,
    });
    setSaved(true);
    setText('');
    setProductivity(null);
    setSessionLength(null);
    setTiming(null);
    setBreaks(null);
  }

  return (
    <div className="reflection-panel">
      {/* Header */}
      <div className="reflection-panel-header" style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
        <span>
          Reflect on work session
          {selectedSession && (
            <span className="rp-session-label"> — {selectedSession.title}</span>
          )}
        </span>
        {onClose && (
          <button onClick={onClose} style={{ background: 'none', border: 'none', cursor: 'pointer', fontSize: '1.1rem', color: '#666', lineHeight: 1 }}>✕</button>
        )}
      </div>

      {/* Instructions banner — always visible */}
      <div className="rp-instructions">
        <span className="rp-instructions-icon">💡</span>
        Log your work sessions by clicking an area in the calendar, adding the work session, and writing any reflections!
      </div>

      <div className="rp-body">
        {!selectedSession ? (
          <div className="rp-empty">
            <div className="rp-empty-icon">📅</div>
            <p>Click a session on the calendar to reflect on it, or click any time slot to add a new one.</p>
          </div>
        ) : (
          <>
            {/* Session info card */}
            <div className="rp-session-card" style={{ borderLeft: `4px solid ${selectedSession.color}` }}>
              <div className="rp-session-title">{selectedSession.title}</div>
              {selectedSession.description && (
                <div className="rp-session-desc">{selectedSession.description}</div>
              )}
              <div className="rp-session-meta">
                {selectedSession.date} &nbsp;·&nbsp;
                {fmtDisplay(selectedSession.startHour, selectedSession.startMin)}
                {' – '}
                {fmtDisplay(
                  Math.floor((selectedSession.startHour * 60 + selectedSession.startMin + selectedSession.durationMins) / 60) % 24,
                  (selectedSession.startMin + selectedSession.durationMins) % 60,
                )}
                &nbsp;·&nbsp; {selectedSession.durationMins} min
              </div>
            </div>

            {/* Productivity scale */}
            <div className="rp-section-label">How productive were you?</div>
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

            {/* MCQ: session length */}
            <div className="rp-section-label" style={{ marginTop: 16 }}>Was the session length right?</div>
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
            <div className="rp-section-label" style={{ marginTop: 12 }}>Was the timing right?</div>
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
            <div className="rp-section-label" style={{ marginTop: 12 }}>How were the breaks?</div>
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

            {/* Reflection text — optional */}
            <div className="rp-section-label" style={{ marginTop: 12 }}>Notes <span style={{ fontWeight: 400, color: '#999' }}>(optional)</span></div>
            <textarea
              className="rp-textarea"
              value={text}
              onChange={e => setText(e.target.value)}
              placeholder="How did the session go? What did you accomplish? Any blockers?"
              rows={3}
            />

            <button
              className="rp-save-btn"
              onClick={handleSave}
              disabled={!productivity}
            >
              Save Reflection
            </button>

            {saved && (
              <div className="rp-saved-confirm">✓ Reflection saved!</div>
            )}

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
          </>
        )}
      </div>
    </div>
  );
}
