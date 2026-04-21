import { useState, useRef, useEffect, useCallback } from 'react';

export interface Message {
  id: string;
  role: 'user' | 'assistant' | 'system';
  text: string;
  sessionId?: string;
  isReflection?: boolean;
}

interface UserSuggestion {
  email: string;
  displayName: string;
}

interface Props {
  headerLabel: string;
  placeholder: string;
  messages: Message[];
  onSend: (text: string) => void;
  contextLabel?: string;
  mentionSearchEndpoint?: string; // e.g. "http://localhost:8001/users/search"
  currentUserEmail?: string;      // excluded from mention results
  isLoading?: boolean;
  onStop?: () => void;
  onReset?: () => void;
  onClose?: () => void;
}

export default function ChatBar({ headerLabel, placeholder, messages, onSend, contextLabel, mentionSearchEndpoint, currentUserEmail, isLoading, onStop, onReset, onClose }: Props) {
  const [draft, setDraft] = useState('');
  const [mentionQuery, setMentionQuery] = useState<string | null>(null);
  const [mentionResults, setMentionResults] = useState<UserSuggestion[]>([]);
  const [mentionIndex, setMentionIndex] = useState(0);
  const bottomRef = useRef<HTMLDivElement>(null);
  const textareaRef = useRef<HTMLTextAreaElement>(null);
  const debounceRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(() => {
    bottomRef.current?.scrollIntoView({ behavior: 'smooth' });
  }, [messages]);

  useEffect(() => {
    const el = textareaRef.current;
    if (!el) return;
    el.style.height = 'auto';
    el.style.height = `${el.scrollHeight}px`;
  }, [draft]);

  // Search for users whenever the mention query changes
  const searchMentions = useCallback(async (q: string) => {
    if (!mentionSearchEndpoint) {
      setMentionResults([]);
      return;
    }
    try {
      const params = new URLSearchParams({ q });
      if (currentUserEmail) params.set('exclude', currentUserEmail);
      const res = await fetch(`${mentionSearchEndpoint}?${params}`);
      const data: UserSuggestion[] = await res.json();
      setMentionResults(data);
      setMentionIndex(0);
    } catch {
      setMentionResults([]);
    }
  }, [mentionSearchEndpoint, currentUserEmail]);

  function handleChange(e: React.ChangeEvent<HTMLTextAreaElement>) {
    const val = e.target.value;
    setDraft(val);

    if (!mentionSearchEndpoint) return;

    // Detect @query at the cursor (or end of string)
    const cursor = e.target.selectionStart ?? val.length;
    const textBeforeCursor = val.slice(0, cursor);
    const match = textBeforeCursor.match(/@([^\s@]*)$/);

    if (match) {
      const q = match[1];
      setMentionQuery(q);
      if (debounceRef.current) clearTimeout(debounceRef.current);
      // Fire immediately on bare "@", debounce when typing a query
      const delay = q.length === 0 ? 0 : 200;
      debounceRef.current = setTimeout(() => searchMentions(q), delay);
    } else {
      setMentionQuery(null);
      setMentionResults([]);
    }
  }

  function insertMention(user: UserSuggestion) {
    const cursor = textareaRef.current?.selectionStart ?? draft.length;
    const textBeforeCursor = draft.slice(0, cursor);
    const textAfterCursor = draft.slice(cursor);
    // Replace @<partial> with @<email>
    const replaced = textBeforeCursor.replace(/@([^\s@]*)$/, `@${user.email}`);
    setDraft(replaced + textAfterCursor);
    setMentionQuery(null);
    setMentionResults([]);
    // Restore focus and move cursor to after inserted email
    setTimeout(() => {
      const el = textareaRef.current;
      if (!el) return;
      el.focus();
      const pos = replaced.length;
      el.setSelectionRange(pos, pos);
    }, 0);
  }

  function handleKeyDown(e: React.KeyboardEvent<HTMLTextAreaElement>) {
    if (mentionResults.length > 0) {
      if (e.key === 'ArrowDown') {
        e.preventDefault();
        setMentionIndex(i => Math.min(i + 1, mentionResults.length - 1));
        return;
      }
      if (e.key === 'ArrowUp') {
        e.preventDefault();
        setMentionIndex(i => Math.max(i - 1, 0));
        return;
      }
      if (e.key === 'Tab' || e.key === 'Enter') {
        e.preventDefault();
        insertMention(mentionResults[mentionIndex]);
        return;
      }
      if (e.key === 'Escape') {
        setMentionQuery(null);
        setMentionResults([]);
        return;
      }
    }

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
    setMentionQuery(null);
    setMentionResults([]);
    textareaRef.current?.focus();
  }

  const showDropdown = mentionQuery !== null && mentionResults.length > 0;

  return (
    <div className="chat-sidebar">
      <div className="chat-header">
        <span>
          {headerLabel}
          {contextLabel && (
            <span style={{ fontWeight: 400, color: '#1a73e8', marginLeft: 8 }}>— {contextLabel}</span>
          )}
        </span>
        <div className="chat-header-actions">
          {isLoading && onStop && (
            <button className="chat-ctrl-btn" onClick={onStop} title="Stop response">
              &#9632;
            </button>
          )}
          {onReset && (
            <button className="chat-ctrl-btn" onClick={onReset} title="Restart chat">
              &#8635;
            </button>
          )}
          {onClose && (
            <button className="chat-ctrl-btn" onClick={onClose} title="Close chat">
              &#x2715;
            </button>
          )}
        </div>
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
        {showDropdown && (
          <div className="mention-dropdown">
            {mentionResults.map((u, i) => (
              <div
                key={u.email}
                className={`mention-option${i === mentionIndex ? ' mention-option--active' : ''}`}
                onMouseDown={e => { e.preventDefault(); insertMention(u); }}
              >
                <span className="mention-option-name">{u.displayName || u.email}</span>
                <span className="mention-option-email">{u.email}</span>
              </div>
            ))}
          </div>
        )}
        <div className="chat-input-row">
          <textarea
            ref={textareaRef}
            rows={1}
            value={draft}
            onChange={handleChange}
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
