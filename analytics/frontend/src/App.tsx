import React, { useState } from 'react';
import CalendarTab from './components/CalendarTab';
import DiaryTab from './components/DiaryTab';
import './App.css';

type Tab = 'calendar' | 'diary';

function App() {
  const [activeTab, setActiveTab] = useState<Tab>('calendar');

  return (
    <div className="app">
      <header className="app-header">
        <div className="header-left">
          <h1 className="app-title">CalCoach 🐻 📅</h1>
        </div>
        <nav className="tab-nav">
          <button
            className={`tab-btn ${activeTab === 'calendar' ? 'active' : ''}`}
            onClick={() => setActiveTab('calendar')}
          >
            Calendar
          </button>
          <button
            className={`tab-btn ${activeTab === 'diary' ? 'active' : ''}`}
            onClick={() => setActiveTab('diary')}
          >
            Diary
          </button>
        </nav>
      </header>
      <main className="app-main">
        {activeTab === 'calendar' ? <CalendarTab /> : <DiaryTab />}
      </main>
    </div>
  );
}

export default App;
