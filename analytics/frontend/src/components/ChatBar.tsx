import { useState, useRef, useEffect } from 'react';

export interface Message {
  id: string;
  role: 'user' | 'assistant' | 'system';
  text: string;
  sessionId?: string;
  isReflection?: boolean;
}

interface Props {
  headerLabel: string;
  placeholder: string;
  messages: Message[];
  onSend: (text: string) => void;
  contextLabel?: string; // e.g. selected session title
}

export default function ChatBar({ headerLabel, placeholder, messages, onSend, contextLabel }: Props) {
  const [draft, setDraft] = useState('');
  const bottomRef = useRef<HTMLDivElement>(null);
  const textareaRef = useRef<HTMLTextAreaElement>(null);

  useEffect(() => {
    bottomRef.current?.scrollIntoView({ behavior: 'smooth' });
  }, [messages]);

  function handleKeyDown(e: React.KeyboardEvent<HTMLTextAreaElement>) {
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault();
      submit();
    }
  }

  function submit() {
    const text = draft.trim();
    if (!text) return;
    onSend(text);
    setDraft('');
    textareaRef.current?.focus();
  }

  return (
    <div className="chat-sidebar">
      <div className="chat-header">
        {headerLabel}
        {contextLabel && (
          <span style={{ fontWeight: 400, color: '#1a73e8', marginLeft: 8 }}>— {contextLabel}</span>
        )}
      </div>

      <div className="chat-messages">
        {messages.length === 0 && (
          <div className="chat-bubble system-hint">
            {placeholder}
          </div>
        )}
        {messages.map(m => (
          <div key={m.id} style={{ display: 'flex', flexDirection: 'column', alignItems: m.role === 'user' ? 'flex-end' : 'flex-start' }}>
            <div className={`chat-bubble ${m.role === 'user' ? 'user' : 'assistant'}`}>
              {m.text}
            </div>
            {m.isReflection && (
              <span className="reflection-tag">saved to memory</span>
            )}
          </div>
        ))}
        <div ref={bottomRef} />
      </div>

      <div className="chat-input-area">
        <div className="chat-input-row">
          <textarea
            ref={textareaRef}
            rows={1}
            value={draft}
            onChange={e => setDraft(e.target.value)}
            onKeyDown={handleKeyDown}
            placeholder={placeholder}
          />
          <button
            className="chat-send-btn"
            onClick={submit}
            disabled={!draft.trim()}
            title="Send"
          >
            ↑
          </button>
        </div>
      </div>
    </div>
  );
}
