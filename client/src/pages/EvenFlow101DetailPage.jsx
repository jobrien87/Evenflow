import { useParams, useNavigate } from 'react-router-dom';
import { useAuth } from '../lib/AuthContext';
import { basePathForRole } from '../layout/navConfig';
import { Card, SectionHeader, Icon } from '../ui';
import { EVENFLOW_101_CATEGORIES } from '../lib/evenflow101Content';

// Detail page for one EvenFlow 101 topic — mirrors DrillDetailPage.jsx's
// hero + module-card structure, but reads tone/icon/label straight off
// the static content data instead of a heading-keyed lookup table, and
// has none of Drill's quiz/completion/AI-roleplay machinery — this is
// pure static reference content, read-only.
export default function EvenFlow101DetailPage() {
  const { topicId } = useParams();
  const navigate = useNavigate();
  const { user } = useAuth();
  const base = basePathForRole(user?.role);

  let category = null;
  let topic = null;
  let topicIndex = -1;
  for (const c of EVENFLOW_101_CATEGORIES) {
    const i = c.topics.findIndex((t) => t.id === topicId);
    if (i !== -1) {
      category = c;
      topic = c.topics[i];
      topicIndex = i;
      break;
    }
  }

  if (!topic) {
    return (
      <div style={s.wrap}>
        <button style={s.backButton} onClick={() => navigate(`${base}/evenflow-101`)}>← BACK TO EVENFLOW 101</button>
        <div style={s.notFoundBox}>This topic doesn't exist. It may have been renamed — head back to the guide and pick it from the list.</div>
      </div>
    );
  }

  return (
    <div style={s.wrap}>
      <button style={s.backButton} onClick={() => navigate(`${base}/evenflow-101`)}>← BACK TO EVENFLOW 101</button>

      <section style={s.hero}>
        <div style={s.eyebrow}>{category.title} · Topic {topicIndex + 1} of {category.topics.length}</div>
        <h2 style={s.title}>{topic.title}</h2>
        {topic.summary && <p style={s.tagline}>{topic.summary}</p>}
      </section>

      <div style={s.modules}>
        {topic.sections.map((section, i) => (
          <TopicModule key={section.heading} index={i} section={section} />
        ))}
      </div>

      <section style={s.footerSection}>
        <SectionHeader>Still Have Questions?</SectionHeader>
        <p style={s.footerText}>
          Ask ED (the floating assistant on every page) about this exact setting — it answers using your
          agency's own real data. If something here needs updating or a feature changes, let your Platform
          Owner know.
        </p>
      </section>
    </div>
  );
}

function TopicModule({ index, section }) {
  let body;
  if (section.body.type === 'steps') {
    body = (
      <ol style={s.stepList}>
        {section.body.items.map((item, i) => <li key={i} style={s.stepItem}>{item}</li>)}
      </ol>
    );
  } else if (section.body.type === 'warnings') {
    body = (
      <ul style={s.warningList}>
        {section.body.items.map((item, i) => <li key={i} style={s.warningItem}>{item}</li>)}
      </ul>
    );
  } else {
    body = (
      <>
        {section.body.items.map((item, i) => <p key={i} style={s.proseBody}>{item}</p>)}
      </>
    );
  }

  return (
    <Card style={s.moduleCard(section.tone)}>
      <div style={s.moduleHeader}>
        <div style={s.moduleIcon(section.tone)}>
          <Icon name={section.icon} size={16} />
        </div>
        <div>
          <div style={s.moduleEyebrow}>Module {String(index + 1).padStart(2, '0')} · {section.label}</div>
          <div style={s.moduleHeading}>{section.heading}</div>
        </div>
      </div>
      {body}
    </Card>
  );
}

const TONE_BORDER = {
  danger: 'var(--danger)',
  warning: 'var(--warning)',
  accent: 'var(--accent)',
  neutral: 'var(--border-strong)',
};
const TONE_ICON_BG = {
  danger: 'var(--danger-soft)',
  warning: 'var(--warning-soft)',
  accent: 'var(--accent-soft, rgba(198,255,46,0.12))',
  neutral: 'var(--bg-hover)',
};
const TONE_ICON_COLOR = {
  danger: 'var(--danger)',
  warning: 'var(--warning)',
  accent: 'var(--accent)',
  neutral: 'var(--text-secondary)',
};

const s = {
  wrap: {},
  notFoundBox: { background: 'var(--bg-sunken)', border: '1px solid var(--border-hairline)', color: 'var(--text-secondary)', padding: 20, borderRadius: 8, fontSize: 13 },
  backButton: { background: 'none', border: 'none', color: 'var(--text-secondary)', fontSize: 12, cursor: 'pointer', marginBottom: 16, padding: 0 },
  hero: { marginBottom: 24, paddingBottom: 20, borderBottom: '1px solid var(--border-hairline)' },
  eyebrow: { color: 'var(--text-muted)', fontSize: 11, letterSpacing: 1, textTransform: 'uppercase', marginBottom: 4 },
  title: { color: 'var(--text-primary)', fontSize: 22, margin: 0 },
  tagline: { color: 'var(--text-secondary)', fontSize: 14, fontStyle: 'italic', marginTop: 8, marginBottom: 0 },
  modules: { display: 'flex', flexDirection: 'column', gap: 16, marginBottom: 28 },
  moduleCard: (tone) => ({ borderLeft: `3px solid ${TONE_BORDER[tone] || TONE_BORDER.neutral}` }),
  moduleHeader: { display: 'flex', alignItems: 'center', gap: 12, marginBottom: 14 },
  moduleIcon: (tone) => ({
    width: 32, height: 32, borderRadius: 8, flexShrink: 0,
    display: 'flex', alignItems: 'center', justifyContent: 'center',
    background: TONE_ICON_BG[tone] || TONE_ICON_BG.neutral,
    color: TONE_ICON_COLOR[tone] || TONE_ICON_COLOR.neutral,
  }),
  moduleEyebrow: { color: 'var(--text-muted)', fontSize: 10, letterSpacing: 1, textTransform: 'uppercase' },
  moduleHeading: { color: 'var(--text-primary)', fontSize: 15, fontWeight: 700 },
  proseBody: { color: 'var(--text-secondary)', fontSize: 14, lineHeight: 1.7, margin: '0 0 10px 0' },
  stepList: { margin: 0, paddingLeft: 20, display: 'flex', flexDirection: 'column', gap: 10 },
  stepItem: { color: 'var(--text-secondary)', fontSize: 14, lineHeight: 1.6 },
  warningList: { margin: 0, paddingLeft: 20, display: 'flex', flexDirection: 'column', gap: 8 },
  warningItem: { color: 'var(--text-secondary)', fontSize: 14, lineHeight: 1.6 },
  footerSection: { marginBottom: 28 },
  footerText: { color: 'var(--text-secondary)', fontSize: 13, lineHeight: 1.6, marginTop: 8 },
};
