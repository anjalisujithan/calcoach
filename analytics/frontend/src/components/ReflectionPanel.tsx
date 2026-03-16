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
}

interface Props {
  selectedSession: Session | null;
  reflections: ReflectionEntry[];
  onSave: (entry: Omit<ReflectionEntry, 'id' | 'savedAt'>) => void;
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

export default function ReflectionPanel({ selectedSession, reflections, onSave }: Props) {
  const [productivity, setProductivity] = useState<number | null>(null);
  const [text, setText] = useState('');
  const [saved, setSaved] = useState(false);

  // Reset form when selected session changes
  const sessionKey = selectedSession?.id ?? '';
  const [lastKey, setLastKey] = useState('');
  if (sessionKey !== lastKey) {
    setLastKey(sessionKey);
    setProductivity(null);
    setText('');
    setSaved(false);
  }

  const sessionReflections = reflections.filter(r => r.sessionId === selectedSession?.id);

  function handleSave() {
    if (!selectedSession || !productivity || !text.trim()) return;
    onSave({
      sessionId: selectedSession.id,
      title: selectedSession.title,
      description: selectedSession.description,
      date: selectedSession.date,
      startTime: fmtTime(selectedSession.startHour, selectedSession.startMin),
      endTime: addMinutes(selectedSession.startHour, selectedSession.startMin, selectedSession.durationMins),
      productivity,
      reflectionText: text.trim(),
    });
    setSaved(true);
    setText('');
    setProductivity(null);
  }

  return (
    <div className="reflection-panel">
      {/* Header */}
      <div className="reflection-panel-header">
        Reflect on work session
        {selectedSession && (
          <span className="rp-session-label"> — {selectedSession.title}</span>
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

            {/* Reflection text */}
            <div className="rp-section-label" style={{ marginTop: 16 }}>Your reflection</div>
            <textarea
              className="rp-textarea"
              value={text}
              onChange={e => setText(e.target.value)}
              placeholder="How did the session go? What did you accomplish? Any blockers?"
              rows={4}
            />

            <button
              className="rp-save-btn"
              onClick={handleSave}
              disabled={!productivity || !text.trim()}
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
                    <div className="rp-history-text">{r.reflectionText}</div>
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
