import { useEffect, useState } from 'react';
import { api } from '../lib/api';
import { useAuth } from '../lib/AuthContext';

export default function CoursesAdminPanel() {
  const { user } = useAuth();
  const [courses, setCourses] = useState([]);
  const [users, setUsers] = useState([]);
  const [teamAssignments, setTeamAssignments] = useState([]);
  const [showCourseForm, setShowCourseForm] = useState(false);
  const [courseForm, setCourseForm] = useState({ title: '', description: '', category: '' });
  const [lessonDrafts, setLessonDrafts] = useState({});
  const [assignForm, setAssignForm] = useState({ courseId: '', userId: '' });
  const [status, setStatus] = useState('');

  const isPlatformOwner = user.role === 'PLATFORM_OWNER';

  useEffect(() => {
    load();
  }, []);

  async function load() {
    const promises = [api.trainingCourses(), api.teamTrainingAssignments()];
    if (!isPlatformOwner) promises.push(api.users(''));
    const results = await Promise.all(promises);
    setCourses(results[0].courses);
    setTeamAssignments(results[1].assignments);
    if (!isPlatformOwner) setUsers(results[2].users.filter((u) => u.role === 'PRODUCER'));
  }

  async function createCourse(e) {
    e.preventDefault();
    try {
      await api.createTrainingCourse(courseForm);
      setCourseForm({ title: '', description: '', category: '' });
      setShowCourseForm(false);
      await load();
    } catch (err) {
      alert(err.data?.message || 'Failed to create course.');
    }
  }

  function updateDraft(courseId, field, value) {
    setLessonDrafts((prev) => ({
      ...prev,
      [courseId]: { title: '', content: '', quiz: [], ...prev[courseId], [field]: value },
    }));
  }

  function addQuizQuestion(courseId) {
    const draft = lessonDrafts[courseId] || { title: '', content: '', quiz: [] };
    updateDraft(courseId, 'quiz', [...(draft.quiz || []), { question: '', options: ['', ''], correctIndex: 0 }]);
  }

  function updateQuizQuestion(courseId, qi, field, value) {
    const draft = lessonDrafts[courseId];
    const quiz = [...draft.quiz];
    quiz[qi] = { ...quiz[qi], [field]: value };
    updateDraft(courseId, 'quiz', quiz);
  }

  async function submitLesson(courseId) {
    const draft = lessonDrafts[courseId];
    if (!draft || !draft.title || !draft.content) return;
    try {
      await api.addTrainingLesson(courseId, {
        title: draft.title,
        content: draft.content,
        quiz: draft.quiz && draft.quiz.length > 0 ? draft.quiz : undefined,
      });
      setLessonDrafts((prev) => ({ ...prev, [courseId]: { title: '', content: '', quiz: [] } }));
      await load();
    } catch (err) {
      alert(err.data?.message || 'Failed to add lesson.');
    }
  }

  async function assign(e) {
    e.preventDefault();
    setStatus('Assigning…');
    try {
      await api.assignTraining(assignForm);
      setStatus('Assigned.');
      setAssignForm({ courseId: '', userId: '' });
      await load();
    } catch (err) {
      setStatus(err.data?.message || 'Failed to assign.');
    }
  }

  return (
    <div style={s.wrap}>
      {isPlatformOwner && (
        <section style={s.section}>
          <div style={s.headerRow}>
            <h3 style={s.h3}>COURSES ({courses.length})</h3>
            <button style={s.smallButton} onClick={() => setShowCourseForm(!showCourseForm)}>+ NEW COURSE</button>
          </div>
          {showCourseForm && (
            <form onSubmit={createCourse} style={s.form}>
              <input style={s.input} placeholder="Course title" value={courseForm.title} onChange={(e) => setCourseForm({ ...courseForm, title: e.target.value })} required />
              <textarea style={{ ...s.input, minHeight: 60 }} placeholder="Description" value={courseForm.description} onChange={(e) => setCourseForm({ ...courseForm, description: e.target.value })} />
              <input style={s.input} placeholder="Category (matches call scoring dimensions, e.g. Objection Handling)" value={courseForm.category} onChange={(e) => setCourseForm({ ...courseForm, category: e.target.value })} />
              <button style={s.submitButton} type="submit">Create Course</button>
            </form>
          )}

          {courses.map((c) => {
            const draft = lessonDrafts[c.id] || { title: '', content: '', quiz: [] };
            return (
              <div key={c.id} style={s.courseCard}>
                <div style={s.headerRow}>
                  <div style={s.courseTitle}>{c.title} {c.category && <span style={s.categoryTag}>{c.category}</span>}</div>
                  <button style={s.smallButtonOutline} onClick={async () => { await api.updateTrainingCourse(c.id, { isActive: false }); await load(); }}>
                    DEACTIVATE
                  </button>
                </div>
                <div style={s.lessonCount}>{c.lessons.length} lesson{c.lessons.length === 1 ? '' : 's'}</div>
                {c.lessons.map((l) => <div key={l.id} style={s.lessonChip}>{l.title}{l.quiz && ' (quiz)'}</div>)}

                <div style={s.lessonForm}>
                  <input style={s.input} placeholder="New lesson title" value={draft.title} onChange={(e) => updateDraft(c.id, 'title', e.target.value)} />
                  <textarea style={{ ...s.input, minHeight: 60 }} placeholder="Lesson content" value={draft.content} onChange={(e) => updateDraft(c.id, 'content', e.target.value)} />

                  {(draft.quiz || []).map((q, qi) => (
                    <div key={qi} style={s.quizDraft}>
                      <input style={s.input} placeholder={`Question ${qi + 1}`} value={q.question} onChange={(e) => updateQuizQuestion(c.id, qi, 'question', e.target.value)} />
                      {q.options.map((opt, oi) => (
                        <div key={oi} style={s.optionRow}>
                          <input type="radio" checked={q.correctIndex === oi} onChange={() => updateQuizQuestion(c.id, qi, 'correctIndex', oi)} />
                          <input
                            style={s.optionInput}
                            placeholder={`Option ${oi + 1}`}
                            value={opt}
                            onChange={(e) => {
                              const options = [...q.options];
                              options[oi] = e.target.value;
                              updateQuizQuestion(c.id, qi, 'options', options);
                            }}
                          />
                        </div>
                      ))}
                    </div>
                  ))}
                  <button type="button" style={s.smallButtonOutline} onClick={() => addQuizQuestion(c.id)}>+ ADD QUIZ QUESTION</button>
                  <button type="button" style={s.submitButton} onClick={() => submitLesson(c.id)}>ADD LESSON</button>
                </div>
              </div>
            );
          })}
        </section>
      )}

      <section style={s.section}>
        <h3 style={s.h3}>ASSIGN TRAINING</h3>
        <form onSubmit={assign} style={s.assignForm}>
          <select style={s.input} value={assignForm.courseId} onChange={(e) => setAssignForm({ ...assignForm, courseId: e.target.value })} required>
            <option value="">Select course…</option>
            {courses.map((c) => <option key={c.id} value={c.id}>{c.title}</option>)}
          </select>
          {!isPlatformOwner && (
            <select style={s.input} value={assignForm.userId} onChange={(e) => setAssignForm({ ...assignForm, userId: e.target.value })} required>
              <option value="">Select producer…</option>
              {users.map((u) => <option key={u.id} value={u.id}>{u.firstName} {u.lastName}</option>)}
            </select>
          )}
          <button style={s.submitButton} type="submit">Assign</button>
          {status && <div style={s.status}>{status}</div>}
        </form>
      </section>

      <section style={s.section}>
        <h3 style={s.h3}>TEAM PROGRESS ({teamAssignments.length})</h3>
        {teamAssignments.map((a) => (
          <div key={a.id} style={s.row}>
            <div>
              <div style={s.rowTitle}>{a.user ? `${a.user.firstName} ${a.user.lastName}` : 'Unknown'} — {a.course.title}</div>
              <div style={s.rowSub}>{a.progress.completed}/{a.progress.total} lessons</div>
            </div>
            <div style={s.badge(a.status)}>{a.status.replace('_', ' ')}</div>
          </div>
        ))}
        {teamAssignments.length === 0 && <div style={s.empty}>No assignments yet.</div>}
      </section>
    </div>
  );
}

const s = {
  wrap: {},
  section: { marginBottom: 28 },
  headerRow: { display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 12 },
  h3: { color: '#888', fontSize: 12, letterSpacing: 2 },
  smallButton: { padding: '8px 14px', background: '#00e5ff', border: 'none', borderRadius: 6, fontWeight: 700, cursor: 'pointer', fontSize: 12 },
  smallButtonOutline: { padding: '6px 12px', background: 'transparent', border: '1px solid #333', color: '#aaa', borderRadius: 6, cursor: 'pointer', fontSize: 11, marginRight: 8 },
  form: { display: 'flex', flexDirection: 'column', gap: 10, background: '#111', padding: 16, borderRadius: 8, marginBottom: 12, border: '1px solid #222' },
  input: { padding: '10px 12px', background: '#000', border: '1px solid #333', borderRadius: 6, color: '#fff', width: '100%', boxSizing: 'border-box' },
  submitButton: { padding: '10px 16px', background: '#00e5ff', border: 'none', borderRadius: 6, fontWeight: 700, cursor: 'pointer' },
  status: { color: '#00e5ff', fontSize: 12 },
  courseCard: { background: '#111', border: '1px solid #222', borderRadius: 8, padding: 16, marginBottom: 12 },
  courseTitle: { color: '#fff', fontWeight: 700, fontSize: 15 },
  categoryTag: { fontSize: 10, color: '#00e5ff', border: '1px solid #00e5ff44', padding: '2px 6px', borderRadius: 4, marginLeft: 8 },
  lessonCount: { color: '#666', fontSize: 12, marginTop: 4, marginBottom: 8 },
  lessonChip: { color: '#aaa', fontSize: 12, padding: '4px 0' },
  lessonForm: { marginTop: 12, paddingTop: 12, borderTop: '1px solid #1a1a1a', display: 'flex', flexDirection: 'column', gap: 8 },
  quizDraft: { background: '#0d0d0d', border: '1px solid #1a1a1a', borderRadius: 6, padding: 10, display: 'flex', flexDirection: 'column', gap: 6 },
  optionRow: { display: 'flex', alignItems: 'center', gap: 8 },
  optionInput: { flex: 1, padding: '6px 10px', background: '#000', border: '1px solid #333', borderRadius: 6, color: '#fff', fontSize: 12 },
  assignForm: { display: 'flex', flexDirection: 'column', gap: 10, background: '#111', padding: 16, borderRadius: 8, border: '1px solid #222' },
  row: { display: 'flex', justifyContent: 'space-between', alignItems: 'center', background: '#111', border: '1px solid #1a1a1a', borderRadius: 8, padding: 14, marginBottom: 8 },
  rowTitle: { fontWeight: 600, fontSize: 14, color: '#fff' },
  rowSub: { color: '#666', fontSize: 12 },
  badge: (status) => ({
    fontSize: 11, padding: '4px 8px', borderRadius: 4,
    color: status === 'COMPLETED' ? '#00e5ff' : status === 'IN_PROGRESS' ? '#ffb84d' : '#888',
    border: `1px solid ${status === 'COMPLETED' ? '#00e5ff44' : status === 'IN_PROGRESS' ? '#ffb84d44' : '#333'}`,
  }),
  empty: { color: '#666', fontStyle: 'italic', fontSize: 13 },
};
