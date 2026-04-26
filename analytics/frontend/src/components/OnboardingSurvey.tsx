import { useState } from 'react';
import { useAuth } from '../AuthContext';

const ANALYTICS_API = process.env.REACT_APP_ANALYTICS_API ?? 'http://localhost:8001';

export interface SurveyAnswers {
  userType: string;          // 'college_student' | 'grad_student' | 'working_professional' | 'other'
  helpWith: string[];        // ['assignments', 'studying', 'extracurriculars', 'work_projects', 'personal']
  workDays: string[];        // ['weekdays', 'weekends', 'both']
  workStartHour: number;     // 6–22
  workEndHour: number;       // 6–23
  workStyle: string;         // 'short_blocks' | 'long_sessions' | 'mixed'
  planningHorizon: string;   // 'same_day' | '1_2_days' | '2_3_days' | 'week_ahead'
  chunkSize: string;         // '15_30' | '30_60' | '60_90' | '90_plus'
}

const STEPS = [
  'Who are you?',
  'What do you want help with?',
  'When do you like to work?',
  'How do you like to work?',
  'How far ahead do you plan?',
  'How long are your work blocks?',
];

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

// Fully-filled fallback used when user dismisses the survey
export const DISMISSED_DEFAULTS: SurveyAnswers = {
  userType: 'college_student',
  helpWith: ['assignments', 'studying'],
  workDays: ['weekdays'],
  workStartHour: 9,
  workEndHour: 21,
  workStyle: 'mixed',
  planningHorizon: '1_2_days',
  chunkSize: '30_60',
};

interface Props {
  onComplete: (answers: SurveyAnswers) => void;
}

export default function OnboardingSurvey({ onComplete }: Props) {
  const { user } = useAuth();
  const [step, setStep] = useState(0);
  const [answers, setAnswers] = useState<SurveyAnswers>(DEFAULT_ANSWERS);
  const [submitting, setSubmitting] = useState(false);

  async function handleDismiss() {
    const userKey = user?.email ?? 'anon';
    localStorage.setItem(`calcoach_survey_done_${userKey}`, 'true');
    localStorage.setItem(`calcoach_survey_answers_${userKey}`, JSON.stringify(DISMISSED_DEFAULTS));
    try {
      await fetch(`${ANALYTICS_API}/onboarding`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ ...DISMISSED_DEFAULTS, email: user?.email ?? '' }),
      });
    } catch { /* non-critical */ }
    onComplete(DISMISSED_DEFAULTS);
  }

  function toggleMulti(field: 'helpWith' | 'workDays', value: string) {
    setAnswers(prev => {
      const arr = prev[field];
      return { ...prev, [field]: arr.includes(value) ? arr.filter(x => x !== value) : [...arr, value] };
    });
  }

  function canProceed(): boolean {
    switch (step) {
      case 0: return !!answers.userType;
      case 1: return answers.helpWith.length > 0;
      case 2: return answers.workDays.length > 0 && answers.workStartHour < answers.workEndHour;
      case 3: return !!answers.workStyle;
      case 4: return !!answers.planningHorizon;
      case 5: return !!answers.chunkSize;
      default: return false;
    }
  }

  async function handleFinish() {
    setSubmitting(true);
    try {
      await fetch(`${ANALYTICS_API}/onboarding`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ ...answers, email: user?.email ?? '' }),
      });
    } catch { /* non-critical */ }
    const userKey = user?.email ?? 'anon';
    localStorage.setItem(`calcoach_survey_done_${userKey}`, 'true');
    localStorage.setItem(`calcoach_survey_answers_${userKey}`, JSON.stringify(answers));
    onComplete(answers);
    setSubmitting(false);
  }

  const chipStyle = (selected: boolean): React.CSSProperties => ({
    padding: '0.5rem 1rem',
    borderRadius: '999px',
    border: `2px solid ${selected ? '#4285f4' : '#ccc'}`,
    background: selected ? '#e8f0fe' : '#fff',
    color: selected ? '#1a73e8' : '#555',
    cursor: 'pointer',
    fontWeight: selected ? 600 : 400,
    fontSize: '0.9rem',
    transition: 'all 0.15s',
  });

  return (
    <div style={{
      position: 'fixed', inset: 0, background: 'rgba(0,0,0,0.55)',
      display: 'flex', alignItems: 'center', justifyContent: 'center', zIndex: 1000,
    }}>
      <div style={{
        background: '#fff', borderRadius: '16px', padding: '2.5rem 2rem',
        width: '480px', maxWidth: '95vw', boxShadow: '0 8px 40px rgba(0,0,0,0.18)',
        position: 'relative',
      }}>
        <button
          onClick={handleDismiss}
          title="Skip and use defaults"
          style={{
            position: 'absolute', top: '1rem', right: '1rem',
            background: 'none', border: 'none', cursor: 'pointer',
            fontSize: '1.2rem', color: '#999', lineHeight: 1, padding: '0.2rem 0.4rem',
          }}
        >
          ✕
        </button>
        {/* Progress */}
        <div style={{ display: 'flex', gap: '6px', marginBottom: '1.5rem' }}>
          {STEPS.map((_, i) => (
            <div key={i} style={{
              flex: 1, height: '4px', borderRadius: '2px',
              background: i <= step ? '#4285f4' : '#e0e0e0',
              transition: 'background 0.3s',
            }} />
          ))}
        </div>

        <p style={{ fontSize: '0.8rem', color: '#888', margin: '0 0 0.3rem' }}>
          Step {step + 1} of {STEPS.length}
        </p>
        <h2 style={{ margin: '0 0 1.5rem', fontSize: '1.3rem', color: '#222' }}>
          {STEPS[step]}
        </h2>

        {/* Step 0: User type */}
        {step === 0 && (
          <div style={{ display: 'flex', flexWrap: 'wrap', gap: '0.6rem' }}>
            {[
              ['college_student', '🎓 College student'],
              ['grad_student', '🔬 Grad student'],
              ['working_professional', '💼 Working professional'],
              ['other', '👤 Other'],
            ].map(([val, label]) => (
              <button key={val} style={chipStyle(answers.userType === val)}
                onClick={() => setAnswers(a => ({ ...a, userType: val }))}>
                {label}
              </button>
            ))}
          </div>
        )}

        {/* Step 1: Help with */}
        {step === 1 && (
          <div style={{ display: 'flex', flexWrap: 'wrap', gap: '0.6rem' }}>
            {[
              ['assignments', '📚 Assignments'],
              ['studying', '📖 Studying'],
              ['extracurriculars', '⚽ Extracurriculars'],
              ['work_projects', '💻 Work projects'],
              ['personal', '🏃 Personal goals'],
            ].map(([val, label]) => (
              <button key={val} style={chipStyle(answers.helpWith.includes(val))}
                onClick={() => toggleMulti('helpWith', val)}>
                {label}
              </button>
            ))}
          </div>
        )}

        {/* Step 2: Work days + hours */}
        {step === 2 && (
          <div style={{ display: 'flex', flexDirection: 'column', gap: '1rem' }}>
            <div>
              <p style={{ margin: '0 0 0.5rem', fontWeight: 500 }}>Preferred days</p>
              <div style={{ display: 'flex', gap: '0.6rem', flexWrap: 'wrap' }}>
                {[['weekdays', '📅 Weekdays'], ['weekends', '🏖 Weekends']].map(([val, label]) => (
                  <button key={val} style={chipStyle(answers.workDays.includes(val))}
                    onClick={() => toggleMulti('workDays', val)}>
                    {label}
                  </button>
                ))}
              </div>
            </div>
            <div style={{ display: 'flex', gap: '1rem', alignItems: 'center' }}>
              <div style={{ flex: 1 }}>
                <label style={{ fontSize: '0.85rem', color: '#555', display: 'block', marginBottom: '4px' }}>Start time</label>
                <select value={answers.workStartHour}
                  onChange={e => setAnswers(a => ({ ...a, workStartHour: Number(e.target.value) }))}
                  style={{ width: '100%', padding: '0.4rem', borderRadius: '6px', border: '1px solid #ccc' }}>
                  {Array.from({ length: 17 }, (_, i) => i + 6).map(h => (
                    <option key={h} value={h}>{h % 12 || 12} {h < 12 ? 'AM' : 'PM'}</option>
                  ))}
                </select>
              </div>
              <div style={{ flex: 1 }}>
                <label style={{ fontSize: '0.85rem', color: '#555', display: 'block', marginBottom: '4px' }}>End time</label>
                <select value={answers.workEndHour}
                  onChange={e => setAnswers(a => ({ ...a, workEndHour: Number(e.target.value) }))}
                  style={{ width: '100%', padding: '0.4rem', borderRadius: '6px', border: '1px solid #ccc' }}>
                  {Array.from({ length: 17 }, (_, i) => i + 7).map(h => (
                    <option key={h} value={h}>{h % 12 || 12} {h < 12 ? 'AM' : 'PM'}</option>
                  ))}
                </select>
              </div>
            </div>
          </div>
        )}

        {/* Step 3: Work style */}
        {step === 3 && (
          <div style={{ display: 'flex', flexDirection: 'column', gap: '0.7rem' }}>
            {[
              ['short_blocks', '⚡ Short focused blocks (25–45 min) with breaks'],
              ['long_sessions', '🧘 Long deep-work sessions (90+ min)'],
              ['mixed', '🔀 Mix depending on the task'],
            ].map(([val, label]) => (
              <button key={val} style={{ ...chipStyle(answers.workStyle === val), textAlign: 'left', borderRadius: '10px' }}
                onClick={() => setAnswers(a => ({ ...a, workStyle: val }))}>
                {label}
              </button>
            ))}
          </div>
        )}

        {/* Step 4: Planning horizon */}
        {step === 4 && (
          <div style={{ display: 'flex', flexDirection: 'column', gap: '0.7rem' }}>
            {[
              ['same_day', '🔥 Same day — I live in the moment'],
              ['1_2_days', '📆 1–2 days ahead'],
              ['2_3_days', '📅 2–3 days ahead'],
              ['week_ahead', '🗓 Full week at a time'],
            ].map(([val, label]) => (
              <button key={val} style={{ ...chipStyle(answers.planningHorizon === val), textAlign: 'left', borderRadius: '10px' }}
                onClick={() => setAnswers(a => ({ ...a, planningHorizon: val }))}>
                {label}
              </button>
            ))}
          </div>
        )}

        {/* Step 5: Chunk size */}
        {step === 5 && (
          <div style={{ display: 'flex', flexDirection: 'column', gap: '0.7rem' }}>
            {[
              ['15_30', '⚡ 15–30 minute chunks'],
              ['30_60', '⏱ 30–60 minute chunks'],
              ['60_90', '⏰ 60–90 minute chunks'],
              ['90_plus', '🏔 90+ minutes — I go deep'],
            ].map(([val, label]) => (
              <button key={val} style={{ ...chipStyle(answers.chunkSize === val), textAlign: 'left', borderRadius: '10px' }}
                onClick={() => setAnswers(a => ({ ...a, chunkSize: val }))}>
                {label}
              </button>
            ))}
          </div>
        )}

        {/* Navigation */}
        <div style={{ display: 'flex', justifyContent: 'space-between', marginTop: '2rem' }}>
          {step > 0 ? (
            <button onClick={() => setStep(s => s - 1)}
              style={{ padding: '0.6rem 1.4rem', borderRadius: '8px', border: '1px solid #ccc', background: '#fff', cursor: 'pointer', color: '#555' }}>
              Back
            </button>
          ) : <div />}
          {step < STEPS.length - 1 ? (
            <button onClick={() => setStep(s => s + 1)} disabled={!canProceed()}
              style={{ padding: '0.6rem 1.6rem', borderRadius: '8px', border: 'none', background: canProceed() ? '#4285f4' : '#ccc', color: '#fff', cursor: canProceed() ? 'pointer' : 'not-allowed', fontWeight: 600 }}>
              Next →
            </button>
          ) : (
            <button onClick={handleFinish} disabled={!canProceed() || submitting}
              style={{ padding: '0.6rem 1.6rem', borderRadius: '8px', border: 'none', background: canProceed() ? '#34a853' : '#ccc', color: '#fff', cursor: canProceed() ? 'pointer' : 'not-allowed', fontWeight: 600 }}>
              {submitting ? 'Saving…' : '🎉 Get Started'}
            </button>
          )}
        </div>
      </div>
    </div>
  );
}
