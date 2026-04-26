import { useState, useRef, useEffect, useCallback, type ReactNode } from 'react';

const LOADING_PHRASES = [
  'Thinking',
  'Cooking',
  'Scheduling',
  'Processing',
  'Analyzing',
  'Planning',
  'Working on it',
  'Almost there',
];

function LoadingBubble() {
  const [phraseIdx, setPhraseIdx] = useState(0);
  const [dotCount, setDotCount] = useState(1);

  useEffect(() => {
    const dotTimer = setInterval(() => {
      setDotCount(d => (d % 3) + 1);
    }, 400);
    return () => clearInterval(dotTimer);
  }, []);

  useEffect(() => {
    const phraseTimer = setInterval(() => {
      setPhraseIdx(i => (i + 1) % LOADING_PHRASES.length);
    }, 1800);
    return () => clearInterval(phraseTimer);
  }, []);

  return (
    <div className="chat-bubble assistant loading-bubble">
      <span className="loading-phrase">{LOADING_PHRASES[phraseIdx]}</span>
      <span className="loading-dots">{'•'.repeat(dotCount)}<span className="loading-dots-ghost">{'•'.repeat(3 - dotCount)}</span></span>
    </div>
  );
}

// ── Shared helpers (module-level so MentionInput can use them too) ─────────────

function getTextContent(el: HTMLElement): string {
  let text = '';
  el.childNodes.forEach(node => {
    if (node.nodeType === Node.TEXT_NODE) {
      text += node.textContent ?? '';
    } else if (node.nodeName === 'BR') {
      text += '\n';
    } else {
      const child = node as HTMLElement;
      if (child.dataset?.mention) {
        text += child.dataset.mention;
      } else {
        text += getTextContent(child);
      }
    }
  });
  return text;
}

function getTextBeforeCursor(el: HTMLElement): string {
  const sel = window.getSelection();
  if (!sel || sel.rangeCount === 0) return '';
  const range = sel.getRangeAt(0);
  const preRange = range.cloneRange();
  preRange.selectNodeContents(el);
  preRange.setEnd(range.endContainer, range.endOffset);
  return preRange.toString();
}

const EMAIL_MENTION_RE = /@([\w.+\-]+@[\w.\-]+\.\w{2,})/g;

// ── Reusable mention input (used inside the task planner for attendees) ────────

interface UserSuggestion {
  email: string;
  displayName: string;
  hasCalendar?: boolean;
}

interface MentionInputProps {
  placeholder: string;
  mentionSearchEndpoint?: string;
  currentUserEmail?: string;
  onChange: (text: string, emails: string[]) => void;
  disabled?: boolean;
  inputStyle?: React.CSSProperties;
}

function MentionInput({ placeholder, mentionSearchEndpoint, currentUserEmail, onChange, disabled, inputStyle }: MentionInputProps) {
  const editRef = useRef<HTMLDivElement>(null);
  const debounceRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const [query, setQuery] = useState<string | null>(null);
  const [results, setResults] = useState<UserSuggestion[]>([]);
  const [idx, setIdx] = useState(0);

  const search = useCallback(async (q: string) => {
    if (!mentionSearchEndpoint) { setResults([]); return; }
    try {
      const params = new URLSearchParams({ q });
      if (currentUserEmail) params.set('exclude', currentUserEmail);
      const res = await fetch(`${mentionSearchEndpoint}?${params}`);
      const data: UserSuggestion[] = await res.json();
      setResults(data); setIdx(0);
    } catch { setResults([]); }
  }, [mentionSearchEndpoint, currentUserEmail]);

  function notifyChange(el: HTMLElement) {
    const text = getTextContent(el);
    const emails = Array.from(text.matchAll(EMAIL_MENTION_RE)).map(m => m[1]);
    onChange(text, emails);
  }

  function handleInput() {
    const el = editRef.current; if (!el) return;
    notifyChange(el);
    if (!mentionSearchEndpoint) return;
    const textBefore = getTextBeforeCursor(el);
    const match = textBefore.match(/@([^\s@]*)$/);
    if (match) {
      const q = match[1]; setQuery(q);
      if (debounceRef.current) clearTimeout(debounceRef.current);
      debounceRef.current = setTimeout(() => search(q), q.length === 0 ? 0 : 200);
    } else { setQuery(null); setResults([]); }
  }

  function insertMention(user: UserSuggestion) {
    if (!user.hasCalendar) return;
    const el = editRef.current; if (!el) return;
    el.focus();
    const sel = window.getSelection();
    if (!sel || sel.rangeCount === 0) return;
    const range = sel.getRangeAt(0);
    const textNode = range.endContainer;
    const offset = range.endOffset;
    if (textNode.nodeType === Node.TEXT_NODE) {
      const nodeText = textNode.textContent ?? '';
      const beforeText = nodeText.slice(0, offset);
      const atMatch = beforeText.match(/@([^\s@]*)$/);
      if (atMatch) {
        const atStart = offset - atMatch[0].length;
        const deleteRange = document.createRange();
        deleteRange.setStart(textNode, atStart);
        deleteRange.setEnd(textNode, offset);
        deleteRange.deleteContents();
        const span = document.createElement('span');
        span.className = 'mention-linked-email';
        span.dataset.mention = `@${user.email}`;
        span.contentEditable = 'false';
        span.textContent = `@${user.email}`;
        const insertRange = sel.getRangeAt(0);
        insertRange.insertNode(span);
        const space = document.createTextNode(' ');
        span.after(space);
        const newRange = document.createRange();
        newRange.setStartAfter(space);
        newRange.collapse(true);
        sel.removeAllRanges();
        sel.addRange(newRange);
      }
    }
    setQuery(null); setResults([]);
    if (editRef.current) notifyChange(editRef.current);
  }

  function handleKeyDown(e: React.KeyboardEvent<HTMLDivElement>) {
    if (results.length > 0) {
      if (e.key === 'ArrowDown') { e.preventDefault(); setIdx(i => Math.min(i + 1, results.length - 1)); return; }
      if (e.key === 'ArrowUp') { e.preventDefault(); setIdx(i => Math.max(i - 1, 0)); return; }
      if (e.key === 'Tab' || e.key === 'Enter') {
        e.preventDefault();
        const candidate = results[idx];
        if (candidate?.hasCalendar) insertMention(candidate);
        return;
      }
      if (e.key === 'Escape') { setQuery(null); setResults([]); return; }
    }
    if (e.key === 'Enter') e.preventDefault();
  }

  const showDropdown = query !== null && results.length > 0;

  return (
    <div style={{ position: 'relative' }}>
      {showDropdown && (
        <div className="mention-dropdown" style={{ bottom: '100%', top: 'auto', marginBottom: 4 }}>
          {results.map((u, i) => (
            <div
              key={u.email}
              className={`mention-option${i === idx && u.hasCalendar ? ' mention-option--active' : ''}${!u.hasCalendar ? ' mention-option--disabled' : ''}`}
              onMouseDown={e => { e.preventDefault(); insertMention(u); }}
              title={!u.hasCalendar ? 'This user has not connected Google Calendar' : undefined}
            >
              <span className="mention-option-name">{u.displayName || u.email}</span>
              <span className="mention-option-email">{u.email}</span>
              {!u.hasCalendar && <span className="mention-option-tag">No calendar</span>}
            </div>
          ))}
        </div>
      )}
      <div
        ref={editRef}
        contentEditable={!disabled}
        suppressContentEditableWarning
        className="chat-contenteditable"
        style={{ minHeight: '1.8rem', padding: '0.3rem 0.5rem', fontSize: '0.82rem', borderRadius: 5, border: '1px solid #dadce0', background: disabled ? '#f8f8f8' : '#fff', ...inputStyle }}
        onInput={handleInput}
        onKeyDown={handleKeyDown}
        data-placeholder={placeholder}
      />
    </div>
  );
}

// ── Main ChatBar ───────────────────────────────────────────────────────────────

export interface Message {
  id: string;
  role: 'user' | 'assistant' | 'system';
  text: string;
  sessionId?: string;
  isReflection?: boolean;
}

interface TaskItem {
  id: string;
  text: string;      // plain text from the task name field (may include @mention text)
  emails: string[];  // @emails extracted from the task name field
  duration: string;
}

let _plannerIdCounter = 0;
function mkPlanId() { return `pt-${++_plannerIdCounter}`; }

interface Props {
  headerLabel: string;
  placeholder: string;
  messages: Message[];
  onSend: (text: string) => void;
  onSendMultiTask?: (tasks: { name: string; duration?: string; attendees: string[] }[], allAttendeeEmails: string[]) => void;
  contextLabel?: string;
  mentionSearchEndpoint?: string;
  currentUserEmail?: string;
  isLoading?: boolean;
  onStop?: () => void;
  onReset?: () => void;
  onClose?: () => void;
  extraActions?: ReactNode;
}

export default function ChatBar({ headerLabel, placeholder, messages, onSend, onSendMultiTask, contextLabel, mentionSearchEndpoint, currentUserEmail, isLoading, onStop, onReset, onClose, extraActions }: Props) {
  const [isEmpty, setIsEmpty] = useState(true);
  const [showPlanner, setShowPlanner] = useState(false);
  const [plannerTasks, setPlannerTasks] = useState<TaskItem[]>([
    { id: mkPlanId(), text: '', emails: [], duration: '' },
    { id: mkPlanId(), text: '', emails: [], duration: '' },
  ]);
  const [mentionQuery, setMentionQuery] = useState<string | null>(null);
  const [mentionResults, setMentionResults] = useState<UserSuggestion[]>([]);
  const [mentionIndex, setMentionIndex] = useState(0);
  const bottomRef = useRef<HTMLDivElement>(null);
  const editableRef = useRef<HTMLDivElement>(null);
  const debounceRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(() => {
    bottomRef.current?.scrollIntoView({ behavior: 'smooth' });
  }, [messages]);

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

  function handleInput() {
    const el = editableRef.current;
    if (!el) return;

    const text = getTextContent(el);
    setIsEmpty(text.trim().length === 0);

    if (!mentionSearchEndpoint) return;

    const textBefore = getTextBeforeCursor(el);
    const match = textBefore.match(/@([^\s@]*)$/);

    if (match) {
      const q = match[1];
      setMentionQuery(q);
      if (debounceRef.current) clearTimeout(debounceRef.current);
      const delay = q.length === 0 ? 0 : 200;
      debounceRef.current = setTimeout(() => searchMentions(q), delay);
    } else {
      setMentionQuery(null);
      setMentionResults([]);
    }
  }

  function insertMention(user: UserSuggestion) {
    if (!user.hasCalendar) return;

    const el = editableRef.current;
    if (!el) return;

    el.focus();
    const sel = window.getSelection();
    if (!sel || sel.rangeCount === 0) return;

    const range = sel.getRangeAt(0);
    const textNode = range.endContainer;
    const offset = range.endOffset;

    if (textNode.nodeType === Node.TEXT_NODE) {
      const nodeText = textNode.textContent ?? '';
      const beforeText = nodeText.slice(0, offset);
      const atMatch = beforeText.match(/@([^\s@]*)$/);

      if (atMatch) {
        const atStart = offset - atMatch[0].length;

        const deleteRange = document.createRange();
        deleteRange.setStart(textNode, atStart);
        deleteRange.setEnd(textNode, offset);
        deleteRange.deleteContents();

        const span = document.createElement('span');
        span.className = 'mention-linked-email';
        span.dataset.mention = `@${user.email}`;
        span.contentEditable = 'false';
        span.textContent = `@${user.email}`;

        const insertRange = sel.getRangeAt(0);
        insertRange.insertNode(span);

        const space = document.createTextNode(' ');
        span.after(space);

        const newRange = document.createRange();
        newRange.setStartAfter(space);
        newRange.collapse(true);
        sel.removeAllRanges();
        sel.addRange(newRange);
      }
    }

    setMentionQuery(null);
    setMentionResults([]);
    setIsEmpty(false);
  }

  function handleKeyDown(e: React.KeyboardEvent<HTMLDivElement>) {
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
        const candidate = mentionResults[mentionIndex];
        if (candidate?.hasCalendar) insertMention(candidate);
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
    const el = editableRef.current;
    if (!el) return;
    const text = getTextContent(el).trim();
    if (!text) return;
    onSend(text);
    el.innerHTML = '';
    setIsEmpty(true);
    setMentionQuery(null);
    setMentionResults([]);
    el.focus();
  }

  const showDropdown = mentionQuery !== null && mentionResults.length > 0;
  const mentionRegex = /@([A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,})/g;

  function renderMessageText(text: string) {
    const matches = Array.from(text.matchAll(mentionRegex));
    if (matches.length === 0) return text;

    const chunks: ReactNode[] = [];
    let lastIndex = 0;

    matches.forEach((match, idx) => {
      const fullMatch = match[0];
      const email = match[1];
      const start = match.index ?? 0;

      if (start > lastIndex) {
        chunks.push(text.slice(lastIndex, start));
      }

      chunks.push(
        <a
          key={`${email}-${idx}-${start}`}
          className="mention-linked-email"
          href={`mailto:${email}`}
          onClick={e => e.stopPropagation()}
        >
          {fullMatch}
        </a>
      );

      lastIndex = start + fullMatch.length;
    });

    if (lastIndex < text.length) {
      chunks.push(text.slice(lastIndex));
    }

    return chunks;
  }

  const validTaskCount = plannerTasks.filter(t => t.text.trim()).length;
  const canSubmitPlanner = validTaskCount >= 2 && !isLoading;

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
          {onReset && (
            <button className="chat-ctrl-btn chat-ctrl-btn--reset" onClick={onReset} title="Restart chat" aria-label="Restart chat">
              &#8635;
            </button>
          )}
          {onClose && (
            <button className="chat-ctrl-btn chat-ctrl-btn--close" onClick={onClose} title="Close chat" aria-label="Close chat">
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
              {renderMessageText(m.text)}
            </div>
            {m.isReflection && (
              <span className="reflection-tag">saved to memory</span>
            )}
          </div>
        ))}
        {isLoading && <LoadingBubble />}
        <div ref={bottomRef} />
      </div>

      <div className="chat-input-area">
        {extraActions && <div style={{ marginBottom: 8 }}>{extraActions}</div>}
        {onSendMultiTask && (
          <div style={{ marginBottom: 8 }}>
            <button
              type="button"
              onClick={() => setShowPlanner(p => !p)}
              style={{
                background: showPlanner ? '#e8f0fe' : 'transparent',
                color: '#1a73e8',
                border: '1px solid #c5d5f5',
                borderRadius: '6px',
                padding: '0.3rem 0.7rem',
                fontSize: '0.8rem',
                fontWeight: 600,
                cursor: 'pointer',
                width: '100%',
              }}
            >
              {showPlanner ? '▾ Plan multiple tasks' : '▸ Plan multiple tasks'}
            </button>
            {showPlanner && (
              <div style={{ marginTop: 8, display: 'flex', flexDirection: 'column', gap: 6 }}>
                {plannerTasks.map((task, i) => (
                  <div key={task.id} style={{ display: 'flex', gap: 6, alignItems: 'flex-start' }}>
                    <div style={{ flex: 2 }}>
                      <MentionInput
                        placeholder={`Task ${i + 1} — e.g. Gym or @friend for joint`}
                        mentionSearchEndpoint={mentionSearchEndpoint}
                        currentUserEmail={currentUserEmail}
                        onChange={(text, emails) =>
                          setPlannerTasks(ts => ts.map((t) => t.id === task.id ? { ...t, text, emails } : t))
                        }
                        disabled={isLoading}
                        inputStyle={{ flex: 1, outline: 'none' }}
                      />
                    </div>
                    <input
                      type="text"
                      placeholder="Duration"
                      value={task.duration}
                      onChange={e => setPlannerTasks(ts => ts.map((t) => t.id === task.id ? { ...t, duration: e.target.value } : t))}
                      style={{
                        flex: 1, padding: '0.35rem 0.5rem', borderRadius: 5,
                        border: '1px solid #dadce0', fontSize: '0.82rem', outline: 'none',
                      }}
                    />
                    {plannerTasks.length > 2 && (
                      <button
                        type="button"
                        onClick={() => setPlannerTasks(ts => ts.filter((t) => t.id !== task.id))}
                        style={{ background: 'none', border: 'none', color: '#d93025', cursor: 'pointer', fontSize: '1rem', padding: '0 4px', marginTop: 4 }}
                        title="Remove task"
                      >×</button>
                    )}
                  </div>
                ))}

                <div style={{ display: 'flex', gap: 6 }}>
                  <button
                    type="button"
                    onClick={() => setPlannerTasks(ts => [...ts, { id: mkPlanId(), text: '', emails: [], duration: '' }])}
                    style={{
                      flex: 1, background: 'transparent', color: '#1a73e8',
                      border: '1px dashed #c5d5f5', borderRadius: 5,
                      padding: '0.3rem', fontSize: '0.8rem', cursor: 'pointer',
                    }}
                  >+ Add task</button>
                  <button
                    type="button"
                    disabled={!canSubmitPlanner}
                    onClick={() => {
                      const valid = plannerTasks
                        .filter(t => t.text.trim())
                        .map(t => ({ name: t.text.trim(), duration: t.duration.trim() || undefined, attendees: t.emails }));
                      const allEmails = valid.flatMap(t => t.attendees).filter((e, i, a) => a.indexOf(e) === i);
                      onSendMultiTask(valid, allEmails);
                      setShowPlanner(false);
                      setPlannerTasks([
                        { id: mkPlanId(), text: '', emails: [], duration: '' },
                        { id: mkPlanId(), text: '', emails: [], duration: '' },
                      ]);
                    }}
                    style={{
                      flex: 2,
                      background: canSubmitPlanner ? '#1a73e8' : '#ccc',
                      color: '#fff', border: 'none', borderRadius: 5,
                      padding: '0.3rem 0.6rem', fontSize: '0.82rem', fontWeight: 600,
                      cursor: canSubmitPlanner ? 'pointer' : 'not-allowed',
                    }}
                  >Suggest Schedule</button>
                </div>
              </div>
            )}
          </div>
        )}
        {showDropdown && (
          <div className="mention-dropdown">
            {mentionResults.map((u, i) => (
              <div
                key={u.email}
                className={`mention-option${i === mentionIndex && u.hasCalendar ? ' mention-option--active' : ''}${!u.hasCalendar ? ' mention-option--disabled' : ''}`}
                onMouseDown={e => { e.preventDefault(); insertMention(u); }}
                title={!u.hasCalendar ? 'This user has not connected Google Calendar' : undefined}
              >
                <span className="mention-option-name">{u.displayName || u.email}</span>
                <span className="mention-option-email">{u.email}</span>
                {!u.hasCalendar && <span className="mention-option-tag">No calendar</span>}
              </div>
            ))}
          </div>
        )}
        <div className="chat-input-row">
          <div className="chat-textarea-wrapper">
            <div
              ref={editableRef}
              contentEditable
              suppressContentEditableWarning
              className="chat-contenteditable"
              onInput={handleInput}
              onKeyDown={handleKeyDown}
              data-placeholder={placeholder}
            />
          </div>
          <div className="chat-input-actions">
            {isLoading && onStop ? (
              <button
                type="button"
                className="chat-stop-btn"
                onClick={onStop}
                title="Stop generating"
                aria-label="Stop generating"
              />
            ) : (
              <button
                className="chat-send-btn"
                onClick={submit}
                disabled={isEmpty}
                title="Send"
              >
                ↑
              </button>
            )}
          </div>
        </div>
      </div>
    </div>
  );
}
