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
  hasCalendar?: boolean;
}

interface Props {
  headerLabel: string;
  placeholder: string;
  messages: Message[];
  onSend: (text: string) => void;
  contextLabel?: string;
  mentionSearchEndpoint?: string;
  currentUserEmail?: string;
  isLoading?: boolean;
  onStop?: () => void;
  onReset?: () => void;
  onClose?: () => void;
}

export default function ChatBar({ headerLabel, placeholder, messages, onSend, contextLabel, mentionSearchEndpoint, currentUserEmail, isLoading, onStop, onReset, onClose }: Props) {
  const [isEmpty, setIsEmpty] = useState(true);
  const [mentionQuery, setMentionQuery] = useState<string | null>(null);
  const [mentionResults, setMentionResults] = useState<UserSuggestion[]>([]);
  const [mentionIndex, setMentionIndex] = useState(0);
  const bottomRef = useRef<HTMLDivElement>(null);
  const editableRef = useRef<HTMLDivElement>(null);
  const debounceRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(() => {
    bottomRef.current?.scrollIntoView({ behavior: 'smooth' });
  }, [messages]);

  // Extract plain text from the contenteditable div, preserving mention @email values
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

  // Get the text content from the start of the div up to the current cursor position
  function getTextBeforeCursor(el: HTMLElement): string {
    const sel = window.getSelection();
    if (!sel || sel.rangeCount === 0) return '';
    const range = sel.getRangeAt(0);
    const preRange = range.cloneRange();
    preRange.selectNodeContents(el);
    preRange.setEnd(range.endContainer, range.endOffset);
    return preRange.toString();
  }

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

        // Remove the @query text
        const deleteRange = document.createRange();
        deleteRange.setStart(textNode, atStart);
        deleteRange.setEnd(textNode, offset);
        deleteRange.deleteContents();

        // Build the mention span (non-editable so it acts as a single unit)
        const span = document.createElement('span');
        span.className = 'mention-linked-email';
        span.dataset.mention = `@${user.email}`;
        span.contentEditable = 'false';
        span.textContent = `@${user.email}`;

        // Insert span at the current cursor, then a non-breaking space after it
        const insertRange = sel.getRangeAt(0);
        insertRange.insertNode(span);

        const space = document.createTextNode('\u00a0');
        span.after(space);

        // Move cursor after the trailing space
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
