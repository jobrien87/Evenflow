import { useEffect, useRef, useState } from 'react';
import { api } from '../lib/api';
import { useAuth } from '../lib/AuthContext';
import { MicButton } from '../ui';

const POLL_MS = 5000;

// Mirrors the server's own REACTION_EMOJI (server/src/lib/chat.js) — the
// quick-react palette is validated server-side against this exact list, so
// it must stay in sync by hand (no shared-package import between
// client/server in this app).
const REACTION_EMOJI = ['👍', '❤️', '😂', '😮', '😢', '🙏'];

function truncate(text, max = 80) {
  if (!text) return '';
  return text.length > max ? `${text.slice(0, max)}…` : text;
}

// One pill per distinct emoji present on a message, with a count and
// whether the current user is one of the reactors (drives the highlight).
function groupReactions(reactions, userId) {
  const groups = [];
  const byEmoji = new Map();
  for (const r of reactions || []) {
    let g = byEmoji.get(r.emoji);
    if (!g) {
      g = { emoji: r.emoji, count: 0, mine: false };
      byEmoji.set(r.emoji, g);
      groups.push(g);
    }
    g.count += 1;
    if (r.userId === userId) g.mine = true;
  }
  return groups;
}

// Opens (or creates) the thread scoped to a single Lead/Transfer/Agency
// and polls for new messages while open — no websockets, matching the
// rest of this app. variant="modal" (default) is the original fixed
// overlay; variant="inline" renders the same header/thread/input flush
// into whatever container the parent provides (no backdrop, no close
// button) — used for the persistent agency-wide team room, which lives
// embedded in a page rather than popped over it.
export default function ChatThread({ entityType, entityId, title, onClose, variant = 'modal', unread = false }) {
  const { user } = useAuth();
  const [conversationId, setConversationId] = useState(null);
  const [messages, setMessages] = useState(null);
  const [draft, setDraft] = useState('');
  const [sending, setSending] = useState(false);
  const [error, setError] = useState('');
  const [hoveredId, setHoveredId] = useState(null);
  const [replyingTo, setReplyingTo] = useState(null);
  const bottomRef = useRef(null);
  const mountedRef = useRef(true);

  useEffect(() => () => { mountedRef.current = false; }, []);

  async function refreshMessages(id) {
    try {
      const res = await api.chatMessages(id);
      if (mountedRef.current) setMessages(res.messages);
    } catch (err) {
      if (mountedRef.current) setError(err.data?.message || 'Could not load messages.');
    }
  }

  useEffect(() => {
    let cancelled = false;
    let interval;

    async function init() {
      try {
        const res = await api.chatEntityConversation(entityType, entityId);
        if (cancelled) return;
        setConversationId(res.conversation.id);
        await refreshMessages(res.conversation.id);
        if (cancelled) return;
        interval = setInterval(() => refreshMessages(res.conversation.id), POLL_MS);
      } catch (err) {
        if (!cancelled) setError(err.data?.message || 'Could not open this conversation.');
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
      const res = await api.postChatMessage(conversationId, content, replyingTo?.id);
      // Attach the quoted snippet locally so the sender sees it on their own
      // reply right away — postMessage's response has no `replyTo` include,
      // and the other party gets it from the next poll tick regardless.
      const message = replyingTo
        ? { ...res.message, replyTo: { id: replyingTo.id, content: replyingTo.content, authorId: replyingTo.authorId, author: replyingTo.author } }
        : res.message;
      setMessages((prev) => [...(prev || []), message]);
      setDraft('');
      setReplyingTo(null);
    } catch (err) {
      setError(err.data?.message || 'Message failed to send.');
    } finally {
      setSending(false);
    }
  }

  async function handleReact(messageId, emoji) {
    if (!conversationId) return;
    try {
      await api.toggleMessageReaction(messageId, emoji);
      await refreshMessages(conversationId);
    } catch (err) {
      setError(err.data?.message || 'Could not react to that message.');
    }
  }

  const inline = variant === 'inline';

  const body = (
    <div style={inline ? s.inlineModal : s.modal} onClick={inline ? undefined : (e) => e.stopPropagation()}>
      <div style={s.header}>
        <div style={s.titleRow}>
          <div style={s.title}>{title || 'DISCUSSION'}</div>
          {unread && <span style={s.unreadDot} />}
        </div>
        {!inline && <button style={s.closeButton} onClick={onClose}>CLOSE</button>}
      </div>

      <div style={s.thread}>
        {messages === null && !error && <div style={s.muted}>Loading…</div>}
        {messages !== null && messages.length === 0 && <div style={s.muted}>No messages yet — say something.</div>}
        {messages?.map((m) => {
          const mine = m.authorId === user?.id;
          const reactionGroups = groupReactions(m.reactions, user?.id);
          return (
            <div
              key={m.id}
              style={s.messageRow(mine)}
              onMouseEnter={() => setHoveredId(m.id)}
              onMouseLeave={() => setHoveredId((h) => (h === m.id ? null : h))}
            >
              <div style={s.messageCol(mine)}>
                {hoveredId === m.id && (
                  <div style={s.hoverToolbar(mine)}>
                    <button style={s.toolbarButton} title="Reply" onClick={() => setReplyingTo(m)}>↩</button>
                    {REACTION_EMOJI.map((emoji) => (
                      <button key={emoji} style={s.toolbarButton} title={`React ${emoji}`} onClick={() => handleReact(m.id, emoji)}>{emoji}</button>
                    ))}
                  </div>
                )}
                <div style={s.bubble(mine)}>
                  {!mine && <div style={s.author}>{m.author?.firstName} {m.author?.lastName}</div>}
                  {m.replyTo && (
                    <div style={s.quoteBlock}>
                      <div style={s.quoteAuthor}>{m.replyTo.author?.firstName} {m.replyTo.author?.lastName}</div>
                      <div style={s.quoteContent}>{truncate(m.replyTo.content, 80)}</div>
                    </div>
                  )}
                  <div>{m.content}</div>
                  <div style={s.time}>{new Date(m.createdAt).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}</div>
                </div>
                {reactionGroups.length > 0 && (
                  <div style={s.reactionsRow(mine)}>
                    {reactionGroups.map((g) => (
                      <button key={g.emoji} style={s.reactionPill(g.mine)} onClick={() => handleReact(m.id, g.emoji)}>
                        {g.emoji} {g.count}
                      </button>
                    ))}
                  </div>
                )}
              </div>
            </div>
          );
        })}
        <div ref={bottomRef} />
      </div>

      {error && <div style={s.error}>{error}</div>}

      {replyingTo && (
        <div style={s.replyBar}>
          <div style={s.replyBarText}>
            Replying to {replyingTo.author?.firstName} {replyingTo.author?.lastName} — {truncate(replyingTo.content, 60)}
          </div>
          <button style={s.replyBarCancel} onClick={() => setReplyingTo(null)}>✕</button>
        </div>
      )}

      <div style={s.inputRow}>
        <input
          style={s.input}
          placeholder="Type a message…"
          value={draft}
          onChange={(e) => setDraft(e.target.value)}
          onKeyDown={(e) => { if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); send(); } }}
          disabled={!conversationId}
        />
        <MicButton onTranscript={(text) => setDraft((d) => (d ? `${d} ${text}` : text))} />
        <button style={s.sendButton} disabled={sending || !draft.trim() || !conversationId} onClick={send}>
          SEND
        </button>
      </div>
    </div>
  );

  if (inline) return body;

  return (
    <div style={s.overlay} onClick={onClose}>
      {body}
    </div>
  );
}

const s = {
  overlay: { position: 'fixed', top: 0, left: 0, right: 0, bottom: 0, background: 'rgba(6,7,9,0.6)', backdropFilter: 'var(--glass-blur-sm)', WebkitBackdropFilter: 'var(--glass-blur-sm)', display: 'flex', alignItems: 'center', justifyContent: 'center', zIndex: 2500, padding: 20 },
  modal: { background: 'var(--bg-elevated)', backdropFilter: 'var(--glass-blur)', WebkitBackdropFilter: 'var(--glass-blur)', border: '1px solid var(--border-strong)', borderTopColor: 'var(--border-glass-highlight)', borderRadius: 12, padding: 20, maxWidth: 480, width: '100%', maxHeight: '80vh', display: 'flex', flexDirection: 'column', color: 'var(--text-primary)' },
  inlineModal: { background: 'var(--bg-elevated)', backdropFilter: 'var(--glass-blur)', WebkitBackdropFilter: 'var(--glass-blur)', border: '1px solid var(--border-hairline)', borderTopColor: 'var(--border-glass-highlight)', borderRadius: 'var(--radius-lg)', padding: 16, height: '100%', minHeight: 320, display: 'flex', flexDirection: 'column', color: 'var(--text-primary)' },
  header: { display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 14 },
  titleRow: { display: 'flex', alignItems: 'center', gap: 6 },
  title: { color: 'var(--text-secondary)', fontSize: 12, fontWeight: 700, letterSpacing: 1 },
  unreadDot: { display: 'inline-block', width: 7, height: 7, borderRadius: '50%', background: 'var(--accent-gradient)' },
  closeButton: { padding: '6px 12px', background: 'transparent', border: '1px solid var(--border-strong)', color: 'var(--text-secondary)', borderRadius: 6, cursor: 'pointer', fontSize: 11 },
  thread: { flex: 1, overflowY: 'auto', minHeight: 200, display: 'flex', flexDirection: 'column', gap: 8, marginBottom: 12 },
  muted: { color: 'var(--text-muted)', fontSize: 13, fontStyle: 'italic', margin: 'auto' },
  error: { color: 'var(--danger)', fontSize: 12, marginBottom: 8 },
  messageRow: (mine) => ({ display: 'flex', justifyContent: mine ? 'flex-end' : 'flex-start' }),
  messageCol: (mine) => ({ display: 'flex', flexDirection: 'column', alignItems: mine ? 'flex-end' : 'flex-start', maxWidth: '80%' }),
  hoverToolbar: (mine) => ({ display: 'flex', gap: 2, alignSelf: mine ? 'flex-end' : 'flex-start', marginBottom: 2, background: 'var(--bg-elevated)', border: '1px solid var(--border-strong)', borderRadius: 8, padding: '2px 4px' }),
  toolbarButton: { background: 'transparent', border: 'none', cursor: 'pointer', fontSize: 13, padding: '2px 5px', borderRadius: 4, lineHeight: 1.4 },
  bubble: (mine) => ({
    maxWidth: '100%', padding: '8px 12px', borderRadius: 10, fontSize: 13,
    background: mine ? 'var(--accent)' : 'var(--bg-hover)', color: mine ? 'var(--accent-on)' : 'var(--text-primary)',
    border: mine ? 'none' : '1px solid var(--border-strong)',
  }),
  author: { fontSize: 10, fontWeight: 700, opacity: 0.7, marginBottom: 2 },
  quoteBlock: { borderLeft: '2px solid currentColor', paddingLeft: 8, marginBottom: 4, opacity: 0.75 },
  quoteAuthor: { fontSize: 10, fontWeight: 700 },
  quoteContent: { fontSize: 11 },
  time: { fontSize: 9, opacity: 0.55, marginTop: 4, textAlign: 'right' },
  reactionsRow: (mine) => ({ display: 'flex', gap: 4, flexWrap: 'wrap', marginTop: 3, justifyContent: mine ? 'flex-end' : 'flex-start' }),
  reactionPill: (mineReacted) => ({
    fontSize: 11, padding: '1px 7px', borderRadius: 10, cursor: 'pointer',
    border: mineReacted ? '1px solid var(--accent)' : '1px solid var(--border-strong)',
    background: mineReacted ? 'var(--accent-gradient-soft)' : 'var(--bg-hover)',
    color: 'var(--text-primary)',
  }),
  replyBar: { display: 'flex', justifyContent: 'space-between', alignItems: 'center', gap: 8, padding: '6px 10px', background: 'var(--bg-hover)', border: '1px solid var(--border-strong)', borderRadius: 6, marginBottom: 8, fontSize: 11 },
  replyBarText: { color: 'var(--text-secondary)', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' },
  replyBarCancel: { background: 'transparent', border: 'none', color: 'var(--text-muted)', cursor: 'pointer', fontSize: 13, flexShrink: 0 },
  inputRow: { display: 'flex', gap: 8 },
  input: { flex: 1, padding: '10px 12px', background: 'var(--bg-sunken)', border: '1px solid var(--border-strong)', borderRadius: 6, color: 'var(--text-primary)', fontSize: 13 },
  sendButton: { padding: '10px 16px', background: 'var(--accent)', border: 'none', borderRadius: 6, fontWeight: 700, cursor: 'pointer', fontSize: 12 },
};
