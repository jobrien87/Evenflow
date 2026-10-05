import { useEffect, useState } from 'react';
import { api } from '../lib/api';
import { useAuth } from '../lib/AuthContext';
import { Card, SectionHeader, Badge, Button, EmptyState } from '../ui';
import TimeClockReportPanel from './TimeClockReportPanel';
import CoursesAdminPanel from './CoursesAdminPanel';

const TABS = [
  { key: 'roster', label: 'ROSTER' },
  { key: 'hours', label: 'HOURS REPORT' },
  { key: 'pto', label: 'PTO' },
  { key: 'training', label: 'TRAINING' },
];

const BADGE_TYPES = [
  { key: 'FIRST_YEAR', label: '1 Year' },
  { key: 'FIVE_YEAR', label: '5 Years' },
  { key: 'TEN_YEAR', label: '10 Years' },
  { key: 'PC_LICENSE', label: 'P&C License' },
  { key: 'LIFE_LICENSE', label: 'Life License' },
];

function badgeLabel(type) {
  if (type === 'AGENT_OF_THE_MONTH') return 'Agent of the Month';
  const found = BADGE_TYPES.find((b) => b.key === type);
  return found ? found.label : type;
}

// Roster Settings — the consolidated hub: team roster (invite/deactivate,
// already-real actions pulled together here), badges, upcoming birthdays,
// the hours report (reused as-is, not rebuilt), and the PTO queue.
export default function RosterSettingsPanel() {
  const { user } = useAuth();
  const [tab, setTab] = useState('roster');
  const [users, setUsers] = useState([]);
  const [badgesByUser, setBadgesByUser] = useState({});
  const [birthdays, setBirthdays] = useState([]);
  const [ptoRequests, setPtoRequests] = useState([]);
  const [error, setError] = useState('');
  const [awardForUserId, setAwardForUserId] = useState('');
  const [awardType, setAwardType] = useState('FIRST_YEAR');
  const [inviteEmail, setInviteEmail] = useState('');
  const [inviteFirstName, setInviteFirstName] = useState('');
  const [inviteLastName, setInviteLastName] = useState('');
  const [inviteRole, setInviteRole] = useState('PRODUCER');
  const [inviteStatus, setInviteStatus] = useState('');
  const [ptoForm, setPtoForm] = useState({ startDate: '', endDate: '', reason: '' });
  const [ptoStatus, setPtoStatus] = useState('');

  useEffect(() => {
    load();
  }, []);

  async function load() {
    setError('');
    try {
      const [userData, badgeData, birthdayData, ptoData] = await Promise.all([
        api.users(''),
        api.rosterBadges(),
        api.rosterBirthdays(),
        api.ptoRequests(),
      ]);
      setUsers(userData.users);
      const grouped = {};
      for (const b of badgeData.badges) {
        (grouped[b.userId] = grouped[b.userId] || []).push(b);
      }
      setBadgesByUser(grouped);
      setBirthdays(birthdayData.birthdays);
      setPtoRequests(ptoData.requests);
    } catch (err) {
      setError(err.data?.message || 'Could not load Roster Settings. Try refreshing.');
    }
  }

  async function invite(e) {
    e.preventDefault();
    setInviteStatus('Inviting…');
    try {
      const res = await api.inviteUsersBulk([{ email: inviteEmail, firstName: inviteFirstName, lastName: inviteLastName, role: inviteRole }]);
      const result = res.results[0];
      setInviteStatus(result.success ? 'Invited.' : (result.message || 'Failed to invite.'));
      if (result.success) {
        setInviteEmail(''); setInviteFirstName(''); setInviteLastName('');
        await load();
      }
    } catch (err) {
      setInviteStatus(err.data?.message || 'Failed to invite.');
    }
  }

  async function deactivate(userId) {
    if (!confirm('Deactivate this user? Their history stays intact, but they will not be able to log in.')) return;
    await api.deactivateUser(userId);
    await load();
  }

  async function awardBadge(e) {
    e.preventDefault();
    if (!awardForUserId) return;
    await api.awardBadge({ userId: awardForUserId, type: awardType });
    setAwardForUserId('');
    await load();
  }

  async function revokeBadge(id) {
    if (!confirm('Revoke this badge?')) return;
    await api.revokeBadge(id);
    await load();
  }

  async function submitPto(e) {
    e.preventDefault();
    setPtoStatus('Submitting…');
    try {
      await api.createPtoRequest(ptoForm);
      setPtoStatus('Request submitted.');
      setPtoForm({ startDate: '', endDate: '', reason: '' });
      await load();
    } catch (err) {
      setPtoStatus(err.data?.message || 'Failed to submit.');
    }
  }

  async function reviewPto(id, status) {
    await api.reviewPtoRequest(id, { status });
    await load();
  }

  async function cancelPto(id) {
    if (!confirm('Cancel this PTO request?')) return;
    await api.cancelPtoRequest(id);
    await load();
  }

  const canManage = ['AGENCY_OWNER', 'AGENCY_MANAGER', 'PLATFORM_OWNER'].includes(user?.role);

  if (error) return <EmptyState title="Couldn't load Roster Settings" description={error} />;

  return (
    <div>
      <div style={s.headerRow}>
        <SectionHeader>Roster Settings</SectionHeader>
        <div style={s.tabRow}>
          {TABS.map((t) => (
            <button key={t.key} style={s.tab(tab === t.key)} onClick={() => setTab(t.key)}>{t.label}</button>
          ))}
        </div>
      </div>

      {tab === 'roster' && (
        <>
          {birthdays.length > 0 && (
            <Card style={s.card}>
              <div style={s.cardTitle}>UPCOMING BIRTHDAYS (NEXT 30 DAYS)</div>
              {birthdays.map((b) => (
                <div key={b.id} style={s.birthdayRow}>
                  <span>{b.firstName} {b.lastName}</span>
                  <span style={s.rowSub}>{b.month}/{b.day} · {b.daysUntil === 0 ? 'today' : `in ${b.daysUntil}d`}</span>
                </div>
              ))}
            </Card>
          )}

          {canManage && (
            <Card style={s.card}>
              <div style={s.cardTitle}>+ INVITE</div>
              <form onSubmit={invite} style={s.inviteForm}>
                <input style={s.input} placeholder="Email" type="email" value={inviteEmail} onChange={(e) => setInviteEmail(e.target.value)} required />
                <input style={s.input} placeholder="First name" value={inviteFirstName} onChange={(e) => setInviteFirstName(e.target.value)} required />
                <input style={s.input} placeholder="Last name" value={inviteLastName} onChange={(e) => setInviteLastName(e.target.value)} required />
                <select style={s.input} value={inviteRole} onChange={(e) => setInviteRole(e.target.value)}>
                  <option value="PRODUCER">Producer</option>
                  <option value="AGENCY_MANAGER">Agency Manager</option>
                </select>
                <Button type="submit" size="sm">INVITE</Button>
              </form>
              {inviteStatus && <div style={s.status}>{inviteStatus}</div>}
            </Card>
          )}

          <Card style={s.card}>
            <div style={s.cardTitle}>TEAM ({users.length})</div>
            {users.map((u) => (
              <div key={u.id} style={s.userRow} className="ui-row-stack">
                <div>
                  <div style={s.rowTitle}>{u.firstName} {u.lastName}</div>
                  <div style={s.rowSub}>{u.role} · {u.status}{u.office ? ` · ${u.office.name}` : ''}</div>
                  <div style={s.badgeRow}>
                    {(badgesByUser[u.id] || []).map((b) => (
                      <span key={b.id} onClick={canManage ? () => revokeBadge(b.id) : undefined} style={{ cursor: canManage ? 'pointer' : 'default' }} title={canManage ? 'Click to revoke' : undefined}>
                        <Badge tone="accent">{badgeLabel(b.type)}</Badge>
                      </span>
                    ))}
                  </div>
                </div>
                {canManage && (
                  <div style={s.userActions}>
                    <select style={s.miniSelect} value={awardForUserId === u.id ? awardType : ''} onChange={(e) => { setAwardForUserId(u.id); setAwardType(e.target.value); }}>
                      <option value="" disabled>Award badge…</option>
                      {BADGE_TYPES.map((b) => <option key={b.key} value={b.key}>{b.label}</option>)}
                    </select>
                    {awardForUserId === u.id && <button style={s.smallButton} onClick={awardBadge}>AWARD</button>}
                    {u.status === 'INVITED' && <button style={s.linkButton} onClick={() => api.resendUserInvite(u.id)}>RESEND</button>}
                    {u.status === 'ACTIVE' && u.id !== user?.id && <button style={s.deactivateButton} onClick={() => deactivate(u.id)}>DEACTIVATE</button>}
                  </div>
                )}
              </div>
            ))}
            {users.length === 0 && <div style={s.empty}>No team members yet.</div>}
          </Card>
        </>
      )}

      {tab === 'hours' && <TimeClockReportPanel />}

      {tab === 'training' && <CoursesAdminPanel />}

      {tab === 'pto' && (
        <>
          <Card style={s.card}>
            <div style={s.cardTitle}>+ REQUEST PTO</div>
            <form onSubmit={submitPto} style={s.inviteForm}>
              <input style={s.input} type="date" value={ptoForm.startDate} onChange={(e) => setPtoForm({ ...ptoForm, startDate: e.target.value })} required />
              <input style={s.input} type="date" value={ptoForm.endDate} onChange={(e) => setPtoForm({ ...ptoForm, endDate: e.target.value })} required />
              <input style={s.input} placeholder="Reason (optional)" value={ptoForm.reason} onChange={(e) => setPtoForm({ ...ptoForm, reason: e.target.value })} />
              <Button type="submit" size="sm">SUBMIT</Button>
            </form>
            {ptoStatus && <div style={s.status}>{ptoStatus}</div>}
          </Card>

          <Card style={s.card}>
            <div style={s.cardTitle}>{canManage ? 'PTO REQUESTS' : 'MY PTO REQUESTS'}</div>
            {ptoRequests.map((r) => (
              <div key={r.id} style={s.userRow} className="ui-row-stack">
                <div>
                  <div style={s.rowTitle}>{r.user.firstName} {r.user.lastName}</div>
                  <div style={s.rowSub}>
                    {new Date(r.startDate).toLocaleDateString()} – {new Date(r.endDate).toLocaleDateString()}
                    {r.reason ? ` · ${r.reason}` : ''}
                  </div>
                </div>
                <div style={s.userActions}>
                  <Badge tone={r.status === 'APPROVED' ? 'accent' : r.status === 'DENIED' ? 'danger' : r.status === 'CANCELLED' ? 'neutral' : 'warning'}>{r.status}</Badge>
                  {canManage && r.status === 'PENDING' && (
                    <>
                      <button style={s.smallButton} onClick={() => reviewPto(r.id, 'APPROVED')}>APPROVE</button>
                      <button style={s.deactivateButton} onClick={() => reviewPto(r.id, 'DENIED')}>DENY</button>
                    </>
                  )}
                  {!canManage && r.userId === user?.id && r.status === 'PENDING' && (
                    <button style={s.deactivateButton} onClick={() => cancelPto(r.id)}>CANCEL</button>
                  )}
                </div>
              </div>
            ))}
            {ptoRequests.length === 0 && <div style={s.empty}>No PTO requests yet.</div>}
          </Card>
        </>
      )}
    </div>
  );
}

const s = {
  headerRow: { display: 'flex', justifyContent: 'space-between', alignItems: 'center', flexWrap: 'wrap', gap: 10, marginBottom: 16 },
  tabRow: { display: 'flex', gap: 8 },
  tab: (active) => ({
    padding: '8px 14px', borderRadius: 6, border: '1px solid var(--border-strong)', cursor: 'pointer', fontSize: 11, fontWeight: 700,
    background: active ? 'var(--accent-gradient)' : 'transparent', color: active ? 'var(--accent-on)' : 'var(--text-secondary)',
  }),
  card: { marginBottom: 16, padding: 'var(--space-4)' },
  cardTitle: { fontSize: 11, letterSpacing: 1.5, fontWeight: 700, color: 'var(--text-secondary)', marginBottom: 12, textTransform: 'uppercase' },
  birthdayRow: { display: 'flex', justifyContent: 'space-between', padding: '6px 0', fontSize: 13, color: 'var(--text-primary)' },
  rowSub: { color: 'var(--text-muted)', fontSize: 12, marginTop: 2 },
  inviteForm: { display: 'flex', gap: 8, flexWrap: 'wrap', alignItems: 'center' },
  input: { padding: '8px 10px', background: 'var(--bg-sunken)', border: '1px solid var(--border-strong)', borderRadius: 6, color: 'var(--text-primary)', fontSize: 13 },
  status: { color: 'var(--accent)', fontSize: 12, marginTop: 8 },
  userRow: { display: 'flex', justifyContent: 'space-between', alignItems: 'center', padding: '10px 0', borderBottom: '1px solid var(--border-hairline)', gap: 10 },
  rowTitle: { fontWeight: 600, fontSize: 14, color: 'var(--text-primary)' },
  badgeRow: { display: 'flex', gap: 6, flexWrap: 'wrap', marginTop: 6 },
  userActions: { display: 'flex', gap: 8, alignItems: 'center', flexWrap: 'wrap' },
  miniSelect: { padding: '6px 8px', background: 'var(--bg-sunken)', border: '1px solid var(--border-strong)', borderRadius: 6, color: 'var(--text-primary)', fontSize: 11 },
  smallButton: { padding: '6px 10px', background: 'var(--accent-gradient)', color: 'var(--accent-on)', border: 'none', borderRadius: 6, fontWeight: 700, cursor: 'pointer', fontSize: 11 },
  linkButton: { fontSize: 11, color: 'var(--text-secondary)', border: '1px solid var(--border-strong)', background: 'none', padding: '4px 8px', borderRadius: 4, cursor: 'pointer' },
  deactivateButton: { fontSize: 11, color: 'var(--danger)', border: '1px solid rgba(255, 77, 94, 0.4)', background: 'none', padding: '4px 8px', borderRadius: 4, cursor: 'pointer' },
  empty: { color: 'var(--text-muted)', fontStyle: 'italic', fontSize: 13 },
};
