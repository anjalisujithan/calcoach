import { useState, useEffect } from 'react';
import { SurveyAnswers } from './OnboardingSurvey';

const API = import.meta.env.VITE_ANALYTICS_API ?? 'http://localhost:8001';

const DEFAULT_ANSWERS: SurveyAnswers = {
  userType: '',
  helpWith: [],
  workDays: ['weekdays'],
  workStartHour: 9,
  workEndHour: 21,
  workStyle: '',
  planningHorizon: '',
  chunkSize: '',
};

interface Props {
  userEmail: string;
}

export default function PreferencesTab({ userEmail }: Props) {
  const [answers, setAnswers] = useState<SurveyAnswers>(DEFAULT_ANSWERS);
  const [saving, setSaving] = useState(false);
  const [status, setStatus] = useState<'idle' | 'success' | 'error'>('idle');

  useEffect(() => {
    // Try localStorage first for an instant load
    const local = localStorage.getItem('calcoach_survey_answers');
    if (local) {
      try {
        setAnswers(JSON.parse(local));
      } catch { /* ignore */ }
    }
    // Fetch server-side copy (may be more up-to-date)
    if (userEmail) {
      fetch(`${API}/preferences?email=${encodeURIComponent(userEmail)}`)
        .then(r => r.json())
        .then(data => {
          if (data?.survey_answers) {
            setAnswers(data.survey_answers);
          }
        })
        .catch(() => { /* silently fall back to localStorage */ });
    }
  }, [userEmail]);

  function toggleMulti(field: 'helpWith' | 'workDays', value: string) {
    setAnswers(prev => {
      const arr = prev[field];
      return { ...prev, [field]: arr.includes(value) ? arr.filter(x => x !== value) : [...arr, value] };
    });
  }

  const chip = (selected: boolean): React.CSSProperties => ({
    padding: '0.45rem 1rem',
    borderRadius: '999px',
    border: `2px solid ${selected ? '#4285f4' : '#ccc'}`,
    background: selected ? '#e8f0fe' : '#fff',
    color: selected ? '#1a73e8' : '#555',
    cursor: 'pointer',
    fontWeight: selected ? 600 : 400,
    fontSize: '0.88rem',
    transition: 'all 0.15s',
  });

  const cardStyle: React.CSSProperties = {
    background: '#fff',
    borderRadius: '12px',
    padding: '1.5rem',
    border: '1px solid #e0e0e0',
    marginBottom: '1rem',
  };

  const labelStyle: React.CSSProperties = {
    fontSize: '0.85rem',
    fontWeight: 600,
    color: '#444',
    marginBottom: '0.75rem',
    display: 'block',
  };

  async function handleSave() {
    setSaving(true);
    setStatus('idle');
    try {
      const res = await fetch(`${API}/onboarding`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ ...answers, email: userEmail }),
      });
      const data = await res.json().catch(() => ({}));
      // The backend returns `ok: true` only when the survey was actually
      // persisted to Firestore. Anything else (no email, save error, etc.)
      // should surface as an error so we don't lie to the user.
      if (res.ok && data.ok === true) {
        localStorage.setItem('calcoach_survey_answers', JSON.stringify(answers));
        setStatus('success');
      } else {
        console.warn('Failed to save preferences:', data);
        setStatus('error');
      }
    } catch (err) {
      console.warn('Failed to save preferences:', err);
      setStatus('error');
    } finally {
      setSaving(false);
      setTimeout(() => setStatus('idle'), 3500);
    }
  }

  const isValid =
    !!answers.userType &&
    answers.helpWith.length > 0 &&
    answers.workDays.length > 0 &&
    answers.workStartHour < answers.workEndHour &&
    !!answers.workStyle &&
    !!answers.planningHorizon &&
    !!answers.chunkSize;

  return (
    <div style={{ padding: '1.5rem 2rem', maxWidth: '660px', margin: '0 auto', overflowY: 'auto', height: '100%' }}>
      <h2 style={{ fontSize: '1.3rem', fontWeight: 700, marginBottom: '0.3rem', color: '#1a1a2e' }}>
        Scheduling Preferences
      </h2>
      <p style={{ fontSize: '0.88rem', color: '#666', marginBottom: '1.5rem' }}>
        Update how CalCoach schedules sessions for you :)
      </p>

      {/* Who are you */}
      <div style={cardStyle}>
        <span style={labelStyle}>Who are you?</span>
        <div style={{ display: 'flex', flexWrap: 'wrap', gap: '0.5rem' }}>
          {[
            ['college_student', '🎓 College student'],
            ['grad_student', '🔬 Grad student'],
            ['working_professional', '💼 Working professional'],
            ['other', '👤 Other'],
          ].map(([val, label]) => (
            <button key={val} style={chip(answers.userType === val)}
              onClick={() => setAnswers(a => ({ ...a, userType: val }))}>
              {label}
            </button>
          ))}
        </div>
      </div>

      {/* Help with */}
      <div style={cardStyle}>
        <span style={labelStyle}>What do you want help scheduling?</span>
        <div style={{ display: 'flex', flexWrap: 'wrap', gap: '0.5rem' }}>
          {[
            ['assignments', '📚 Assignments'],
            ['studying', '📖 Studying'],
            ['extracurriculars', '⚽ Extracurriculars'],
            ['work_projects', '💻 Work projects'],
            ['personal', '🏃 Personal goals'],
          ].map(([val, label]) => (
            <button key={val} style={chip(answers.helpWith.includes(val))}
              onClick={() => toggleMulti('helpWith', val)}>
              {label}
            </button>
          ))}
        </div>
      </div>

      {/* Work days + hours */}
      <div style={cardStyle}>
        <span style={labelStyle}>When do you like to work?</span>
        <div style={{ marginBottom: '0.8rem' }}>
          <p style={{ fontSize: '0.82rem', color: '#666', marginBottom: '0.4rem' }}>Preferred days</p>
          <div style={{ display: 'flex', gap: '0.5rem' }}>
            {[['weekdays', '📅 Weekdays'], ['weekends', '🏖 Weekends']].map(([val, label]) => (
              <button key={val} style={chip(answers.workDays.includes(val))}
                onClick={() => toggleMulti('workDays', val)}>
                {label}
              </button>
            ))}
          </div>
        </div>
        <div style={{ display: 'flex', gap: '1rem' }}>
          <div style={{ flex: 1 }}>
            <label style={{ fontSize: '0.82rem', color: '#666', display: 'block', marginBottom: '4px' }}>Start time</label>
            <select value={answers.workStartHour}
              onChange={e => setAnswers(a => ({ ...a, workStartHour: Number(e.target.value) }))}
              style={{ width: '100%', padding: '0.4rem', borderRadius: '6px', border: '1px solid #ccc' }}>
              {Array.from({ length: 17 }, (_, i) => i + 6).map(h => (
                <option key={h} value={h}>{h % 12 || 12} {h < 12 ? 'AM' : 'PM'}</option>
              ))}
            </select>
          </div>
          <div style={{ flex: 1 }}>
            <label style={{ fontSize: '0.82rem', color: '#666', display: 'block', marginBottom: '4px' }}>End time</label>
            <select value={answers.workEndHour}
              onChange={e => setAnswers(a => ({ ...a, workEndHour: Number(e.target.value) }))}
              style={{ width: '100%', padding: '0.4rem', borderRadius: '6px', border: '1px solid #ccc' }}>
              {Array.from({ length: 17 }, (_, i) => i + 7).map(h => (
                <option key={h} value={h}>{h % 12 || 12} {h < 12 ? 'AM' : 'PM'}</option>
              ))}
            </select>
          </div>
        </div>
        {answers.workStartHour >= answers.workEndHour && (
          <p style={{ color: '#d93025', fontSize: '0.8rem', marginTop: '0.4rem' }}>
            Start time must be before end time.
          </p>
        )}
      </div>

      {/* Work style */}
      <div style={cardStyle}>
        <span style={labelStyle}>How do you like to work?</span>
        <div style={{ display: 'flex', flexDirection: 'column', gap: '0.5rem' }}>
          {[
            ['short_blocks', '⚡ Short focused blocks (25–45 min) with breaks'],
            ['long_sessions', '🧘 Long deep-work sessions (90+ min)'],
            ['mixed', '🔀 Mix depending on the task'],
          ].map(([val, label]) => (
            <button key={val}
              style={{ ...chip(answers.workStyle === val), textAlign: 'left', borderRadius: '10px' }}
              onClick={() => setAnswers(a => ({ ...a, workStyle: val }))}>
              {label}
            </button>
          ))}
        </div>
      </div>

      {/* Planning horizon */}
      <div style={cardStyle}>
        <span style={labelStyle}>How far ahead do you plan?</span>
        <div style={{ display: 'flex', flexDirection: 'column', gap: '0.5rem' }}>
          {[
            ['same_day', '🔥 Same day — I live in the moment'],
            ['1_2_days', '📆 1–2 days ahead'],
            ['2_3_days', '📅 2–3 days ahead'],
            ['week_ahead', '🗓 Full week at a time'],
          ].map(([val, label]) => (
            <button key={val}
              style={{ ...chip(answers.planningHorizon === val), textAlign: 'left', borderRadius: '10px' }}
              onClick={() => setAnswers(a => ({ ...a, planningHorizon: val }))}>
              {label}
            </button>
          ))}
        </div>
      </div>

      {/* Chunk size */}
      <div style={cardStyle}>
        <span style={labelStyle}>How long are your work blocks?</span>
        <div style={{ display: 'flex', flexDirection: 'column', gap: '0.5rem' }}>
          {[
            ['15_30', '⚡ 15–30 minute chunks'],
            ['30_60', '⏱ 30–60 minute chunks'],
            ['60_90', '⏰ 60–90 minute chunks'],
            ['90_plus', '🏔 90+ minutes — I go deep'],
          ].map(([val, label]) => (
            <button key={val}
              style={{ ...chip(answers.chunkSize === val), textAlign: 'left', borderRadius: '10px' }}
              onClick={() => setAnswers(a => ({ ...a, chunkSize: val }))}>
              {label}
            </button>
          ))}
        </div>
      </div>

      {/* Save */}
      <div style={{ display: 'flex', alignItems: 'center', gap: '1rem', marginBottom: '2rem' }}>
        <button
          onClick={handleSave}
          disabled={!isValid || saving}
          style={{
            padding: '0.65rem 2rem',
            borderRadius: '8px',
            border: 'none',
            background: isValid && !saving ? '#4285f4' : '#ccc',
            color: '#fff',
            fontWeight: 600,
            fontSize: '0.95rem',
            cursor: isValid && !saving ? 'pointer' : 'not-allowed',
          }}
        >
          {saving ? 'Saving…' : 'Save Preferences'}
        </button>
        {status === 'success' && (
          <span style={{ color: '#34a853', fontSize: '0.88rem', fontWeight: 500 }}>
            ✓ Preferences saved! 
          </span>
        )}
        {status === 'error' && (
          <span style={{ color: '#d93025', fontSize: '0.88rem', fontWeight: 500 }}>
            Failed to save — please try again
          </span>
        )}
      </div>
    </div>
  );
}
