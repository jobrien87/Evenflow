import { useNavigate } from 'react-router-dom';
import { useAuth } from '../lib/AuthContext';
import { basePathForRole } from '../layout/navConfig';
import { Card, Badge, Icon } from '../ui';
import { SALES_SCRIPT_GROUPS } from '../lib/salesScriptsContent';

// Sales Studio tab: human producer call scripts (Internet Leads vs. Cold
// High Intent Data, kept in their own groups so a producer can't
// accidentally grab a request-based Internet opening for a cold
// prospect) plus shared producer guidance. Content lives entirely in
// salesScriptsContent.js (no API call, no loading state) — same static,
// no-admin-editor convention as EvenFlow 101 and the Drill Library.
export default function SalesScriptsPanel() {
  const { user } = useAuth();
  const navigate = useNavigate();
  const base = basePathForRole(user?.role);

  return (
    <div style={s.wrap}>
      <p style={s.intro}>
        Human producer call scripts to practice, then use conversationally — not automated outreach. Internet Leads
        and Cold High Intent Data are kept separate below; read each entry's own "when to use this script" note
        before dialing.
      </p>

      {SALES_SCRIPT_GROUPS.map((group) => (
        <section key={group.id} style={s.section}>
          <div style={s.groupHeaderRow}>
            <div style={s.groupIcon}>
              <Icon name={group.icon} size={16} />
            </div>
            <h3 style={s.groupTitle}>{group.title}</h3>
            <Badge tone="neutral">{group.topics.length} entr{group.topics.length === 1 ? 'y' : 'ies'}</Badge>
          </div>
          {group.description && <p style={s.groupDesc}>{group.description}</p>}
          <Card style={s.listCard}>
            {group.topics.map((topic) => (
              <div
                key={topic.id}
                style={s.topicRow}
                className="ui-row-stack"
                onClick={() => navigate(`${base}/sales-scripts/${topic.id}`)}
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
  intro: { color: 'var(--text-secondary)', fontSize: 13, lineHeight: 1.6, marginBottom: 20 },
  section: { marginBottom: 28 },
  groupHeaderRow: { display: 'flex', alignItems: 'center', gap: 10, marginBottom: 4 },
  groupIcon: {
    width: 28, height: 28, borderRadius: 8, flexShrink: 0,
    display: 'flex', alignItems: 'center', justifyContent: 'center',
    background: 'var(--bg-hover)', color: 'var(--text-secondary)',
  },
  groupTitle: { color: 'var(--text-primary)', fontSize: 16, fontWeight: 700, margin: 0, flex: 1 },
  groupDesc: { color: 'var(--text-muted)', fontSize: 12, marginTop: 2, marginBottom: 12, lineHeight: 1.5 },
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
