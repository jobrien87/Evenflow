import { useEffect, useState } from 'react';
import { api } from '../lib/api';
import { useAuth } from '../lib/AuthContext';
import { Card, SectionHeader, Badge, Button, EmptyState, Modal } from '../ui';
import { emailStatusMessage } from '../lib/emailStatus';
import TimeClockReportPanel from './TimeClockReportPanel';

const TABS = [
  { key: 'roster', label: 'ROSTER' },
  { key: 'hours', label: 'HOURS REPORT' },
  { key: 'pto', label: 'PTO' },
  { key: 'breakroom', label: 'BREAK ROOM' },
];

const BREAK_ROOM_GAMES = [
  { key: 'CONGO_LINE', label: 'Congo Line' },
  { key: 'BUCKETS', label: 'Buckets' },
  { key: 'FULL_SEND', label: 'Full Send' },
  { key: 'PILL_POP', label: 'Pill Pop' },
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

const PURGE_BLOCKER_LABELS = {
  leadNotes: 'lead notes written',
  leadActivities: 'logged call/email/text activities',
  calls: 'uploaded call recordings',
  messages: 'chat messages sent',
  producerNotesAbout: 'coaching notes about them',
  producerNotesBy: 'coaching notes they wrote',
  telemarketerAssignments: 'telemarketer agency assignments',
  transfersCreated: 'transfers they created',
  importBatchesUploaded: 'bulk/historical imports they uploaded',
  announcementsCreated: 'announcements they sent',
  invitationsSent: 'invitations they sent to others',
};

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
  const [resendingId, setResendingId] = useState('');
  const [resendStatus, setResendStatus] = useState('');
  const [telemarketers, setTelemarketers] = useState([]);
  const [ptoForm, setPtoForm] = useState({ startDate: '', endDate: '', reason: '' });
  const [ptoStatus, setPtoStatus] = useState('');
  const [breakRoomEnabled, setBreakRoomEnabled] = useState(true);
  const [breakRoomSettings, setBreakRoomSettings] = useState(null);
  const [breakRoomStatus, setBreakRoomStatus] = useState('');
  const [breakRoomBusy, setBreakRoomBusy] = useState(false);
  const [purgeTarget, setPurgeTarget] = useState(null);
  const [purgePreview, setPurgePreview] = useState(null);
  const [purgeConfirmText, setPurgeConfirmText] = useState('');
  const [purgeBusy, setPurgeBusy] = useState(false);
  const [purgeError, setPurgeError] = useState('');

  useEffect(() => {
    load();
  }, []);

  useEffect(() => {
    if (tab === 'breakroom' && user?.agencyId && !breakRoomSettings) loadBreakRoomSettings();
  }, [tab, user?.agencyId]);

  async function loadBreakRoomSettings() {
    try {
      const data = await api.agencyDetail(user.agencyId);
      setBreakRoomEnabled(data.agency.breakRoomEnabled);
      setBreakRoomSettings(data.agency.breakRoomSettings || {
        games: { CONGO_LINE: true, BUCKETS: true, FULL_SEND: true, PILL_POP: true },
        pickMeUpEnabled: true, lunchEligible: false, soundsEnabled: true, achievementsEnabled: true,
        leaderboardScope: { office: true, agency: true },
      });
    } catch (err) {
      setBreakRoomStatus(err.data?.message || 'Could not load Break Room settings.');
    }
  }

  async function saveBreakRoomSettings() {
    setBreakRoomBusy(true);
    setBreakRoomStatus('');
    try {
      await api.updateAgencyBreakRoomSettings(user.agencyId, breakRoomSettings);
      setBreakRoomStatus('Saved.');
    } catch (err) {
      setBreakRoomStatus(err.data?.message || 'Could not save Break Room settings.');
    } finally {
      setBreakRoomBusy(false);
    }
  }

  async function load() {
    setError('');
    try {
      const [userData, badgeData, birthdayData, ptoData, agencyData] = await Promise.all([
        api.users(''),
        api.rosterBadges(),
        api.rosterBirthdays(),
        api.ptoRequests(),
        user?.agencyId ? api.agencyDetail(user.agencyId) : Promise.resolve(null),
      ]);
      setUsers(userData.users);
      const grouped = {};
      for (const b of badgeData.badges) {
        (grouped[b.userId] = grouped[b.userId] || []).push(b);
      }
      setBadgesByUser(grouped);
      setBirthdays(birthdayData.birthdays);
      setPtoRequests(ptoData.requests);
      setTelemarketers(agencyData?.roster?.telemarketers || []);
    } catch (err) {
      setError(err.data?.message || 'Could not load Roster Settings. Try refreshing.');
    }
  }

  async function resendInvite(userId) {
    setResendingId(userId);
    setResendStatus('Resending…');
    try {
      const res = await api.resendUserInvite(userId);
      setResendStatus(emailStatusMessage('Invitation resent.', res.emailStatus));
    } catch (err) {
      setResendStatus(err.data?.message || 'Failed to resend invitation.');
    } finally {
      setResendingId('');
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

  async function openPurge(u) {
    setPurgeTarget(u);
    setPurgePreview(null);
    setPurgeConfirmText('');
    setPurgeError('');
    try {
      const data = await api.purgeUserPreview(u.id);
      setPurgePreview(data);
    } catch (err) {
      setPurgeError(err.data?.message || 'Could not load what would be deleted.');
    }
  }

  function closePurge() {
    setPurgeTarget(null);
    setPurgePreview(null);
    setPurgeConfirmText('');
    setPurgeError('');
  }

  async function confirmPurge() {
    if (!purgeTarget) return;
    setPurgeBusy(true);
    setPurgeError('');
    try {
      await api.purgeUser(purgeTarget.id, purgeConfirmText);
      closePurge();
      await load();
    } catch (err) {
      setPurgeError(err.data?.message || 'Could not delete this account.');
    } finally {
      setPurgeBusy(false);
    }
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
            {resendStatus && <div style={s.status}>{resendStatus}</div>}
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
                    {(u.status === 'INVITED' || u.status === 'DEACTIVATED') && (
                      <button style={s.linkButton} disabled={resendingId === u.id} onClick={() => resendInvite(u.id)}>
                        {resendingId === u.id ? 'RESENDING…' : u.status === 'DEACTIVATED' ? 'RESEND & REACTIVATE' : 'RESEND'}
                      </button>
                    )}
                    {u.status === 'ACTIVE' && u.id !== user?.id && <button style={s.deactivateButton} onClick={() => deactivate(u.id)}>DEACTIVATE</button>}
                    {u.status === 'DEACTIVATED' && u.id !== user?.id && <button style={s.deactivateButton} onClick={() => openPurge(u)}>DELETE PERMANENTLY</button>}
                  </div>
                )}
              </div>
            ))}
            {users.length === 0 && <div style={s.empty}>No team members yet.</div>}
          </Card>

          <Card style={s.card}>
            <div style={s.cardTitle}>TELEMARKETERS ({telemarketers.length})</div>
            {telemarketers.length === 0 && <div style={s.empty}>No telemarketer currently assigned to this agency.</div>}
            {telemarketers.map((t) => (
              <div key={t.assignmentId} style={s.userRow} className="ui-row-stack">
                <div>
                  <div style={s.rowTitle}>{t.firstName} {t.lastName}</div>
                  <div style={s.rowSub}>{t.email}{t.assignedAt ? ` · assigned ${new Date(t.assignedAt).toLocaleDateString()}` : ''}</div>
                </div>
              </div>
            ))}
          </Card>
        </>
      )}

      {tab === 'hours' && <TimeClockReportPanel />}

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

      {tab === 'breakroom' && (
        <Card style={s.card}>
          <div style={s.cardTitle}>BREAK ROOM ARCADE</div>
          <div style={s.rowSub}>
            Module status: <b style={{ color: breakRoomEnabled ? 'var(--accent)' : 'var(--text-muted)' }}>{breakRoomEnabled ? 'ON' : 'OFF'}</b>
            {!breakRoomEnabled && ' — ask your Platform Owner to turn the module on.'}
          </div>

          {!breakRoomSettings ? (
            <div style={{ ...s.empty, marginTop: 12 }}>Loading…</div>
          ) : (
            <>
              <div style={s.breakRoomSection}>
                <div style={s.breakRoomSectionLabel}>GAMES</div>
                {BREAK_ROOM_GAMES.map((g) => (
                  <label key={g.key} style={s.checkboxRow}>
                    <input
                      type="checkbox"
                      checked={!!breakRoomSettings.games[g.key]}
                      onChange={(e) => setBreakRoomSettings({ ...breakRoomSettings, games: { ...breakRoomSettings.games, [g.key]: e.target.checked } })}
                    />
                    {g.label}
                  </label>
                ))}
              </div>

              <div style={s.breakRoomSection}>
                <div style={s.breakRoomSectionLabel}>ACCESS & LEADERBOARDS</div>
                <label style={s.checkboxRow}>
                  <input type="checkbox" checked={breakRoomSettings.lunchEligible} onChange={(e) => setBreakRoomSettings({ ...breakRoomSettings, lunchEligible: e.target.checked })} />
                  Allow play during lunch (not just Break)
                </label>
                <label style={s.checkboxRow}>
                  <input type="checkbox" checked={breakRoomSettings.pickMeUpEnabled} onChange={(e) => setBreakRoomSettings({ ...breakRoomSettings, pickMeUpEnabled: e.target.checked })} />
                  Pick Me Up (joke button)
                </label>
                <label style={s.checkboxRow}>
                  <input type="checkbox" checked={breakRoomSettings.soundsEnabled} onChange={(e) => setBreakRoomSettings({ ...breakRoomSettings, soundsEnabled: e.target.checked })} />
                  Sounds
                </label>
                <label style={s.checkboxRow}>
                  <input type="checkbox" checked={breakRoomSettings.achievementsEnabled} onChange={(e) => setBreakRoomSettings({ ...breakRoomSettings, achievementsEnabled: e.target.checked })} />
                  Achievements
                </label>
                <label style={s.checkboxRow}>
                  <input
                    type="checkbox"
                    checked={breakRoomSettings.leaderboardScope.office}
                    onChange={(e) => setBreakRoomSettings({ ...breakRoomSettings, leaderboardScope: { ...breakRoomSettings.leaderboardScope, office: e.target.checked } })}
                  />
                  Office leaderboard
                </label>
                <label style={s.checkboxRow}>
                  <input
                    type="checkbox"
                    checked={breakRoomSettings.leaderboardScope.agency}
                    onChange={(e) => setBreakRoomSettings({ ...breakRoomSettings, leaderboardScope: { ...breakRoomSettings.leaderboardScope, agency: e.target.checked } })}
                  />
                  Agency leaderboard
                </label>
              </div>

              <Button variant="primary" size="sm" disabled={breakRoomBusy} onClick={saveBreakRoomSettings}>{breakRoomBusy ? 'SAVING…' : 'SAVE'}</Button>
              {breakRoomStatus && <div style={s.status}>{breakRoomStatus}</div>}
            </>
          )}
        </Card>
      )}

      {purgeTarget && (
        <Modal title="Delete account permanently" onClose={closePurge}>
          <p style={s.purgeIntro}>
            This permanently deletes <b>{purgeTarget.firstName} {purgeTarget.lastName}</b> ({purgeTarget.email})
            and cannot be undone.
          </p>
          {!purgePreview && !purgeError && <div style={s.status}>Checking what's attached to this account…</div>}
          {purgeError && <div style={s.purgeError}>{purgeError}</div>}
          {purgePreview && !purgePreview.canPurge && (
            <div style={s.purgeBlocked}>
              This account has real recorded history and can't be permanently deleted:
              <ul style={s.purgeBlockList}>
                {Object.entries(purgePreview.blockers)
                  .filter(([, count]) => count > 0)
                  .map(([key, count]) => (
                    <li key={key}>{count} {PURGE_BLOCKER_LABELS[key] || key}</li>
                  ))}
              </ul>
              It will stay deactivated (hidden, no login) but its history and everyone else's related records stay intact.
            </div>
          )}
          {purgePreview && purgePreview.canPurge && (
            <>
              <p style={s.purgeIntro}>No recorded history is attached — safe to delete. Type their exact email to confirm.</p>
              <input
                style={s.input}
                placeholder={purgeTarget.email}
                value={purgeConfirmText}
                onChange={(e) => setPurgeConfirmText(e.target.value)}
              />
              <div style={{ marginTop: 12, display: 'flex', gap: 8 }}>
                <Button
                  variant="danger"
                  disabled={purgeBusy || purgeConfirmText !== purgeTarget.email}
                  onClick={confirmPurge}
                >
                  {purgeBusy ? 'DELETING…' : 'DELETE PERMANENTLY'}
                </Button>
                <Button variant="secondary" onClick={closePurge}>CANCEL</Button>
              </div>
            </>
          )}
          {purgePreview && !purgePreview.canPurge && (
            <div style={{ marginTop: 12 }}>
              <Button variant="secondary" onClick={closePurge}>CLOSE</Button>
            </div>
          )}
        </Modal>
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
  breakRoomSection: { marginTop: 16, marginBottom: 8 },
  breakRoomSectionLabel: { fontSize: 10, letterSpacing: 1.5, fontWeight: 700, color: 'var(--text-muted)', marginBottom: 8, textTransform: 'uppercase' },
  checkboxRow: { display: 'flex', alignItems: 'center', gap: 8, fontSize: 13, color: 'var(--text-secondary)', padding: '6px 0', cursor: 'pointer' },
  purgeIntro: { fontSize: 13, color: 'var(--text-secondary)', lineHeight: 1.5, marginBottom: 10 },
  purgeError: { color: 'var(--danger)', fontSize: 13, marginBottom: 10 },
  purgeBlocked: {
    color: 'var(--danger)', fontSize: 13, lineHeight: 1.5, background: 'rgba(255, 77, 94, 0.1)',
    border: '1px solid rgba(255, 77, 94, 0.4)', borderRadius: 6, padding: 10,
  },
  purgeBlockList: { margin: '8px 0', paddingLeft: 20 },
};
