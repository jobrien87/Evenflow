import { useEffect, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { api } from '../lib/api';
import { useAuth } from '../lib/AuthContext';
import { basePathForRole } from '../layout/navConfig';
import { Card, Badge, SectionHeader, EmptyState } from '../ui';

// Every role's real drill catalog — the 75-drill training library,
// always fully browsable here regardless of whether anything has been
// formally "assigned" (that separate assignment/progress-tracking
// workflow still exists in Training, untouched — this is a second,
// open browse-and-practice surface layered on top of it).
export default function DrillLibraryPanel() {
  const { user } = useAuth();
  const navigate = useNavigate();
  const base = basePathForRole(user?.role);
  const [courses, setCourses] = useState([]);
  const [notEntitled, setNotEntitled] = useState(false);
  const [error, setError] = useState('');

  useEffect(() => {
    load();
  }, []);

  async function load() {
    setError('');
    try {
      const data = await api.trainingCourses();
      setCourses(data.courses);
      setNotEntitled(false);
    } catch (err) {
      if (err.data?.error === 'MODULE_NOT_ENTITLED') {
        setNotEntitled(true);
      } else {
        setError(err.data?.message || 'Could not load the drill library. Try refreshing.');
      }
    }
  }

  if (notEntitled) {
    return <div style={s.notEntitledBox}>Training isn't included on your agency's current plan.</div>;
  }

  const totalLessons = courses.reduce((sum, c) => sum + c.lessons.length, 0);

  return (
    <div style={s.wrap}>
      {error && (
        <div style={s.loadErrorBox}>
          {error}
          <button style={s.retryButton} onClick={load}>RETRY</button>
        </div>
      )}

      <section style={s.section}>
        <SectionHeader>Drill Library ({totalLessons} drills)</SectionHeader>
        <p style={s.intro}>
          Every sales drill in the training library, open for anyone to read and practice — click any
          drill to see its full breakdown and run a live AI roleplay of the scenario it covers.
        </p>
      </section>

      {courses.length === 0 && !error && (
        <EmptyState title="No drills yet" description="Nothing has been added to the drill library yet." />
      )}

      {courses.map((course) => (
        <section key={course.id} style={s.section}>
          <div style={s.categoryHeaderRow}>
            <h3 style={s.categoryTitle}>{course.title}</h3>
            <Badge tone="neutral">{course.lessons.length} drill{course.lessons.length === 1 ? '' : 's'}</Badge>
          </div>
          {course.description && <p style={s.categoryDesc}>{course.description}</p>}
          <Card style={s.listCard}>
            {course.lessons.map((lesson, i) => (
              <div
                key={lesson.id}
                style={s.lessonRow}
                className="ui-row-stack"
                onClick={() => navigate(`${base}/drills/${course.id}/${lesson.id}`)}
              >
                <span style={s.lessonIndex}>{i + 1}</span>
                <span style={s.lessonTitle}>{lesson.title}</span>
              </div>
            ))}
          </Card>
        </section>
      ))}
    </div>
  );
}

const s = {
  wrap: {},
  notEntitledBox: { background: 'var(--warning-soft)', border: '1px solid rgba(255, 184, 77, 0.4)', color: 'var(--warning)', padding: 20, borderRadius: 8, fontSize: 13 },
  loadErrorBox: { background: 'var(--danger-soft)', border: '1px solid rgba(255, 77, 94, 0.4)', color: 'var(--danger)', padding: 16, borderRadius: 8, fontSize: 13, display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 12, marginBottom: 16 },
  retryButton: { padding: '6px 12px', background: 'var(--accent)', border: 'none', borderRadius: 6, fontWeight: 700, cursor: 'pointer', fontSize: 11 },
  section: { marginBottom: 28 },
  intro: { color: 'var(--text-secondary)', fontSize: 13, lineHeight: 1.6, marginTop: 8 },
  categoryHeaderRow: { display: 'flex', alignItems: 'center', gap: 10, marginBottom: 4 },
  categoryTitle: { color: 'var(--text-primary)', fontSize: 16, fontWeight: 700, margin: 0 },
  categoryDesc: { color: 'var(--text-muted)', fontSize: 12, marginTop: 2, marginBottom: 12, lineHeight: 1.5 },
  listCard: { padding: 0, overflow: 'hidden' },
  lessonRow: { display: 'flex', alignItems: 'center', gap: 12, padding: '12px 16px', borderBottom: '1px solid var(--border-hairline)', cursor: 'pointer' },
  lessonIndex: { width: 24, height: 24, borderRadius: '50%', background: 'var(--bg-hover)', color: 'var(--text-secondary)', fontSize: 11, fontWeight: 700, display: 'flex', alignItems: 'center', justifyContent: 'center', flexShrink: 0 },
  lessonTitle: { color: 'var(--text-primary)', fontSize: 13, fontWeight: 600 },
};
