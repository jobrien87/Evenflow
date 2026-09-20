import { useEffect, useRef, useState } from 'react';
import { useSearchParams } from 'react-router-dom';
import { api } from '../lib/api';

export default function TrainingPanel() {
  const [assignments, setAssignments] = useState([]);
  const [recommended, setRecommended] = useState(null);
  const [notEntitled, setNotEntitled] = useState(false);
  const [openCourse, setOpenCourse] = useState(null);
  const [searchParams] = useSearchParams();
  const highlightId = searchParams.get('highlight');
  const handledHighlightRef = useRef(false);

  useEffect(() => {
    load();
  }, []);

  // Destination side of notification deep-linking — a training-assignment
  // notification opens straight into that course instead of leaving the
  // person to find it in the list themselves.
  useEffect(() => {
    if (!highlightId || handledHighlightRef.current || assignments.length === 0) return;
    const match = assignments.find((a) => a.id === highlightId);
    if (!match) return;
    handledHighlightRef.current = true;
    setOpenCourse(match);
  }, [highlightId, assignments]);

  async function load() {
    try {
      const [assignData, recData] = await Promise.all([api.myTrainingAssignments(), api.recommendedTraining()]);
      setAssignments(assignData.assignments);
      setRecommended(recData);
      setNotEntitled(false);
    } catch (err) {
      if (err.data?.error === 'MODULE_NOT_ENTITLED') setNotEntitled(true);
    }
  }

  if (notEntitled) {
    return <div style={s.notEntitledBox}>Training isn't included on your agency's current plan.</div>;
  }

  if (openCourse) {
    return <CourseViewer assignment={openCourse} onBack={() => { setOpenCourse(null); load(); }} />;
  }

  return (
    <div style={s.wrap}>
      {recommended && recommended.recommended && (
        <section style={s.section}>
          <h3 style={s.h3}>RECOMMENDED FOR YOU</h3>
          <div style={s.recCard}>
            <div style={s.recTitle}>{recommended.recommended.title}</div>
            <div style={s.recReason}>{recommended.reason}</div>
          </div>
        </section>
      )}
      {recommended && !recommended.recommended && recommended.reason && (
        <div style={s.recEmptyNote}>{recommended.reason}</div>
      )}

      <section style={s.section}>
        <h3 style={s.h3}>MY TRAINING ({assignments.length})</h3>
        {assignments.map((a) => (
          <div key={a.id} style={s.row} className="ui-row-stack" onClick={() => setOpenCourse(a)}>
            <div>
              <div style={s.rowTitle}>{a.course.title}</div>
              <div style={s.rowSub}>{a.progress.completed}/{a.progress.total} lessons complete{a.dueAt ? ` · due ${new Date(a.dueAt).toLocaleDateString()}` : ''}</div>
            </div>
            <div style={s.statusBadge(a.status)}>{a.status.replace('_', ' ')}</div>
          </div>
        ))}
        {assignments.length === 0 && <div style={s.empty}>No training assigned yet.</div>}
      </section>
    </div>
  );
}

function CourseViewer({ assignment, onBack }) {
  const [activeLesson, setActiveLesson] = useState(null);
  const [answers, setAnswers] = useState({});
  const [result, setResult] = useState(null);
  const [completedIds, setCompletedIds] = useState(new Set(assignment.lessonCompletions.map((c) => c.lessonId)));

  async function submitLesson(lesson) {
    const quizAnswers = lesson.quiz ? lesson.quiz.map((_, i) => answers[i] ?? -1) : undefined;
    const res = await api.completeLesson(lesson.id, { assignmentId: assignment.id, answers: quizAnswers });
    setResult(res.grading);
    setCompletedIds((prev) => new Set(prev).add(lesson.id));
    setAnswers({});
  }

  return (
    <div style={s.wrap}>
      <button style={s.backButton} onClick={onBack}>← BACK TO TRAINING</button>
      <h3 style={s.courseTitle}>{assignment.course.title}</h3>
      <p style={s.courseDescription}>{assignment.course.description}</p>

      {!activeLesson ? (
        <div>
          {assignment.course.lessons.map((lesson, i) => (
            <div key={lesson.id} style={s.lessonRow} onClick={() => { setActiveLesson(lesson); setResult(null); }}>
              <span style={s.lessonCheck(completedIds.has(lesson.id))}>{completedIds.has(lesson.id) ? '✓' : i + 1}</span>
              <span style={s.lessonTitle}>{lesson.title}</span>
              {lesson.quiz && <span style={s.quizTag}>QUIZ</span>}
            </div>
          ))}
        </div>
      ) : (
        <div style={s.lessonView}>
          <button style={s.backButton} onClick={() => { setActiveLesson(null); setResult(null); }}>← LESSONS</button>
          <h4 style={s.lessonHeading}>{activeLesson.title}</h4>
          <div style={s.lessonContent}>{activeLesson.content}</div>

          {activeLesson.quiz && !result && (
            <div style={s.quizBlock}>
              {activeLesson.quiz.map((q, qi) => (
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
              <button style={s.submitButton} onClick={() => submitLesson(activeLesson)}>SUBMIT QUIZ</button>
            </div>
          )}

          {!activeLesson.quiz && !completedIds.has(activeLesson.id) && (
            <button style={s.submitButton} onClick={() => submitLesson(activeLesson)}>MARK COMPLETE</button>
          )}

          {result && (
            <div style={s.resultBox}>
              {result.scorePercent !== null ? (
                <>Quiz score: <strong>{result.scorePercent}%</strong> ({result.correctCount}/{result.total} correct)</>
              ) : (
                'Marked complete.'
              )}
            </div>
          )}
        </div>
      )}
    </div>
  );
}

const s = {
  wrap: {},
  notEntitledBox: { background: 'var(--warning-soft)', border: '1px solid rgba(255, 184, 77, 0.4)', color: 'var(--warning)', padding: 20, borderRadius: 8, fontSize: 13 },
  section: { marginBottom: 28 },
  h3: { color: 'var(--text-secondary)', fontSize: 12, letterSpacing: 2, marginBottom: 12 },
  recCard: { background: 'var(--accent-gradient-soft)', border: '1px solid var(--border-accent)', borderRadius: 8, padding: 16 },
  recTitle: { fontWeight: 700, fontSize: 15, color: 'var(--accent)' },
  recReason: { color: 'var(--text-secondary)', fontSize: 12, marginTop: 6 },
  recEmptyNote: { color: 'var(--text-muted)', fontSize: 12, fontStyle: 'italic', marginBottom: 20 },
  row: { display: 'flex', justifyContent: 'space-between', alignItems: 'center', background: 'var(--bg-elevated)', border: '1px solid var(--border-hairline)', borderRadius: 8, padding: 14, marginBottom: 8, cursor: 'pointer' },
  rowTitle: { fontWeight: 600, fontSize: 14, color: 'var(--text-primary)' },
  rowSub: { color: 'var(--text-muted)', fontSize: 12 },
  statusBadge: (status) => ({
    fontSize: 11, padding: '4px 8px', borderRadius: 4,
    color: status === 'COMPLETED' ? 'var(--accent)' : status === 'IN_PROGRESS' ? 'var(--warning)' : 'var(--text-secondary)',
    border: `1px solid ${status === 'COMPLETED' ? 'var(--border-accent)' : status === 'IN_PROGRESS' ? 'rgba(255, 184, 77, 0.4)' : 'var(--border-strong)'}`,
  }),
  empty: { color: 'var(--text-muted)', fontStyle: 'italic', fontSize: 13 },
  backButton: { background: 'none', border: 'none', color: 'var(--text-secondary)', fontSize: 12, cursor: 'pointer', marginBottom: 12, padding: 0 },
  courseTitle: { color: 'var(--text-primary)', fontSize: 20, marginBottom: 4 },
  courseDescription: { color: 'var(--text-secondary)', fontSize: 13, marginBottom: 20 },
  lessonRow: { display: 'flex', alignItems: 'center', gap: 12, background: 'var(--bg-elevated)', border: '1px solid var(--border-hairline)', borderRadius: 8, padding: 14, marginBottom: 8, cursor: 'pointer' },
  lessonCheck: (done) => ({
    width: 26, height: 26, borderRadius: '50%', display: 'flex', alignItems: 'center', justifyContent: 'center', fontSize: 12, fontWeight: 700,
    background: done ? 'var(--accent-gradient-soft)' : 'var(--bg-hover)', color: done ? 'var(--accent)' : 'var(--text-secondary)',
  }),
  lessonTitle: { color: 'var(--text-primary)', fontSize: 14, flex: 1 },
  quizTag: { fontSize: 10, color: 'var(--warning)', border: '1px solid rgba(255, 184, 77, 0.4)', padding: '2px 6px', borderRadius: 4 },
  lessonView: {},
  lessonHeading: { color: 'var(--text-primary)', fontSize: 18, marginBottom: 12 },
  lessonContent: { color: 'var(--text-secondary)', fontSize: 14, lineHeight: 1.7, marginBottom: 20, whiteSpace: 'pre-wrap' },
  quizBlock: { background: 'var(--bg-sunken)', border: '1px solid var(--border-hairline)', borderRadius: 8, padding: 16 },
  quizQuestion: { marginBottom: 16 },
  quizQuestionText: { color: 'var(--text-primary)', fontSize: 14, fontWeight: 600, marginBottom: 8 },
  quizOption: { display: 'flex', alignItems: 'center', gap: 8, color: 'var(--text-secondary)', fontSize: 13, marginBottom: 6, cursor: 'pointer' },
  submitButton: { padding: '10px 18px', background: 'var(--accent)', border: 'none', borderRadius: 6, fontWeight: 700, cursor: 'pointer' },
  resultBox: { background: 'var(--accent-gradient-soft)', border: '1px solid var(--border-accent)', color: 'var(--accent)', padding: 14, borderRadius: 8, marginTop: 16, fontSize: 14 },
};
