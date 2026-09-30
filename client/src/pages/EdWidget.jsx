import { useEffect, useRef, useState } from 'react';
import { api } from '../lib/api';
import { Icon, MicButton } from '../ui';

const HUMOR_LEVELS = ['LOW', 'NORMAL', 'SPICY'];
const HUMOR_DESCRIPTIONS = {
  LOW: 'Direct, warm, minimal jokes.',
  NORMAL: 'A little playful — one light line is plenty.',
  SPICY: 'Big energy — rapid-fire wisecracks, never at the expense of the point.',
};

export default function EdWidget() {
  const [open, setOpen] = useState(false);
  const [messages, setMessages] = useState([]);
  const [input, setInput] = useState('');
  const [busy, setBusy] = useState(false);
  const [aiConfigured, setAiConfigured] = useState(true);
  const [historyLoaded, setHistoryLoaded] = useState(false);
  const [showEscalate, setShowEscalate] = useState(false);
  const [showSettings, setShowSettings] = useState(false);
  const [escalateForm, setEscalateForm] = useState({ subject: '', description: '' });
  const [escalateStatus, setEscalateStatus] = useState('');
  // SPICY is ED's default personality — a gear-icon settings popup (not a
  // persistent top row) is where a person can dial it down if they'd
  // rather.
  const [humorLevel, setHumorLevel] = useState(() => {
    try {
      return localStorage.getItem('ed_humor_level') || 'SPICY';
    } catch {
      return 'SPICY';
    }
  });
  const [briefing, setBriefing] = useState(null);
  const scrollRef = useRef(null);

  useEffect(() => {
    api.edStatus().then((d) => setAiConfigured(d.aiConfigured)).catch(() => {});
  }, []);

  function selectHumorLevel(level) {
    setHumorLevel(level);
    try {
      localStorage.setItem('ed_humor_level', level);
    } catch {
      // per-viewer convenience only — fine if storage is unavailable
    }
    setShowSettings(false);
  }

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

  // The daily briefing is on-demand, not persisted chat history — request
  // it at most once per real calendar day per browser, and show it as ED's
  // opening line the first time the widget is opened that day.
  useEffect(() => {
    if (open && historyLoaded && briefing === null) {
      const today = new Date().toISOString().slice(0, 10);
      let lastShown = null;
      try {
        lastShown = localStorage.getItem('ed_briefing_shown_date');
      } catch {
        // no persisted memory of the last briefing date — just show one now
      }
      if (lastShown === today) {
        setBriefing(false);
        return;
      }
      api.edBriefing(humorLevel)
        .then((res) => {
          setBriefing({ content: res.message, degraded: !res.available });
          try {
            localStorage.setItem('ed_briefing_shown_date', today);
          } catch {
            // fine — briefing just shows again next open today
          }
        })
        .catch(() => setBriefing(false));
    }
  }, [open, historyLoaded, briefing, humorLevel]);

  useEffect(() => {
    if (scrollRef.current) scrollRef.current.scrollTop = scrollRef.current.scrollHeight;
  }, [messages, open, showEscalate, briefing]);

  async function send() {
    if (!input.trim() || busy) return;
    const userMsg = input.trim();
    setMessages((m) => [...m, { role: 'user', content: userMsg }]);
    setInput('');
    setBusy(true);
    try {
      const res = await api.edAsk(userMsg, humorLevel);
      setMessages((m) => [...m, { role: 'assistant', content: res.message, degraded: !res.available }]);
    } catch (err) {
      setMessages((m) => [...m, { role: 'assistant', content: err.data?.message || "Something went wrong on my end. Try again in a bit.", degraded: true }]);
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
      <button style={s.fab} onClick={() => setOpen(!open)} data-tour="ed-widget">
        {open ? '✕' : '⚡'}
      </button>

      {open && (
        <div style={s.panel}>
          <div style={s.header}>
            <span style={s.headerTitle}>ED</span>
            {!aiConfigured && <span style={s.degradedBadge}>Language layer not configured</span>}
            {!showEscalate && (
              <button
                style={s.gearButton}
                onClick={() => setShowSettings(!showSettings)}
                title="ED's settings"
                aria-label="ED's settings"
              >
                <Icon name="gear" size={15} />
              </button>
            )}
            <button style={s.escalateLink} onClick={() => { setShowEscalate(!showEscalate); setShowSettings(false); }}>
              {showEscalate ? 'Back to chat' : 'Can\'t find what you need?'}
            </button>
          </div>

          {showSettings && !showEscalate && (
            <div style={s.settingsPopup}>
              <div style={s.settingsLabel}>ED'S TONE</div>
              {HUMOR_LEVELS.map((level) => (
                <button
                  key={level}
                  style={s.settingsOption(level === humorLevel)}
                  onClick={() => selectHumorLevel(level)}
                >
                  <span style={s.settingsOptionName}>{level}</span>
                  <span style={s.settingsOptionDesc}>{HUMOR_DESCRIPTIONS[level]}</span>
                </button>
              ))}
            </div>
          )}

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
              <div style={s.escalateTextareaWrap}>
                <textarea
                  style={{ ...s.input, minHeight: 100, resize: 'none' }}
                  placeholder="What's going on?"
                  value={escalateForm.description}
                  onChange={(e) => setEscalateForm({ ...escalateForm, description: e.target.value })}
                  required
                />
                <MicButton
                  style={s.escalateMic}
                  onTranscript={(text) => setEscalateForm((f) => ({ ...f, description: f.description ? `${f.description} ${text}` : text }))}
                />
              </div>
              <button style={s.sendButtonFull} type="submit">Create Ticket</button>
              {escalateStatus && <div style={s.escalateStatus}>{escalateStatus}</div>}
            </form>
          ) : (
            <>
              <div style={s.messages} ref={scrollRef}>
                {messages.length === 0 && !briefing && (
                  <div style={s.emptyState}>Ask about your pace, your queue, or what needs attention.</div>
                )}
                {briefing && <div style={s.edBubble(briefing.degraded)}>{briefing.content}</div>}
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
                <MicButton onTranscript={(text) => setInput((v) => (v ? `${v} ${text}` : text))} />
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
    position: 'fixed', bottom: 'var(--ed-bottom, 24px)', right: 24, width: 56, height: 56, borderRadius: '50%',
    background: 'var(--accent-gradient)', color: 'var(--accent-on)', border: 'none', fontSize: 22, cursor: 'pointer', zIndex: 'var(--z-drawer)',
    boxShadow: 'var(--shadow-glow-accent)',
  },
  panel: {
    position: 'fixed', bottom: 'calc(var(--ed-bottom, 24px) + 68px)', right: 24, width: 340, height: 460, background: 'var(--bg-elevated)',
    backdropFilter: 'var(--glass-blur)', WebkitBackdropFilter: 'var(--glass-blur)',
    border: '1px solid var(--border-hairline)', borderTopColor: 'var(--border-glass-highlight)',
    borderRadius: 'var(--radius-lg)', display: 'flex', flexDirection: 'column',
    zIndex: 'var(--z-drawer)', overflow: 'hidden', boxShadow: 'var(--shadow-card)',
  },
  header: { padding: '12px 16px', borderBottom: '1px solid var(--border-hairline)', display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap' },
  headerTitle: {
    fontFamily: 'var(--font-display)', fontWeight: 700, letterSpacing: 1,
    backgroundImage: 'var(--accent-gradient)', WebkitBackgroundClip: 'text', backgroundClip: 'text', color: 'transparent',
  },
  degradedBadge: { fontSize: 10, color: 'var(--warning)', border: '1px solid rgba(255,184,77,0.4)', padding: '2px 6px', borderRadius: 4 },
  escalateLink: { marginLeft: 'auto', background: 'none', border: 'none', color: 'var(--text-muted)', fontSize: 11, cursor: 'pointer', textDecoration: 'underline' },
  gearButton: {
    background: 'none', border: 'none', color: 'var(--text-muted)', cursor: 'pointer',
    display: 'flex', alignItems: 'center', justifyContent: 'center', padding: 4, borderRadius: 6,
  },
  settingsPopup: {
    position: 'absolute', top: 48, right: 16, width: 240, background: 'var(--bg-elevated)',
    border: '1px solid var(--border-hairline)', borderRadius: 'var(--radius-md)', boxShadow: 'var(--shadow-card)',
    padding: 10, display: 'flex', flexDirection: 'column', gap: 6, zIndex: 1,
  },
  settingsLabel: { fontSize: 10, letterSpacing: 1, color: 'var(--text-muted)', padding: '2px 4px 4px' },
  settingsOption: (active) => ({
    display: 'flex', flexDirection: 'column', alignItems: 'flex-start', gap: 2, textAlign: 'left',
    padding: '8px 10px', borderRadius: 8, cursor: 'pointer',
    border: active ? 'none' : '1px solid var(--border-strong)',
    background: active ? 'var(--accent-gradient)' : 'transparent',
    color: active ? 'var(--accent-on)' : 'var(--text-primary)',
  }),
  settingsOptionName: { fontSize: 11, letterSpacing: 0.5, fontWeight: 700 },
  settingsOptionDesc: { fontSize: 10.5, lineHeight: 1.3, opacity: 0.85 },
  messages: { flex: 1, overflowY: 'auto', padding: 12, display: 'flex', flexDirection: 'column', gap: 8 },
  emptyState: { color: 'var(--text-muted)', fontSize: 12, fontStyle: 'italic', padding: 8 },
  userBubble: { alignSelf: 'flex-end', background: 'var(--accent-gradient)', color: 'var(--accent-on)', padding: '8px 12px', borderRadius: 10, fontSize: 13, maxWidth: '85%' },
  edBubble: (degraded) => ({
    alignSelf: 'flex-start', background: degraded ? 'var(--warning-soft)' : 'var(--bg-hover)', color: degraded ? 'var(--warning)' : 'var(--text-primary)',
    padding: '8px 12px', borderRadius: 10, fontSize: 13, maxWidth: '85%',
  }),
  inputRow: { display: 'flex', borderTop: '1px solid var(--border-hairline)', padding: 8, gap: 8 },
  input: { flex: 1, padding: '8px 10px', background: 'var(--bg-sunken)', border: '1px solid var(--border-strong)', borderRadius: 6, color: 'var(--text-primary)', fontSize: 13 },
  sendButton: { width: 36, background: 'var(--accent-gradient)', color: 'var(--accent-on)', border: 'none', borderRadius: 6, fontWeight: 700, cursor: 'pointer' },
  escalateForm: { flex: 1, display: 'flex', flexDirection: 'column', gap: 10, padding: 12, overflowY: 'auto' },
  escalateHint: { color: 'var(--text-secondary)', fontSize: 12, marginBottom: 4 },
  escalateTextareaWrap: { position: 'relative' },
  escalateMic: { position: 'absolute', bottom: 8, right: 8 },
  sendButtonFull: { padding: '10px', background: 'var(--accent-gradient)', color: 'var(--accent-on)', border: 'none', borderRadius: 6, fontWeight: 700, cursor: 'pointer', fontSize: 13 },
  escalateStatus: { color: 'var(--accent)', fontSize: 12 },
};
