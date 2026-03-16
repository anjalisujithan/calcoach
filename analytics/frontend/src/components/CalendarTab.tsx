import { useState } from 'react';
import WeekCalendar from './WeekCalendar';
import ChatBar, { Message } from './ChatBar';

let msgId = 0;
const mkId = () => String(++msgId);

const INITIAL_MESSAGES: Message[] = [
  {
    id: mkId(),
    role: 'assistant',
    text: "Hi! I'm CalCoach. Share your tasks and goals and I'll help generate an optimized schedule for your week.",
  },
];

export default function CalendarTab() {
  const [messages, setMessages] = useState<Message[]>(INITIAL_MESSAGES);

  function handleSend(text: string) {
    const userMsg: Message = { id: mkId(), role: 'user', text };
    // Placeholder response — will connect to LLM/backend
    const botMsg: Message = {
      id: mkId(),
      role: 'assistant',
      text: "Got it! (Calendar scheduling backend coming soon — your feedback has been noted.)",
    };
    setMessages(m => [...m, userMsg, botMsg]);
  }

  return (
    <div className="tab-layout">
      <WeekCalendar />
      <ChatBar
        headerLabel="Feedback for generated schedule"
        placeholder="Schedule Anything"
        messages={messages}
        onSend={handleSend}
      />
    </div>
  );
}
