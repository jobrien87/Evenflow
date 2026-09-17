import { useEffect, useRef, useState } from 'react';
import { api } from '../lib/api';

export default function EdWidget() {
  const [open, setOpen] = useState(false);
  const [messages, setMessages] = useState([]);
  const [input, setInput] = useState('');
  const [busy, setBusy] = useState(false);
  const [aiConfigured, setAiConfigured] = useState(true);
  const [historyLoaded, setHistoryLoaded] = useState(false);
  const [showEscalate, setShowEscalate] = useState(false);
  const [escalateForm, setEscalateForm] = useState({ subject: '', description: '' });
  const [escalateStatus, setEscalateStatus] = useState('');
  const scrollRef = useRef(null);

  useEffect(() => {
    api.edStatus().then((d) => setAiConfigured(d.aiConfigured)).catch(() => {});
  }, []);

  // Load real conversation history from the server the first time the
  // widget is opened, instead of silently starting fresh every time even
  // though the server has been storing it all along.
  useEffect(() => {
    if (open && !historyLoaded) {
      api.edHistory()
        .then((d) => {
          setMessages(d.messages.map((m) => ({ role: m.role, content: m.content })));
          setHistoryLoaded(true);
        })
        .catch(() => setHistoryLoaded(true));
    }
  }, [open, historyLoaded]);

  useEffect(() => {
    if (scrollRef.current) scrollRef.current.scrollTop = scrollRef.current.scrollHeight;
  }, [messages, open, showEscalate]);

  async function send() {
    if (!input.trim() || busy) return;
    const userMsg = input.trim();
    setMessages((m) => [...m, { role: 'user', content: userMsg }]);
    setInput('');
    setBusy(true);
    try {
      const res = await api.edAsk(userMsg);
      setMessages((m) => [...m, { role: 'assistant', content: res.message, degraded: !res.available }]);
    } catch (err) {
      setMessages((m) => [...m, { role: 'assistant', content: "Something went wrong on my end. Try again in a bit.", degraded: true }]);
    } finally {
      setBusy(false);
    }
  }

  async function submitEscalation(e) {
    e.preventDefault();
    setEscalateStatus('Creating ticket…');
    try {
      await api.edEscalate(escalateForm.subject, escalateForm.description);
      setEscalateStatus('Support ticket created. Someone will follow up.');
      setEscalateForm({ subject: '', description: '' });
      setTimeout(() => {
        setShowEscalate(false);
        setEscalateStatus('');
      }, 1500);
    } catch (err) {
      setEscalateStatus(err.data?.message || 'Failed to create ticket.');
    }
  }

  return (
    <>
      <button style={s.fab} onClick={() => setOpen(!open)}>
        {open ? '✕' : '⚡'}
      </button>

      {open && (
        <div style={s.panel}>
          <div style={s.header}>
            <span style={s.headerTitle}>ED</span>
            {!aiConfigured && <span style={s.degradedBadge}>Language layer not configured</span>}
            <button style={s.escalateLink} onClick={() => setShowEscalate(!showEscalate)}>
              {showEscalate ? 'Back to chat' : 'Can\'t find what you need?'}
            </button>
          </div>

          {showEscalate ? (
            <form onSubmit={submitEscalation} style={s.escalateForm}>
              <div style={s.escalateHint}>Create a support ticket. This goes straight to the platform team.</div>
              <input
                style={s.input}
                placeholder="Subject"
                value={escalateForm.subject}
                onChange={(e) => setEscalateForm({ ...escalateForm, subject: e.target.value })}
                required
              />
              <textarea
                style={{ ...s.input, minHeight: 100, resize: 'none' }}
                placeholder="What's going on?"
                value={escalateForm.description}
                onChange={(e) => setEscalateForm({ ...escalateForm, description: e.target.value })}
                required
              />
              <button style={s.sendButtonFull} type="submit">Create Ticket</button>
              {escalateStatus && <div style={s.escalateStatus}>{escalateStatus}</div>}
            </form>
          ) : (
            <>
              <div style={s.messages} ref={scrollRef}>
                {messages.length === 0 && (
                  <div style={s.emptyState}>Ask about your pace, your queue, or what needs attention.</div>
                )}
                {messages.map((m, i) => (
                  <div key={i} style={m.role === 'user' ? s.userBubble : s.edBubble(m.degraded)}>
                    {m.content}
                  </div>
                ))}
                {busy && <div style={s.edBubble(false)}>…</div>}
              </div>
              <div style={s.inputRow}>
                <input
                  style={s.input}
                  value={input}
                  onChange={(e) => setInput(e.target.value)}
                  onKeyDown={(e) => e.key === 'Enter' && send()}
                  placeholder="Ask ED…"
                />
                <button style={s.sendButton} onClick={send} disabled={busy}>
                  →
                </button>
              </div>
            </>
          )}
        </div>
      )}
    </>
  );
}

const s = {
  fab: {
    position: 'fixed', bottom: 24, right: 24, width: 56, height: 56, borderRadius: '50%',
    background: '#00e5ff', border: 'none', fontSize: 22, cursor: 'pointer', zIndex: 1000,
    boxShadow: '0 4px 16px rgba(0,229,255,0.4)',
  },
  panel: {
    position: 'fixed', bottom: 92, right: 24, width: 340, height: 460, background: '#111',
    border: '1px solid #222', borderRadius: 12, display: 'flex', flexDirection: 'column',
    zIndex: 1000, overflow: 'hidden', boxShadow: '0 8px 32px rgba(0,0,0,0.5)',
  },
  header: { padding: '12px 16px', borderBottom: '1px solid #222', display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap' },
  headerTitle: { color: '#00e5ff', fontWeight: 800, letterSpacing: 1 },
  degradedBadge: { fontSize: 10, color: '#ffb84d', border: '1px solid #ffb84d55', padding: '2px 6px', borderRadius: 4 },
  escalateLink: { marginLeft: 'auto', background: 'none', border: 'none', color: '#666', fontSize: 11, cursor: 'pointer', textDecoration: 'underline' },
  messages: { flex: 1, overflowY: 'auto', padding: 12, display: 'flex', flexDirection: 'column', gap: 8 },
  emptyState: { color: '#666', fontSize: 12, fontStyle: 'italic', padding: 8 },
  userBubble: { alignSelf: 'flex-end', background: '#00e5ff', color: '#000', padding: '8px 12px', borderRadius: 10, fontSize: 13, maxWidth: '85%' },
  edBubble: (degraded) => ({
    alignSelf: 'flex-start', background: degraded ? '#1a1610' : '#1a1a1a', color: degraded ? '#ffb84d' : '#fff',
    padding: '8px 12px', borderRadius: 10, fontSize: 13, maxWidth: '85%',
  }),
  inputRow: { display: 'flex', borderTop: '1px solid #222', padding: 8, gap: 8 },
  input: { flex: 1, padding: '8px 10px', background: '#000', border: '1px solid #333', borderRadius: 6, color: '#fff', fontSize: 13 },
  sendButton: { width: 36, background: '#00e5ff', border: 'none', borderRadius: 6, fontWeight: 700, cursor: 'pointer' },
  escalateForm: { flex: 1, display: 'flex', flexDirection: 'column', gap: 10, padding: 12, overflowY: 'auto' },
  escalateHint: { color: '#888', fontSize: 12, marginBottom: 4 },
  sendButtonFull: { padding: '10px', background: '#00e5ff', border: 'none', borderRadius: 6, fontWeight: 700, cursor: 'pointer', fontSize: 13 },
  escalateStatus: { color: '#00e5ff', fontSize: 12 },
};
