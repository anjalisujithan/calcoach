import { useState } from 'react';
import WeekCalendar, { Session } from './WeekCalendar';
import ReflectionPanel, { ReflectionEntry } from './ReflectionPanel';

let idCounter = 0;
const mkId = () => String(++idCounter);

interface Props {
  reflections: ReflectionEntry[];
  onSaveReflection: (entry: Omit<ReflectionEntry, 'id' | 'savedAt'>) => void;
}

export default function DiaryTab({ reflections, onSaveReflection }: Props) {
  const [sessions, setSessions] = useState<Session[]>([]);
  const [selectedId, setSelectedId] = useState<string | null>(null);

  const selectedSession = sessions.find(s => s.id === selectedId) ?? null;

  function handleAddSession(s: Omit<Session, 'id'>) {
    const id = mkId();
    setSessions(prev => [...prev, { ...s, id }]);
    setSelectedId(id);
  }

  return (
    <div className="tab-layout">
      <WeekCalendar
        sessions={sessions}
        selectedSession={selectedId}
        onSelectSession={id => setSelectedId(id)}
        onAddSession={handleAddSession}
      />
      <ReflectionPanel
        selectedSession={selectedSession}
        reflections={reflections}
        onSave={onSaveReflection}
      />
    </div>
  );
}
