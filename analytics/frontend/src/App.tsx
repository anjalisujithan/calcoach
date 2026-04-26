import { useState, useEffect } from 'react';
import CalendarTab from './components/CalendarTab';
import AnalyticsTab from './components/AnalyticsTab';
import PreferencesTab from './components/PreferencesTab';
import AuthPage from './components/AuthPage';
import OnboardingSurvey, { SurveyAnswers } from './components/OnboardingSurvey';
import { ReflectionEntry } from './components/ReflectionPanel';
import { Session } from './components/WeekCalendar';
import { AuthProvider, useAuth } from './AuthContext';
import './App.css';

type Tab = 'calendar' | 'analytics' | 'preferences';

const mkId = () => crypto.randomUUID();

const API = import.meta.env.VITE_ANALYTICS_API ?? 'http://localhost:8001';

function AppShell() {
  const { user, loading, signOut } = useAuth();
  const [activeTab, setActiveTab] = useState<Tab>('calendar');
  const [reflections, setReflections] = useState<ReflectionEntry[]>([]);
  const [sessions, setSessions] = useState<Session[]>([]);
  const [showSurvey, setShowSurvey] = useState<boolean>(
    () => !localStorage.getItem('calcoach_survey_done')
  );

  useEffect(() => {
    if (!user) return;
    fetch(`${API}/reflections?user_id=${encodeURIComponent(user.uid ?? '')}`)
      .then(r => r.json())
      .then((data: ReflectionEntry[]) => {
        setReflections(data);
      })
      .catch(() => {});
  }, [user?.email]);

  function handleSurveyComplete(_answers: SurveyAnswers) {
    setShowSurvey(false);
  }

  if (loading) {
    return <div className="auth-loading">Loading…</div>;
  }

  if (!user) {
    return <AuthPage />;
  }

  async function handleSaveReflection(entry: Omit<ReflectionEntry, 'id' | 'savedAt'>) {
    const newEntry: ReflectionEntry = {
      ...entry,
      userId: user!.uid,
      id: mkId(),
      savedAt: new Date().toISOString(),
    };
    setReflections(prev => [...prev, newEntry]);
    try {
      await fetch(`${API}/reflections`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(newEntry),
      });
    } catch {
      // backend optional
    }
  }

  return (
    <div className="app">
      {showSurvey && <OnboardingSurvey onComplete={handleSurveyComplete} />}
      <header className="app-header">
        <div className="header-left">
          <h1 className="app-title">CalCoach 🐻 📅</h1>
        </div>
        <nav className="tab-nav">
          {(['calendar', 'analytics', 'preferences'] as Tab[]).map(tab => (
            <button
              key={tab}
              className={`tab-btn ${activeTab === tab ? 'active' : ''}`}
              onClick={() => setActiveTab(tab)}
            >
              {tab.charAt(0).toUpperCase() + tab.slice(1)}
            </button>
          ))}
        </nav>
        <div className="header-user">
          <span className="header-email">{user.email}</span>
          <button className="btn-signout" onClick={signOut}>Sign out</button>
        </div>
      </header>
      <main className="app-main">
        <div style={{ display: activeTab === 'calendar' ? undefined : 'none', height: '100%' }}>
          <CalendarTab reflections={reflections} onSaveReflection={handleSaveReflection} onSessionsChange={setSessions} userEmail={user.email ?? ''} />
        </div>
        <div style={{ display: activeTab === 'analytics' ? undefined : 'none', height: '100%' }}>
          <AnalyticsTab reflections={reflections} sessions={sessions} userEmail={user.email ?? ''} />
        </div>
        <div style={{ display: activeTab === 'preferences' ? undefined : 'none', height: '100%' }}>
          <PreferencesTab userEmail={user.email ?? ''} />
        </div>
      </main>
    </div>
  );
}

export default function App() {
  return (
    <AuthProvider>
      <AppShell />
    </AuthProvider>
  );
}
