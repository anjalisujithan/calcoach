import { useState } from 'react';
import CalendarTab from './components/CalendarTab';
import DiaryTab from './components/DiaryTab';
import AnalyticsTab from './components/AnalyticsTab';
import { ReflectionEntry } from './components/ReflectionPanel';
import './App.css';

type Tab = 'calendar' | 'diary' | 'analytics';

let idCounter = 0;
const mkId = () => String(++idCounter);

const API = 'http://localhost:8000';

export default function App() {
  const [activeTab, setActiveTab] = useState<Tab>('calendar');
  const [reflections, setReflections] = useState<ReflectionEntry[]>([]);

  async function handleSaveReflection(entry: Omit<ReflectionEntry, 'id' | 'savedAt'>) {
    const newEntry: ReflectionEntry = {
      ...entry,
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
      <header className="app-header">
        <div className="header-left">
          <h1 className="app-title">CalCoach 🐻 📅</h1>
        </div>
        <nav className="tab-nav">
          {(['calendar', 'diary', 'analytics'] as Tab[]).map(tab => (
            <button
              key={tab}
              className={`tab-btn ${activeTab === tab ? 'active' : ''}`}
              onClick={() => setActiveTab(tab)}
            >
              {tab.charAt(0).toUpperCase() + tab.slice(1)}
            </button>
          ))}
        </nav>
      </header>
      <main className="app-main">
        {activeTab === 'calendar' && <CalendarTab />}
        {activeTab === 'diary' && (
          <DiaryTab reflections={reflections} onSaveReflection={handleSaveReflection} />
        )}
        {activeTab === 'analytics' && <AnalyticsTab reflections={reflections} />}
      </main>
    </div>
  );
}
