import { useEffect, useRef, useState } from 'react';
import { useNavigate, useParams } from 'react-router-dom';
import { api } from '../lib/api';
import { Card, Button, SectionHeader } from '../ui';

// Full content of one drill, plus a live AI roleplay of the exact
// scenario it covers — reuses the same real Anthropic integration point
// every other AI feature in this app uses (aiProvider.js, via the new
// /roleplay route), never a second one.
export default function DrillDetailPage() {
  const { courseId, lessonId } = useParams();
  const navigate = useNavigate();
  const [course, setCourse] = useState(null);
  const [lesson, setLesson] = useState(null);
  const [error, setError] = useState('');

  useEffect(() => {
    load();
  }, [courseId, lessonId]);

  async function load() {
    setError('');
    try {
      const data = await api.trainingCourse(courseId);
      setCourse(data.course);
      const found = data.course.lessons.find((l) => l.id === lessonId);
      setLesson(found || null);
    } catch (err) {
      setError(err.data?.message || 'Could not load this drill.');
    }
  }

  if (error) {
    return (
      <div style={s.loadErrorBox}>
        {error}
        <button style={s.retryButton} onClick={load}>RETRY</button>
      </div>
    );
  }

  if (!course || !lesson) return <div style={s.wrap}>Loading…</div>;

  return (
    <div style={s.wrap}>
      <button style={s.backButton} onClick={() => navigate(-1)}>← BACK TO DRILL LIBRARY</button>

      <section style={s.section}>
        <div style={s.eyebrow}>{course.title}</div>
        <h2 style={s.title}>{lesson.title}</h2>
      </section>

      <section style={s.section}>
        <SectionHeader>Drill Breakdown</SectionHeader>
        <Card>
          <div style={s.content}>{lesson.content}</div>
        </Card>
      </section>

      <section style={s.section}>
        <SectionHeader>Practice This Drill</SectionHeader>
        <RoleplayPanel lessonId={lesson.id} />
      </section>
    </div>
  );
}

function RoleplayPanel({ lessonId }) {
  const [messages, setMessages] = useState([]);
  const [started, setStarted] = useState(false);
  const [draft, setDraft] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [degraded, setDegraded] = useState(false);
  const bottomRef = useRef(null);

  useEffect(() => {
    bottomRef.current?.scrollIntoView({ block: 'end' });
  }, [messages]);

  async function startRoleplay() {
    setStarted(true);
    setBusy(true);
    setError('');
    try {
      const res = await api.roleplayMessage(lessonId, []);
      if (!res.available) {
        setDegraded(true);
        setMessages([{ role: 'assistant', content: res.message }]);
      } else {
        setMessages([{ role: 'assistant', content: res.message }]);
      }
    } catch (err) {
      setError(err.data?.message || 'Could not start the roleplay.');
      setStarted(false);
    } finally {
      setBusy(false);
    }
  }

  async function send() {
    const content = draft.trim();
    if (!content || busy) return;
    const updated = [...messages, { role: 'user', content }];
    setMessages(updated);
    setDraft('');
    setBusy(true);
    setError('');
    try {
      const res = await api.roleplayMessage(lessonId, updated);
      if (!res.available) setDegraded(true);
      setMessages([...updated, { role: 'assistant', content: res.message }]);
    } catch (err) {
      setError(err.data?.message || 'The roleplay hit an error — try again.');
    } finally {
      setBusy(false);
    }
  }

  if (!started) {
    return (
      <Card>
        <p style={s.roleplayIntro}>
          Run a live back-and-forth roleplay of this exact drill. Play the agent, or play the customer —
          the AI figures out which one you're doing and takes the other role.
        </p>
        <Button variant="primary" onClick={startRoleplay}>START ROLEPLAY</Button>
      </Card>
    );
  }

  return (
    <Card style={s.roleplayCard}>
      {degraded && <div style={s.degradedNote}>AI roleplay isn't fully configured on this environment right now.</div>}
      <div style={s.thread}>
        {messages.map((m, i) => (
          <div key={i} style={s.bubbleRow(m.role === 'user')}>
            <div style={s.bubble(m.role === 'user')}>{m.content}</div>
          </div>
        ))}
        {busy && <div style={s.thinking}>…</div>}
        <div ref={bottomRef} />
      </div>
      {error && <div style={s.error}>{error}</div>}
      <div style={s.inputRow}>
        <input
          style={s.input}
          placeholder="Say your next line…"
          value={draft}
          onChange={(e) => setDraft(e.target.value)}
          onKeyDown={(e) => { if (e.key === 'Enter') send(); }}
          disabled={busy || degraded}
        />
        <Button variant="primary" onClick={send} disabled={busy || degraded || !draft.trim()}>SEND</Button>
      </div>
    </Card>
  );
}

const s = {
  wrap: {},
  loadErrorBox: { background: 'var(--danger-soft)', border: '1px solid rgba(255, 77, 94, 0.4)', color: 'var(--danger)', padding: 16, borderRadius: 8, fontSize: 13, display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 12 },
  retryButton: { padding: '6px 12px', background: 'var(--accent)', border: 'none', borderRadius: 6, fontWeight: 700, cursor: 'pointer', fontSize: 11 },
  backButton: { background: 'none', border: 'none', color: 'var(--text-secondary)', fontSize: 12, cursor: 'pointer', marginBottom: 16, padding: 0 },
  section: { marginBottom: 28 },
  eyebrow: { color: 'var(--text-muted)', fontSize: 11, letterSpacing: 1, textTransform: 'uppercase', marginBottom: 4 },
  title: { color: 'var(--text-primary)', fontSize: 22, margin: 0 },
  content: { color: 'var(--text-secondary)', fontSize: 14, lineHeight: 1.7, whiteSpace: 'pre-wrap' },
  roleplayIntro: { color: 'var(--text-secondary)', fontSize: 13, lineHeight: 1.6, marginBottom: 14 },
  roleplayCard: { display: 'flex', flexDirection: 'column', height: 480 },
  thread: { flex: 1, overflowY: 'auto', display: 'flex', flexDirection: 'column', gap: 8, marginBottom: 12 },
  bubbleRow: (mine) => ({ display: 'flex', justifyContent: mine ? 'flex-end' : 'flex-start' }),
  bubble: (mine) => ({
    maxWidth: '80%', padding: '8px 12px', borderRadius: 10, fontSize: 13,
    background: mine ? 'var(--accent)' : 'var(--bg-hover)', color: mine ? 'var(--accent-on)' : 'var(--text-primary)',
    border: mine ? 'none' : '1px solid var(--border-strong)',
  }),
  thinking: { color: 'var(--text-muted)', fontSize: 13, fontStyle: 'italic' },
  degradedNote: { color: 'var(--warning)', fontSize: 12, marginBottom: 8 },
  error: { color: 'var(--danger)', fontSize: 12, marginBottom: 8 },
  inputRow: { display: 'flex', gap: 8 },
  input: { flex: 1, padding: '10px 12px', background: 'var(--bg-sunken)', border: '1px solid var(--border-strong)', borderRadius: 6, color: 'var(--text-primary)', fontSize: 13 },
};
