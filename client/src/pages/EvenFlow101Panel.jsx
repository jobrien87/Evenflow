import { useNavigate } from 'react-router-dom';
import { useAuth } from '../lib/AuthContext';
import { basePathForRole } from '../layout/navConfig';
import { Card, Badge, SectionHeader, Icon } from '../ui';
import { EVENFLOW_101_CATEGORIES } from '../lib/evenflow101Content';

// Static reference guide for Agency Owners/Managers — every real feature
// and setting in the app, how to configure it, and what it actually does.
// Content lives entirely in evenflow101Content.js (no API call, no
// loading state) and is laid out like the Drill Library (category
// sections of clickable topic rows) without any of Drill's quiz/
// progress-tracking data model — this is pure static reading material.
export default function EvenFlow101Panel() {
  const { user } = useAuth();
  const navigate = useNavigate();
  const base = basePathForRole(user?.role);
  const totalTopics = EVENFLOW_101_CATEGORIES.reduce((sum, c) => sum + c.topics.length, 0);

  return (
    <div style={s.wrap}>
      <section style={s.section}>
        <SectionHeader>EvenFlow 101 ({totalTopics} topics)</SectionHeader>
        <p style={s.intro}>
          A full walkthrough of what every real feature and setting in EvenFlow does and how to configure it —
          from Lead Flow automation to Back Catalog to Vendors, Offices, Goals, and everything in between. Click
          any topic for the full breakdown: what it is, how to set it up, a real example, and what to watch
          out for.
        </p>
      </section>

      {EVENFLOW_101_CATEGORIES.map((category) => (
        <section key={category.id} style={s.section}>
          <div style={s.categoryHeaderRow}>
            <div style={s.categoryIcon}>
              <Icon name={category.icon} size={16} />
            </div>
            <h3 style={s.categoryTitle}>{category.title}</h3>
            <Badge tone="neutral">{category.topics.length} topic{category.topics.length === 1 ? '' : 's'}</Badge>
          </div>
          {category.description && <p style={s.categoryDesc}>{category.description}</p>}
          <Card style={s.listCard}>
            {category.topics.map((topic) => (
              <div
                key={topic.id}
                style={s.topicRow}
                className="ui-row-stack"
                onClick={() => navigate(`${base}/evenflow-101/${topic.id}`)}
              >
                <div style={s.topicIcon}>
                  <Icon name={topic.icon} size={15} />
                </div>
                <div style={s.topicText}>
                  <div style={s.topicTitle}>{topic.title}</div>
                  {topic.summary && <div style={s.topicSummary}>{topic.summary}</div>}
                </div>
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
  section: { marginBottom: 28 },
  intro: { color: 'var(--text-secondary)', fontSize: 13, lineHeight: 1.6, marginTop: 8 },
  categoryHeaderRow: { display: 'flex', alignItems: 'center', gap: 10, marginBottom: 4 },
  categoryIcon: {
    width: 28, height: 28, borderRadius: 8, flexShrink: 0,
    display: 'flex', alignItems: 'center', justifyContent: 'center',
    background: 'var(--bg-hover)', color: 'var(--text-secondary)',
  },
  categoryTitle: { color: 'var(--text-primary)', fontSize: 16, fontWeight: 700, margin: 0, flex: 1 },
  categoryDesc: { color: 'var(--text-muted)', fontSize: 12, marginTop: 2, marginBottom: 12, lineHeight: 1.5 },
  listCard: { padding: 0, overflow: 'hidden' },
  topicRow: { display: 'flex', alignItems: 'center', gap: 12, padding: '12px 16px', borderBottom: '1px solid var(--border-hairline)', cursor: 'pointer' },
  topicIcon: {
    width: 28, height: 28, borderRadius: 8, flexShrink: 0,
    display: 'flex', alignItems: 'center', justifyContent: 'center',
    background: 'var(--bg-hover)', color: 'var(--text-secondary)',
  },
  topicText: { minWidth: 0 },
  topicTitle: { color: 'var(--text-primary)', fontSize: 13, fontWeight: 600 },
  topicSummary: { color: 'var(--text-muted)', fontSize: 12, marginTop: 2, lineHeight: 1.4 },
};
