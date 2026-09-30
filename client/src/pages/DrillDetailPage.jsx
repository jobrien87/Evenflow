import { useEffect, useRef, useState } from 'react';
import { useNavigate, useParams } from 'react-router-dom';
import { api } from '../lib/api';
import { Card, Button, SectionHeader, Icon } from '../ui';
import { parseDrillContent, parseNumberedSteps, parseBulletList, parseDialogue } from '../lib/drillContent';

// Each of the 5 real section headings every drill has gets its own
// module treatment — icon, tone, and layout — instead of one flat
// wall of pre-wrap text.
const MODULE_META = {
  'WHY THIS WORKS': { icon: 'sparkle', label: 'Concept', tone: 'accent' },
  'HOW TO RUN THIS DRILL': { icon: 'checklist', label: 'Steps', tone: 'neutral' },
  'EXAMPLE': { icon: 'chat', label: 'Walkthrough', tone: 'neutral' },
  'COMMON MISTAKES': { icon: 'alert', label: 'Watch Out', tone: 'danger' },
  'PRACTICE SCENARIO': { icon: 'target', label: 'Your Assignment', tone: 'accent' },
};

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

  const lessonIndex = course.lessons.findIndex((l) => l.id === lesson.id);
  const { intro, sections } = parseDrillContent(lesson.content);

  return (
    <div style={s.wrap}>
      <button style={s.backButton} onClick={() => navigate(-1)}>← BACK TO DRILL LIBRARY</button>

      <section style={s.hero}>
        <div style={s.eyebrow}>{course.title} · Module {lessonIndex + 1} of {course.lessons.length}</div>
        <h2 style={s.title}>{lesson.title}</h2>
        {intro && <p style={s.tagline}>{intro}</p>}
      </section>

      <div style={s.modules}>
        {sections.map((section, i) => (
          <DrillModule key={section.heading} index={i} section={section} />
        ))}
      </div>

      <section style={s.section}>
        <SectionHeader>Practice This Drill</SectionHeader>
        <RoleplayPanel lessonId={lesson.id} />
      </section>
    </div>
  );
}

function DrillModule({ index, section }) {
  const meta = MODULE_META[section.heading] || { icon: 'book', label: section.heading, tone: 'neutral' };

  let body;
  if (section.heading === 'HOW TO RUN THIS DRILL') {
    body = (
      <ol style={s.stepList}>
        {parseNumberedSteps(section.body).map((step, i) => (
          <li key={i} style={s.stepItem}>{step}</li>
        ))}
      </ol>
    );
  } else if (section.heading === 'COMMON MISTAKES') {
    body = (
      <ul style={s.mistakeList}>
        {parseBulletList(section.body).map((item, i) => (
          <li key={i} style={s.mistakeItem}>{item}</li>
        ))}
      </ul>
    );
  } else if (section.heading === 'EXAMPLE') {
    body = (
      <div style={s.dialogue}>
        {parseDialogue(section.body).map((turn, i) => (
          <div key={i} style={s.dialogueRow(turn.speaker === 'Agent')}>
            {turn.speaker && <span style={s.dialogueSpeaker(turn.speaker === 'Agent')}>{turn.speaker}</span>}
            <span style={s.dialogueLine}>{turn.line}</span>
          </div>
        ))}
      </div>
    );
  } else {
    body = <p style={s.proseBody}>{section.body}</p>;
  }

  return (
    <Card style={s.moduleCard(meta.tone)}>
      <div style={s.moduleHeader}>
        <div style={s.moduleIcon(meta.tone)}>
          <Icon name={meta.icon} size={16} />
        </div>
        <div>
          <div style={s.moduleEyebrow}>Module {String(index + 1).padStart(2, '0')} · {meta.label}</div>
          <div style={s.moduleHeading}>{section.heading}</div>
        </div>
      </div>
      {body}
    </Card>
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
  hero: { marginBottom: 24, paddingBottom: 20, borderBottom: '1px solid var(--border-hairline)' },
  eyebrow: { color: 'var(--text-muted)', fontSize: 11, letterSpacing: 1, textTransform: 'uppercase', marginBottom: 4 },
  title: { color: 'var(--text-primary)', fontSize: 22, margin: 0 },
  tagline: { color: 'var(--text-secondary)', fontSize: 14, fontStyle: 'italic', marginTop: 8, marginBottom: 0 },
  modules: { display: 'flex', flexDirection: 'column', gap: 16, marginBottom: 28 },
  moduleCard: (tone) => ({
    borderLeft: `3px solid ${tone === 'danger' ? 'var(--danger)' : tone === 'accent' ? 'var(--accent)' : 'var(--border-strong)'}`,
  }),
  moduleHeader: { display: 'flex', alignItems: 'center', gap: 12, marginBottom: 14 },
  moduleIcon: (tone) => ({
    width: 32, height: 32, borderRadius: 8, flexShrink: 0,
    display: 'flex', alignItems: 'center', justifyContent: 'center',
    background: tone === 'danger' ? 'var(--danger-soft)' : tone === 'accent' ? 'var(--accent-soft, rgba(198,255,46,0.12))' : 'var(--bg-hover)',
    color: tone === 'danger' ? 'var(--danger)' : tone === 'accent' ? 'var(--accent)' : 'var(--text-secondary)',
  }),
  moduleEyebrow: { color: 'var(--text-muted)', fontSize: 10, letterSpacing: 1, textTransform: 'uppercase' },
  moduleHeading: { color: 'var(--text-primary)', fontSize: 15, fontWeight: 700 },
  proseBody: { color: 'var(--text-secondary)', fontSize: 14, lineHeight: 1.7, margin: 0 },
  stepList: { margin: 0, paddingLeft: 20, display: 'flex', flexDirection: 'column', gap: 10 },
  stepItem: { color: 'var(--text-secondary)', fontSize: 14, lineHeight: 1.6 },
  mistakeList: { margin: 0, paddingLeft: 20, display: 'flex', flexDirection: 'column', gap: 8 },
  mistakeItem: { color: 'var(--text-secondary)', fontSize: 14, lineHeight: 1.6 },
  dialogue: { display: 'flex', flexDirection: 'column', gap: 10 },
  dialogueRow: (isAgent) => ({ display: 'flex', flexDirection: 'column', alignItems: isAgent ? 'flex-start' : 'flex-end', gap: 2 }),
  dialogueSpeaker: (isAgent) => ({
    fontSize: 10, letterSpacing: 1, textTransform: 'uppercase',
    color: isAgent ? 'var(--accent)' : 'var(--text-muted)',
  }),
  dialogueLine: {
    fontSize: 14, lineHeight: 1.5, color: 'var(--text-primary)', maxWidth: '85%',
    background: 'var(--bg-hover)', border: '1px solid var(--border-hairline)', borderRadius: 10, padding: '8px 12px',
  },
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
