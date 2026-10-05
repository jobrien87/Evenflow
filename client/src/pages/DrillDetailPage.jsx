import { useEffect, useRef, useState } from 'react';
import { useNavigate, useParams } from 'react-router-dom';
import { api } from '../lib/api';
import { useAuth } from '../lib/AuthContext';
import { Card, Button, SectionHeader, Icon, MicButton } from '../ui';
import { parseDrillContent, parseNumberedSteps, parseBulletList, parseDialogue } from '../lib/drillContent';
import { useTextToSpeech } from '../lib/useTextToSpeech';

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
  const { user } = useAuth();
  const [course, setCourse] = useState(null);
  const [lesson, setLesson] = useState(null);
  const [error, setError] = useState('');
  // Resolved only for Producers — completeLesson() requires a real
  // TrainingAssignment for this exact course, so a drill that was never
  // formally assigned shows no completion UI at all (pure read+roleplay,
  // same as before this existed).
  const [assignment, setAssignment] = useState(null);

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
    if (user?.role === 'PRODUCER') {
      try {
        const data = await api.myTrainingAssignments();
        setAssignment(data.assignments.find((a) => a.courseId === courseId) || null);
      } catch {
        // No assignment surface to show if this fails — the page still
        // works fine as a pure read+roleplay drill.
      }
    }
  }

  async function refreshAssignment() {
    const data = await api.myTrainingAssignments();
    setAssignment(data.assignments.find((a) => a.courseId === courseId) || null);
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

      {assignment && (
        <section style={s.section}>
          <SectionHeader>Your Assignment</SectionHeader>
          <CompletionBlock assignment={assignment} lesson={lesson} onCompleted={refreshAssignment} />
        </section>
      )}

      <section style={s.section}>
        <SectionHeader>Practice This Drill</SectionHeader>
        <RoleplayPanel lessonId={lesson.id} />
      </section>
    </div>
  );
}

// This course has been formally assigned to the current Producer —
// moved here from the retired standalone Training tab's CourseViewer,
// so completing a quiz/lesson is still possible from the one place a
// Producer now actually reads the drill. Calls the exact same
// completeLesson() endpoint, so TrainingAssignment status/progress (and
// the "Sales Courses" stat boxes on TP Sales Process) stay real and live.
function CompletionBlock({ assignment, lesson, onCompleted }) {
  const alreadyDone = assignment.lessonCompletions.some((c) => c.lessonId === lesson.id);
  const [answers, setAnswers] = useState({});
  const [result, setResult] = useState(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');

  async function submit() {
    setBusy(true);
    setError('');
    try {
      const quizAnswers = lesson.quiz ? lesson.quiz.map((_, i) => answers[i] ?? -1) : undefined;
      const res = await api.completeLesson(lesson.id, { assignmentId: assignment.id, answers: quizAnswers });
      setResult(res.grading);
      await onCompleted();
    } catch (err) {
      setError(err.data?.message || 'Could not mark this complete.');
    } finally {
      setBusy(false);
    }
  }

  if (alreadyDone && !result) {
    return <Card style={s.completionCard}><div style={s.completionDone}>✓ Marked complete — part of "{assignment.course.title}"</div></Card>;
  }

  return (
    <Card style={s.completionCard}>
      <div style={s.completionIntro}>This drill is part of your assigned course, "{assignment.course.title}."</div>
      {lesson.quiz && !result && (
        <div style={s.quizBlock}>
          {lesson.quiz.map((q, qi) => (
            <div key={qi} style={s.quizQuestion}>
              <div style={s.quizQuestionText}>{q.question}</div>
              {q.options.map((opt, oi) => (
                <label key={oi} style={s.quizOption}>
                  <input type="radio" name={`q${qi}`} checked={answers[qi] === oi} onChange={() => setAnswers({ ...answers, [qi]: oi })} />
                  {opt}
                </label>
              ))}
            </div>
          ))}
        </div>
      )}
      {error && <div style={s.error}>{error}</div>}
      {!result && (
        <Button variant="primary" disabled={busy} onClick={submit}>
          {busy ? 'SUBMITTING…' : lesson.quiz ? 'SUBMIT QUIZ' : 'MARK COMPLETE'}
        </Button>
      )}
      {result && (
        <div style={s.completionDone}>
          {result.scorePercent !== null ? <>Quiz score: <strong>{result.scorePercent}%</strong> ({result.correctCount}/{result.total} correct)</> : 'Marked complete.'}
        </div>
      )}
    </Card>
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

const AUTO_SPEAK_KEY = 'roleplay_auto_speak';

function RoleplayPanel({ lessonId }) {
  const [messages, setMessages] = useState([]);
  const [started, setStarted] = useState(false);
  const [draft, setDraft] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [degraded, setDegraded] = useState(false);
  const [showVoicePicker, setShowVoicePicker] = useState(false);
  const [autoSpeak, setAutoSpeak] = useState(() => {
    try {
      return localStorage.getItem(AUTO_SPEAK_KEY) !== 'off';
    } catch {
      return true;
    }
  });
  const bottomRef = useRef(null);
  const spokenCountRef = useRef(0);
  const tts = useTextToSpeech();

  useEffect(() => {
    bottomRef.current?.scrollIntoView({ block: 'end' });
  }, [messages]);

  // Auto-speak the newest ED reply as it arrives — never replays older
  // turns, and never speaks while a message is still loading.
  useEffect(() => {
    if (!autoSpeak || busy) return;
    if (messages.length <= spokenCountRef.current) return;
    const latest = messages[messages.length - 1];
    spokenCountRef.current = messages.length;
    if (latest.role === 'assistant') tts.speak(latest.content);
  }, [messages, busy, autoSpeak]);

  function toggleAutoSpeak() {
    setAutoSpeak((v) => {
      const next = !v;
      try {
        localStorage.setItem(AUTO_SPEAK_KEY, next ? 'on' : 'off');
      } catch {
        // per-viewer convenience only
      }
      if (!next) tts.stop();
      return next;
    });
  }

  async function startRoleplay() {
    setStarted(true);
    setBusy(true);
    setError('');
    try {
      const res = await api.roleplayMessage(lessonId, []);
      if (!res.available) setDegraded(true);
      setMessages([{ role: 'assistant', content: res.message }]);
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
          the AI figures out which one you're doing and takes the other role. Talk or type your lines,
          and hear ED's replies read back in the voice you pick.
        </p>
        <Button variant="primary" onClick={startRoleplay}>START ROLEPLAY</Button>
      </Card>
    );
  }

  return (
    <Card style={s.roleplayCard}>
      <div style={s.roleplayHeader}>
        {degraded && <div style={s.degradedNote}>AI roleplay isn't fully configured on this environment right now.</div>}
        {tts.isSupported && (
          <div style={s.roleplayControls}>
            <button
              type="button"
              style={s.voiceToggle(autoSpeak)}
              onClick={toggleAutoSpeak}
              title={autoSpeak ? 'Turn off spoken replies' : 'Turn on spoken replies'}
            >
              <Icon name="speaker" size={13} /> {autoSpeak ? 'VOICE ON' : 'VOICE OFF'}
            </button>
            <button
              type="button"
              style={s.gearButton}
              onClick={() => setShowVoicePicker((v) => !v)}
              title="Choose a voice"
              aria-label="Choose a voice"
            >
              <Icon name="gear" size={13} />
            </button>
            {showVoicePicker && (
              <select
                style={s.voiceSelect}
                value={tts.voiceURI}
                onChange={(e) => tts.selectVoice(e.target.value)}
              >
                <option value="">Default voice</option>
                {tts.voices.map((v) => (
                  <option key={v.voiceURI} value={v.voiceURI}>{v.name}</option>
                ))}
              </select>
            )}
          </div>
        )}
      </div>
      <div style={s.thread}>
        {messages.map((m, i) => (
          <div key={i} style={s.bubbleRow(m.role === 'user')}>
            <div style={s.bubble(m.role === 'user')}>{m.content}</div>
            {m.role === 'assistant' && tts.isSupported && (
              <button type="button" style={s.replayButton} onClick={() => tts.speak(m.content)} title="Play this line">
                <Icon name="speaker" size={12} />
              </button>
            )}
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
        <MicButton onTranscript={(text) => setDraft((d) => (d ? `${d} ${text}` : text))} />
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
  completionCard: {},
  completionIntro: { color: 'var(--text-secondary)', fontSize: 13, marginBottom: 14 },
  completionDone: { color: 'var(--accent)', fontSize: 14, fontWeight: 600 },
  quizBlock: { background: 'var(--bg-sunken)', border: '1px solid var(--border-hairline)', borderRadius: 8, padding: 16, marginBottom: 14 },
  quizQuestion: { marginBottom: 16 },
  quizQuestionText: { color: 'var(--text-primary)', fontSize: 14, fontWeight: 600, marginBottom: 8 },
  quizOption: { display: 'flex', alignItems: 'center', gap: 8, color: 'var(--text-secondary)', fontSize: 13, marginBottom: 6, cursor: 'pointer' },
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
  roleplayHeader: { display: 'flex', alignItems: 'center', justifyContent: 'flex-end', gap: 8, marginBottom: 8, position: 'relative' },
  roleplayControls: { display: 'flex', alignItems: 'center', gap: 6, position: 'relative' },
  voiceToggle: (on) => ({
    display: 'flex', alignItems: 'center', gap: 4, fontSize: 10, letterSpacing: 0.5, padding: '4px 8px', borderRadius: 20, cursor: 'pointer',
    border: on ? 'none' : '1px solid var(--border-strong)',
    background: on ? 'var(--accent-gradient)' : 'transparent',
    color: on ? 'var(--accent-on)' : 'var(--text-secondary)', fontWeight: 700,
  }),
  gearButton: { background: 'none', border: 'none', color: 'var(--text-muted)', cursor: 'pointer', display: 'flex', alignItems: 'center', justifyContent: 'center', padding: 4, borderRadius: 6 },
  voiceSelect: {
    position: 'absolute', top: 30, right: 0, zIndex: 1, width: 200,
    padding: '6px 8px', background: 'var(--bg-elevated)', border: '1px solid var(--border-hairline)', borderRadius: 8,
    color: 'var(--text-primary)', fontSize: 12,
  },
  thread: { flex: 1, overflowY: 'auto', display: 'flex', flexDirection: 'column', gap: 8, marginBottom: 12 },
  bubbleRow: (mine) => ({ display: 'flex', alignItems: 'center', gap: 6, justifyContent: mine ? 'flex-end' : 'flex-start' }),
  bubble: (mine) => ({
    maxWidth: '80%', padding: '8px 12px', borderRadius: 10, fontSize: 13,
    background: mine ? 'var(--accent)' : 'var(--bg-hover)', color: mine ? 'var(--accent-on)' : 'var(--text-primary)',
    border: mine ? 'none' : '1px solid var(--border-strong)',
  }),
  replayButton: {
    flexShrink: 0, width: 22, height: 22, borderRadius: '50%', border: 'none', cursor: 'pointer',
    background: 'var(--bg-hover)', color: 'var(--text-muted)', display: 'flex', alignItems: 'center', justifyContent: 'center',
  },
  thinking: { color: 'var(--text-muted)', fontSize: 13, fontStyle: 'italic' },
  degradedNote: { color: 'var(--warning)', fontSize: 12 },
  error: { color: 'var(--danger)', fontSize: 12, marginBottom: 8 },
  inputRow: { display: 'flex', gap: 8 },
  input: { flex: 1, padding: '10px 12px', background: 'var(--bg-sunken)', border: '1px solid var(--border-strong)', borderRadius: 6, color: 'var(--text-primary)', fontSize: 13 },
};
