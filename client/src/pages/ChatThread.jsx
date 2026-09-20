import { useEffect, useRef, useState } from 'react';
import { api } from '../lib/api';
import { useAuth } from '../lib/AuthContext';

const POLL_MS = 5000;

// Opens (or creates) the thread scoped to a single Lead/Transfer and polls
// for new messages while open — no websockets, matching the rest of this app.
export default function ChatThread({ entityType, entityId, title, onClose }) {
  const { user } = useAuth();
  const [conversationId, setConversationId] = useState(null);
  const [messages, setMessages] = useState(null);
  const [draft, setDraft] = useState('');
  const [sending, setSending] = useState(false);
  const [error, setError] = useState('');
  const bottomRef = useRef(null);

  useEffect(() => {
    let cancelled = false;
    let interval;

    async function init() {
      try {
        const res = await api.chatEntityConversation(entityType, entityId);
        if (cancelled) return;
        setConversationId(res.conversation.id);
        await refresh(res.conversation.id);
        interval = setInterval(() => refresh(res.conversation.id), POLL_MS);
      } catch (err) {
        if (!cancelled) setError(err.data?.message || 'Could not open this conversation.');
      }
    }

    async function refresh(id) {
      try {
        const res = await api.chatMessages(id);
        if (!cancelled) setMessages(res.messages);
      } catch (err) {
        if (!cancelled) setError(err.data?.message || 'Could not load messages.');
      }
    }

    init();
    return () => {
      cancelled = true;
      if (interval) clearInterval(interval);
    };
  }, [entityType, entityId]);

  useEffect(() => {
    bottomRef.current?.scrollIntoView({ block: 'end' });
  }, [messages]);

  async function send() {
    const content = draft.trim();
    if (!content || !conversationId) return;
    setSending(true);
    setError('');
    try {
      const res = await api.postChatMessage(conversationId, content);
      setMessages((prev) => [...(prev || []), res.message]);
      setDraft('');
    } catch (err) {
      setError(err.data?.message || 'Message failed to send.');
    } finally {
      setSending(false);
    }
  }

  return (
    <div style={s.overlay} onClick={onClose}>
      <div style={s.modal} onClick={(e) => e.stopPropagation()}>
        <div style={s.header}>
          <div style={s.title}>{title || 'DISCUSSION'}</div>
          <button style={s.closeButton} onClick={onClose}>CLOSE</button>
        </div>

        <div style={s.thread}>
          {messages === null && !error && <div style={s.muted}>Loading…</div>}
          {messages !== null && messages.length === 0 && <div style={s.muted}>No messages yet — say something.</div>}
          {messages?.map((m) => {
            const mine = m.authorId === user?.id;
            return (
              <div key={m.id} style={s.messageRow(mine)}>
                <div style={s.bubble(mine)}>
                  {!mine && <div style={s.author}>{m.author?.firstName} {m.author?.lastName}</div>}
                  <div>{m.content}</div>
                  <div style={s.time}>{new Date(m.createdAt).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}</div>
                </div>
              </div>
            );
          })}
          <div ref={bottomRef} />
        </div>

        {error && <div style={s.error}>{error}</div>}

        <div style={s.inputRow}>
          <input
            style={s.input}
            placeholder="Type a message…"
            value={draft}
            onChange={(e) => setDraft(e.target.value)}
            onKeyDown={(e) => { if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); send(); } }}
            disabled={!conversationId}
          />
          <button style={s.sendButton} disabled={sending || !draft.trim() || !conversationId} onClick={send}>
            SEND
          </button>
        </div>
      </div>
    </div>
  );
}

const s = {
  overlay: { position: 'fixed', top: 0, left: 0, right: 0, bottom: 0, background: 'rgba(0,0,0,0.75)', display: 'flex', alignItems: 'center', justifyContent: 'center', zIndex: 2500, padding: 20 },
  modal: { background: 'var(--bg-elevated)', border: '1px solid var(--border-strong)', borderRadius: 12, padding: 20, maxWidth: 480, width: '100%', maxHeight: '80vh', display: 'flex', flexDirection: 'column', color: 'var(--text-primary)' },
  header: { display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 14 },
  title: { color: 'var(--text-secondary)', fontSize: 12, fontWeight: 700, letterSpacing: 1 },
  closeButton: { padding: '6px 12px', background: 'transparent', border: '1px solid var(--border-strong)', color: 'var(--text-secondary)', borderRadius: 6, cursor: 'pointer', fontSize: 11 },
  thread: { flex: 1, overflowY: 'auto', minHeight: 200, display: 'flex', flexDirection: 'column', gap: 8, marginBottom: 12 },
  muted: { color: 'var(--text-muted)', fontSize: 13, fontStyle: 'italic', margin: 'auto' },
  error: { color: 'var(--danger)', fontSize: 12, marginBottom: 8 },
  messageRow: (mine) => ({ display: 'flex', justifyContent: mine ? 'flex-end' : 'flex-start' }),
  bubble: (mine) => ({
    maxWidth: '80%', padding: '8px 12px', borderRadius: 10, fontSize: 13,
    background: mine ? 'var(--accent)' : 'var(--bg-hover)', color: mine ? 'var(--accent-on)' : 'var(--text-primary)',
    border: mine ? 'none' : '1px solid var(--border-strong)',
  }),
  author: { fontSize: 10, fontWeight: 700, opacity: 0.7, marginBottom: 2 },
  time: { fontSize: 9, opacity: 0.55, marginTop: 4, textAlign: 'right' },
  inputRow: { display: 'flex', gap: 8 },
  input: { flex: 1, padding: '10px 12px', background: 'var(--bg-sunken)', border: '1px solid var(--border-strong)', borderRadius: 6, color: 'var(--text-primary)', fontSize: 13 },
  sendButton: { padding: '10px 16px', background: 'var(--accent)', border: 'none', borderRadius: 6, fontWeight: 700, cursor: 'pointer', fontSize: 12 },
};
