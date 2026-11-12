import { useParams, useNavigate } from 'react-router-dom';
import { useAuth } from '../lib/AuthContext';
import { basePathForRole } from '../layout/navConfig';
import { Card, Icon } from '../ui';
import { SALES_SCRIPT_GROUPS } from '../lib/salesScriptsContent';

// Detail page for one Sales Scripts entry — mirrors EvenFlow101DetailPage/
// DrillDetailPage's hero + module-card structure. Every section renders
// through one of 4 body types tailored to call-script content (plain
// reference prose vs. a literal "say this" line vs. a discovery-question
// list vs. an objection/response pair) rather than EvenFlow 101's
// prose/steps/warnings set, since distinguishing "what to literally say"
// from "guidance" is the whole point of a call script.
const TYPE_META = {
  prose: { tone: 'neutral', icon: 'book', label: 'Guidance' },
  quote: { tone: 'accent', icon: 'chat', label: 'Say This' },
  bullets: { tone: 'neutral', icon: 'target', label: 'Discovery' },
  hesitation: { tone: 'warning', icon: 'help', label: 'Objection & Response' },
};

export default function SalesScriptsDetailPage() {
  const { scriptId } = useParams();
  const navigate = useNavigate();
  const { user } = useAuth();
  const base = basePathForRole(user?.role);

  let group = null;
  let topic = null;
  let topicIndex = -1;
  for (const g of SALES_SCRIPT_GROUPS) {
    const i = g.topics.findIndex((t) => t.id === scriptId);
    if (i !== -1) {
      group = g;
      topic = g.topics[i];
      topicIndex = i;
      break;
    }
  }

  function backToScripts() {
    navigate(`${base}/sales-studio?tab=scripts`);
  }

  if (!topic) {
    return (
      <div style={s.wrap}>
        <button style={s.backButton} onClick={backToScripts}>← BACK TO SALES SCRIPTS</button>
        <div style={s.notFoundBox}>This script doesn't exist. It may have been renamed — head back to Sales Scripts and pick it from the list.</div>
      </div>
    );
  }

  return (
    <div style={s.wrap}>
      <button style={s.backButton} onClick={backToScripts}>← BACK TO SALES SCRIPTS</button>

      <section style={s.hero}>
        <div style={s.eyebrow}>{group.title} · Entry {topicIndex + 1} of {group.topics.length}</div>
        <h2 style={s.title}>{topic.title}</h2>
        {topic.summary && <p style={s.tagline}>{topic.summary}</p>}
      </section>

      <div style={s.modules}>
        {topic.sections.map((section, i) => (
          <ScriptModule key={section.heading} index={i} section={section} />
        ))}
      </div>
    </div>
  );
}

function ScriptModule({ index, section }) {
  const meta = TYPE_META[section.body.type] || TYPE_META.prose;
  let body;
  if (section.body.type === 'quote') {
    body = (
      <div style={s.quoteStack}>
        {section.body.items.map((item, i) => <div key={i} style={s.quoteLine}>{item}</div>)}
      </div>
    );
  } else if (section.body.type === 'bullets') {
    body = (
      <ul style={s.bulletList}>
        {section.body.items.map((item, i) => <li key={i} style={s.bulletItem}>{item}</li>)}
      </ul>
    );
  } else if (section.body.type === 'hesitation') {
    body = (
      <div style={s.hesitationStack}>
        {section.body.items.map((item, i) => (
          <div key={i} style={s.hesitationBlock}>
            <div style={s.hesitationLabel}>CUSTOMER SAYS</div>
            <div style={s.hesitationCustomer}>{item.customerSays}</div>
            <div style={s.hesitationLabel}>YOU SAY</div>
            <div style={s.hesitationResponse}>{item.response}</div>
            {item.note && <div style={s.hesitationNote}>{item.note}</div>}
          </div>
        ))}
      </div>
    );
  } else {
    body = (
      <>
        {section.body.items.map((item, i) => <p key={i} style={s.proseBody}>{item}</p>)}
      </>
    );
  }

  return (
    <Card style={s.moduleCard(meta.tone)}>
      <div style={s.moduleHeader}>
        <div style={s.moduleIcon(meta.tone)}>
          <Icon name={meta.icon} size={16} />
        </div>
        <div>
          <div style={s.moduleEyebrow}>Section {String(index + 1).padStart(2, '0')} · {meta.label}</div>
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
  bulletList: { margin: 0, paddingLeft: 20, display: 'flex', flexDirection: 'column', gap: 8 },
  bulletItem: { color: 'var(--text-secondary)', fontSize: 14, lineHeight: 1.6 },
  quoteStack: { display: 'flex', flexDirection: 'column', gap: 10 },
  quoteLine: {
    color: 'var(--text-primary)', fontSize: 14, lineHeight: 1.6, fontStyle: 'italic',
    padding: '10px 14px', borderRadius: 8, background: 'var(--bg-sunken)', borderLeft: '2px solid var(--accent)',
  },
  hesitationStack: { display: 'flex', flexDirection: 'column', gap: 16 },
  hesitationBlock: { display: 'flex', flexDirection: 'column', gap: 4 },
  hesitationLabel: { color: 'var(--text-muted)', fontSize: 10, letterSpacing: 1, fontWeight: 700 },
  hesitationCustomer: { color: 'var(--text-secondary)', fontSize: 14, fontStyle: 'italic', marginBottom: 6 },
  hesitationResponse: { color: 'var(--text-primary)', fontSize: 14, lineHeight: 1.6 },
  hesitationNote: { color: 'var(--text-muted)', fontSize: 12, lineHeight: 1.5, marginTop: 6, fontStyle: 'italic' },
};
