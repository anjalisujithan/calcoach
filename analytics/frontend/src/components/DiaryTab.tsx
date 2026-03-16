import { useState } from 'react';
import WeekCalendar, { Session } from './WeekCalendar';
import ChatBar, { Message } from './ChatBar';

let idCounter = 0;
const mkId = () => String(++idCounter);

// In-memory reflections store — in production this would be persisted to backend
export interface Reflection {
  sessionId: string;
  sessionTitle: string;
  text: string;
  timestamp: string;
}

const memoryStore: Reflection[] = [];

export default function DiaryTab() {
  const [sessions, setSessions] = useState<Session[]>([]);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [messagesBySession, setMessagesBySession] = useState<Record<string, Message[]>>({});

  const selectedSession = sessions.find(s => s.id === selectedId) ?? null;
  const messages = selectedId ? (messagesBySession[selectedId] ?? []) : [];

  function handleAddSession(s: Omit<Session, 'id'>) {
    const id = mkId();
    setSessions(prev => [...prev, { ...s, id }]);
    setSelectedId(id);
  }

  function handleSend(text: string) {
    if (!selectedId) return;

    const userMsg: Message = {
      id: mkId(),
      role: 'user',
      text,
      sessionId: selectedId,
      isReflection: true,
    };

    // Save to in-memory store (will be replaced by API call)
    memoryStore.push({
      sessionId: selectedId,
      sessionTitle: selectedSession?.title ?? '',
      text,
      timestamp: new Date().toISOString(),
    });

    const botMsg: Message = {
      id: mkId(),
      role: 'assistant',
      text: `Reflection saved for "${selectedSession?.title}". Keep going — every session logged builds a clearer picture of your learning patterns!`,
      sessionId: selectedId,
    };

    setMessagesBySession(prev => ({
      ...prev,
      [selectedId]: [...(prev[selectedId] ?? []), userMsg, botMsg],
    }));
  }

  const contextLabel = selectedSession?.title ?? undefined;

  const placeholder = selectedSession
    ? `Reflect on "${selectedSession.title}"…`
    : 'Select a session to reflect on it';

  return (
    <div className="tab-layout">
      <WeekCalendar
        sessions={sessions}
        selectedSession={selectedId}
        onSelectSession={id => setSelectedId(id)}
        onAddSession={handleAddSession}
        showAddButton
      />
      <ChatBar
        headerLabel="Reflect on work session"
        placeholder={placeholder}
        messages={messages}
        onSend={handleSend}
        contextLabel={contextLabel}
      />
    </div>
  );
}
