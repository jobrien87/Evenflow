import { useEffect, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { api } from '../lib/api';
import { useAuth } from '../lib/AuthContext';
import { useIsMobile } from '../lib/useViewport';
import { Button, EdSuggestionBox } from '../ui';
import FlowScoreCard from './FlowScoreCard';
import LeadsSnapshotBox from './LeadsSnapshotBox';
import ZipCodeBox from './ZipCodeBox';
import ZipReportPage from './ZipReportPage';
import FunnelMetricsCard from './FunnelMetricsCard';
import RunningReportPage from './RunningReportPage';
import AgencySettingsModal from './AgencySettingsModal';
import PerformanceLeaderboards from './PerformanceLeaderboards';
import TeamClockStatusBox from './TeamClockStatusBox';
import AnnouncementComposer from './AnnouncementComposer';
import { emailStatusMessage } from '../lib/emailStatus';

export default function AgencyOwnerDashboard() {
  const { user } = useAuth();
  const isMobile = useIsMobile();
  const navigate = useNavigate();
  const [users, setUsers] = useState([]);
  const [showInvite, setShowInvite] = useState(false);
  const [inviteRows, setInviteRows] = useState([{ email: '', firstName: '', lastName: '', role: 'PRODUCER' }]);
  const [inviteBusy, setInviteBusy] = useState(false);
  const [inviteResults, setInviteResults] = useState(null);
  const [status, setStatus] = useState('');
  const [showReport, setShowReport] = useState(false);
  const [showZipReport, setShowZipReport] = useState(false);
  const [showSettings, setShowSettings] = useState(false);
  const [showAnnounce, setShowAnnounce] = useState(false);
  const [agency, setAgency] = useState(null);
  const [telemarketers, setTelemarketers] = useState([]);
  const [editingUserId, setEditingUserId] = useState(null);
  const [editUserForm, setEditUserForm] = useState({ firstName: '', lastName: '', officeId: '' });
  const [editUserError, setEditUserError] = useState('');
  const [loadError, setLoadError] = useState('');
  const [producerScores, setProducerScores] = useState({});
  const [offices, setOffices] = useState([]);
  const [showOffices, setShowOffices] = useState(false);
  const [newOfficeName, setNewOfficeName] = useState('');
  const [officeError, setOfficeError] = useState('');

  useEffect(() => {
    load();
  }, []);

  async function load() {
    setLoadError('');
    try {
      const [userData, agencyData, officeData] = await Promise.all([api.users(''), api.agencyDetail(user.agencyId), api.offices()]);
      setUsers(userData.users);
      setAgency(agencyData.agency);
      setTelemarketers(agencyData.roster?.telemarketers || []);
      setOffices(officeData.offices || []);
      loadProducerScores(userData.users);
    } catch (err) {
      setLoadError(err.data?.message || 'Could not load your agency dashboard. Try refreshing.');
    }
  }

  // Inline Flow Score on the roster — an N+1 fan-out is acceptable at this
  // team-roster scale (a per-page-load call per active producer, not a
  // hot path); revisit with a real batch endpoint only if a real agency's
  // roster size ever makes it slow.
  async function loadProducerScores(allUsers) {
    const activeProducers = allUsers.filter((u) => u.role === 'PRODUCER' && u.status === 'ACTIVE');
    if (activeProducers.length === 0) return;
    const entries = await Promise.all(
      activeProducers.map((p) =>
        api.userFlowScore(p.id).then((res) => [p.id, res.snapshot?.score ?? null]).catch(() => [p.id, null])
      )
    );
    setProducerScores(Object.fromEntries(entries));
  }

  function startEditUser(u) {
    setEditingUserId(u.id);
    setEditUserForm({ firstName: u.firstName, lastName: u.lastName, officeId: u.officeId || '' });
  }

  async function saveEditUser(userId) {
    setEditUserError('');
    try {
      await api.updateUser(userId, { ...editUserForm, officeId: editUserForm.officeId || null });
      setEditingUserId(null);
      await load();
    } catch (err) {
      setEditUserError(err.data?.message || 'Failed to save.');
    }
  }

  async function createOffice(e) {
    e.preventDefault();
    setOfficeError('');
    try {
      await api.createOffice({ name: newOfficeName });
      setNewOfficeName('');
      await load();
    } catch (err) {
      setOfficeError(err.data?.message || 'Failed to create office.');
    }
  }

  async function renameOffice(id, name) {
    if (!name.trim()) return;
    await api.updateOffice(id, { name });
    await load();
  }

  async function removeOffice(id) {
    if (!confirm('Delete this office? Producers assigned to it will become unassigned.')) return;
    await api.deleteOffice(id);
    await load();
  }

  function selectFunnelStage(stageKey, range) {
    navigate(`/agency/leads?stage=${stageKey}&from=${range.from}&to=${range.to}`);
  }

  async function resendUser(userId) {
    setStatus('Resending…');
    try {
      const res = await api.resendUserInvite(userId);
      setStatus(emailStatusMessage('Invitation resent.', res.emailStatus));
    } catch (err) {
      setStatus(err.data?.message || 'Failed to resend invitation.');
    }
  }

  function addInviteRow() {
    setInviteRows((rows) => (rows.length >= 25 ? rows : [...rows, { email: '', firstName: '', lastName: '', role: 'PRODUCER' }]));
  }

  function removeInviteRow(index) {
    setInviteRows((rows) => (rows.length <= 1 ? rows : rows.filter((_, i) => i !== index)));
  }

  function updateInviteRow(index, field, value) {
    setInviteRows((rows) => rows.map((row, i) => (i === index ? { ...row, [field]: value } : row)));
  }

  async function submitInvites(e) {
    e.preventDefault();
    setInviteBusy(true);
    setInviteResults(null);
    setStatus('');
    try {
      const res = await api.inviteUsersBulk(inviteRows);
      setInviteResults(res.results);
      setStatus(`${res.succeeded} of ${res.results.length} invitation${res.results.length === 1 ? '' : 's'} sent.`);
      if (res.failed === 0) {
        setInviteRows([{ email: '', firstName: '', lastName: '', role: 'PRODUCER' }]);
        setShowInvite(false);
      }
      await load();
    } catch (err) {
      setStatus(err.data?.message || 'Failed to send invitations.');
    } finally {
      setInviteBusy(false);
    }
  }

  async function deactivate(userId) {
    if (!confirm('Deactivate this user? Their history and attribution stay intact, but they will not be able to log in.')) return;
    setStatus('');
    try {
      await api.deactivateUser(userId);
      await load();
    } catch (err) {
      setStatus(err.data?.message || 'Failed to deactivate user.');
    }
  }

  async function sendReset(userId) {
    setStatus('Sending password reset…');
    try {
      const res = await api.sendPasswordReset(userId);
      setStatus(emailStatusMessage('Password reset sent.', res.emailStatus));
    } catch (err) {
      setStatus(err.data?.message || 'Failed to send password reset.');
    }
  }

  const producers = users.filter((u) => u.role === 'PRODUCER' && u.status === 'ACTIVE');

  return (
    <div style={s.wrap}>
      {loadError && (
        <div style={s.loadErrorBox}>
          {loadError}
          <Button variant="secondary" size="sm" onClick={load}>RETRY</Button>
        </div>
      )}

      <section style={s.section}>
        <div style={s.settingsRow}>
          <Button variant="primary" size="sm" onClick={() => setShowAnnounce(true)}>+ ANNOUNCEMENT</Button>
          <Button variant="secondary" size="sm" onClick={() => setShowSettings(true)}>AGENCY SETTINGS</Button>
        </div>
        <div style={isMobile ? s.topStacked : s.topSplit}>
          <FlowScoreCard scope="agency" agencyId={user?.agencyId} title="AGENCY FLOW SCORE" onViewReport={() => setShowReport(true)} />
          <LeadsSnapshotBox agencyId={user?.agencyId} />
        </div>
      </section>

      <section style={s.section}>
        <ZipCodeBox agencyId={user?.agencyId} onViewReport={() => setShowZipReport(true)} />
      </section>

      <section style={s.section}>
        <TeamClockStatusBox />
      </section>

      <section style={s.section}>
        <EdSuggestionBox pageContext="agency_dashboard" />
      </section>

      <section style={s.section}>
        <FunnelMetricsCard scope="agency" title="AGENCY FUNNEL" onSelectStage={selectFunnelStage} />
      </section>

      <section style={s.section}>
        <PerformanceLeaderboards agencyId={user?.agencyId} linkToDetail />
      </section>

      <section style={s.section}>
        <div style={s.headerRow}>
          <h3 style={s.h3}>OFFICES ({offices.length})</h3>
          <button style={s.smallButtonOutline} onClick={() => setShowOffices(!showOffices)}>
            {showOffices ? 'HIDE' : 'MANAGE OFFICES'}
          </button>
        </div>
        {showOffices && (
          <>
            <div style={s.hint}>
              Assign producers to a physical office/branch below in TEAM, and split vendor leads across offices
              using the "Office Split" lead distribution mode on the Vendors tab.
            </div>
            <form onSubmit={createOffice} style={{ ...s.form, flexDirection: 'row', alignItems: 'center' }}>
              <input style={{ ...s.input, flex: 1 }} placeholder="Office name (e.g. Downtown, North Branch)" value={newOfficeName} onChange={(e) => setNewOfficeName(e.target.value)} required />
              <button style={s.submitButton} type="submit">+ ADD OFFICE</button>
            </form>
            {officeError && <div style={s.editUserError}>{officeError}</div>}
            {offices.map((o) => (
              <div key={o.id} style={s.row}>
                <div style={{ flex: 1 }}>
                  <div style={s.rowTitle}>{o.name}{o.isDefaultOffice ? ' (default)' : ''}</div>
                  <div style={s.rowSub}>
                    {(o.users || []).length} producer{(o.users || []).length === 1 ? '' : 's'} ·{' '}
                    {o.routingMode === 'ALPHA_SPLIT' ? 'Alpha Split' : 'Round Robin'}
                  </div>
                </div>
                <button style={s.smallButtonOutline} onClick={() => navigate(`/agency/offices/${o.id}`)}>CONFIGURE ROUTING →</button>
                <button style={s.resendButton} onClick={() => { const name = prompt('Rename office', o.name); if (name) renameOffice(o.id, name); }}>RENAME</button>
                <button style={s.deactivateButton} onClick={() => removeOffice(o.id)}>DELETE</button>
              </div>
            ))}
            {offices.length === 0 && <div style={s.hint}>No offices yet — add one above if your agency has more than one location.</div>}
          </>
        )}
      </section>

      <section style={s.section}>
        <div style={s.headerRow}>
          <h3 style={s.h3}>TEAM ({users.length})</h3>
          <button style={s.smallButton} onClick={() => setShowInvite(!showInvite)}>
            + INVITE PEOPLE
          </button>
        </div>
        {showInvite && (
          <form onSubmit={submitInvites} style={s.form}>
            {inviteRows.map((row, i) => (
              <div key={i} style={isMobile ? s.inviteRowStacked : s.inviteRow}>
                <input style={s.input} placeholder="First name" value={row.firstName} onChange={(e) => updateInviteRow(i, 'firstName', e.target.value)} required />
                <input style={s.input} placeholder="Last name" value={row.lastName} onChange={(e) => updateInviteRow(i, 'lastName', e.target.value)} required />
                <input style={s.input} type="email" placeholder="Email" value={row.email} onChange={(e) => updateInviteRow(i, 'email', e.target.value)} required />
                <select style={s.input} value={row.role} onChange={(e) => updateInviteRow(i, 'role', e.target.value)}>
                  <option value="PRODUCER">Producer</option>
                  <option value="AGENCY_MANAGER">Manager</option>
                </select>
                <button type="button" style={s.removeRowButton} onClick={() => removeInviteRow(i)} disabled={inviteRows.length <= 1} title="Remove this row">×</button>
              </div>
            ))}
            <div style={s.inviteFormActions}>
              <button type="button" style={s.addRowButton} onClick={addInviteRow} disabled={inviteRows.length >= 25}>+ ADD ANOTHER PERSON</button>
              <button style={s.submitButton} type="submit" disabled={inviteBusy}>{inviteBusy ? 'Sending…' : `Send ${inviteRows.length > 1 ? `${inviteRows.length} Invitations` : 'Invitation'}`}</button>
            </div>
          </form>
        )}
        {status && <div style={s.status}>{status}</div>}
        {inviteResults && (
          <div style={s.inviteResultsBox}>
            {inviteResults.map((r, i) => (
              <div key={i} style={s.inviteResultRow}>
                <span style={r.success ? s.inviteResultOk : s.inviteResultFail}>{r.success ? '✓' : '✗'}</span>
                <span>{r.email}</span>
                {!r.success && <span style={s.inviteResultMessage}>— {r.message}</span>}
                {r.success && r.emailStatus !== 'SENT' && (
                  <span style={s.inviteResultMessage}>— {emailStatusMessage('', r.emailStatus)}</span>
                )}
              </div>
            ))}
          </div>
        )}
        {users.map((u) => (
          <div key={u.id}>
            <div style={s.row} className="ui-row-stack">
              <div>
                <div style={s.rowTitle}>{u.firstName} {u.lastName}</div>
                <div style={s.rowSub}>{u.email} · {u.role}{u.office ? ` · ${u.office.name}` : ''}</div>
              </div>
              <div style={{ display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap' }}>
                <div style={s.badge}>{u.status}</div>
                {u.role === 'PRODUCER' && (
                  <>
                    <div style={s.flowScoreBadge(producerScores[u.id])}>
                      {producerScores[u.id] != null ? `${producerScores[u.id]}` : '—'}
                    </div>
                    <button style={s.resendButton} onClick={() => navigate(`/agency/producers/${u.id}`)}>VIEW SCORE</button>
                  </>
                )}
                <button style={s.resendButton} onClick={() => startEditUser(u)}>EDIT</button>
                {u.status === 'INVITED' && (
                  <button style={s.resendButton} onClick={() => resendUser(u.id)}>RESEND INVITE</button>
                )}
                {u.status === 'ACTIVE' && (
                  <button style={s.resendButton} onClick={() => sendReset(u.id)}>RESET PASSWORD</button>
                )}
                {u.status !== 'DEACTIVATED' && (
                  <button style={s.deactivateButton} onClick={() => deactivate(u.id)}>DEACTIVATE</button>
                )}
              </div>
            </div>
            {editingUserId === u.id && (
              <div style={s.inlineEditForm}>
                <input style={s.input} value={editUserForm.firstName} onChange={(e) => setEditUserForm({ ...editUserForm, firstName: e.target.value })} placeholder="First name" />
                <input style={s.input} value={editUserForm.lastName} onChange={(e) => setEditUserForm({ ...editUserForm, lastName: e.target.value })} placeholder="Last name" />
                {u.role === 'PRODUCER' && (
                  <select style={s.input} value={editUserForm.officeId} onChange={(e) => setEditUserForm({ ...editUserForm, officeId: e.target.value })}>
                    <option value="">No office</option>
                    {offices.map((o) => <option key={o.id} value={o.id}>{o.name}</option>)}
                  </select>
                )}
                <button style={s.smallButton} onClick={() => saveEditUser(u.id)}>SAVE</button>
                <button style={s.smallButtonOutline} onClick={() => setEditingUserId(null)}>CANCEL</button>
                {editUserError && <div style={s.editUserError}>{editUserError}</div>}
              </div>
            )}
          </div>
        ))}
      </section>

      <section style={s.section}>
        <div style={s.headerRow}>
          <h3 style={s.h3}>TELEMARKETERS ({telemarketers.length})</h3>
        </div>
        {telemarketers.length === 0 && <div style={s.hint}>No telemarketer currently assigned to this agency.</div>}
        {telemarketers.map((t) => (
          <div key={t.assignmentId} style={s.row} className="ui-row-stack">
            <div>
              <div style={s.rowTitle}>{t.firstName} {t.lastName}</div>
              <div style={s.rowSub}>{t.email}{t.assignedAt ? ` · assigned ${new Date(t.assignedAt).toLocaleDateString()}` : ''}</div>
            </div>
          </div>
        ))}
      </section>

      {showReport && (
        <div style={s.reportOverlay} onClick={() => setShowReport(false)}>
          <div style={s.reportModal} onClick={(e) => e.stopPropagation()}>
            <RunningReportPage scope="agency" agencyId={user?.agencyId} onClose={() => setShowReport(false)} />
          </div>
        </div>
      )}

      {showZipReport && (
        <div style={s.reportOverlay} onClick={() => setShowZipReport(false)}>
          <div style={s.reportModalWide} onClick={(e) => e.stopPropagation()}>
            <ZipReportPage agencyId={user?.agencyId} onClose={() => setShowZipReport(false)} />
          </div>
        </div>
      )}

      {showSettings && agency && (
        <AgencySettingsModal agency={agency} onClose={() => setShowSettings(false)} onSaved={() => { setShowSettings(false); load(); }} />
      )}

      <AnnouncementComposer
        open={showAnnounce}
        onClose={() => setShowAnnounce(false)}
        targets={[
          { value: 'team', label: 'Entire team' },
          { value: 'producer', label: 'Specific producer', picker: { field: 'targetUserId', placeholder: 'Select producer…', options: producers.map((p) => ({ id: p.id, label: `${p.firstName} ${p.lastName}` })) } },
        ]}
      />
    </div>
  );
}

const s = {
  wrap: { color: 'var(--text-primary)' },
  loadErrorBox: { background: 'var(--danger-soft)', border: '1px solid rgba(255, 77, 94, 0.4)', color: 'var(--danger)', padding: 16, borderRadius: 8, fontSize: 13, display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 12, marginBottom: 24 },
  editUserError: { color: 'var(--danger)', fontSize: 12, width: '100%', marginTop: 4 },
  hint: { color: 'var(--text-muted)', fontSize: 12, marginBottom: 10 },
  section: { marginBottom: 32 },
  settingsRow: { display: 'flex', justifyContent: 'flex-end', gap: 8, marginBottom: 8 },
  topSplit: { display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 20, alignItems: 'stretch' },
  topStacked: { display: 'flex', flexDirection: 'column', gap: 20 },
  inlineEditForm: { display: 'flex', gap: 8, alignItems: 'center', padding: '8px 14px', background: 'var(--bg-sunken)', border: '1px solid var(--border-hairline)', borderRadius: 8, marginTop: -4, marginBottom: 8 },
  flowScoreBadge: (score) => ({
    display: 'flex', alignItems: 'center', justifyContent: 'center', minWidth: 32, height: 22, padding: '0 6px',
    borderRadius: 11, fontSize: 11, fontWeight: 700,
    background: score == null ? 'var(--bg-sunken)' : 'var(--accent-gradient-soft)',
    color: score == null ? 'var(--text-muted)' : 'var(--accent)',
    border: '1px solid ' + (score == null ? 'var(--border-hairline)' : 'var(--border-accent)'),
  }),
  headerRow: { display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 12 },
  h3: { color: 'var(--text-secondary)', fontSize: 12, letterSpacing: 2 },
  smallButton: { padding: '8px 14px', background: 'var(--accent)', border: 'none', borderRadius: 6, fontWeight: 700, cursor: 'pointer', fontSize: 12 },
  smallButtonOutline: { padding: '8px 14px', background: 'transparent', border: '1px solid var(--border-strong)', color: 'var(--text-secondary)', borderRadius: 6, fontWeight: 700, cursor: 'pointer', fontSize: 12 },
  form: { display: 'flex', flexDirection: 'column', gap: 10, background: 'var(--bg-elevated)', padding: 16, borderRadius: 8, marginBottom: 12, border: '1px solid var(--border-hairline)' },
  input: { padding: '10px 12px', background: 'var(--bg-sunken)', border: '1px solid var(--border-strong)', borderRadius: 6, color: 'var(--text-primary)' },
  submitButton: { padding: '10px 16px', background: 'var(--accent)', border: 'none', borderRadius: 6, fontWeight: 700, cursor: 'pointer' },
  inviteRow: { display: 'grid', gridTemplateColumns: '1fr 1fr 1.4fr 130px 28px', gap: 8, alignItems: 'center' },
  inviteRowStacked: { display: 'flex', flexDirection: 'column', gap: 8, paddingBottom: 10, borderBottom: '1px solid var(--border-hairline)' },
  removeRowButton: { width: 28, height: 36, background: 'var(--bg-sunken)', border: '1px solid var(--border-strong)', borderRadius: 6, color: 'var(--text-secondary)', cursor: 'pointer', fontSize: 16, lineHeight: 1 },
  inviteFormActions: { display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginTop: 4, flexWrap: 'wrap', gap: 10 },
  addRowButton: { padding: '8px 12px', background: 'transparent', border: '1px dashed var(--border-strong)', borderRadius: 6, color: 'var(--text-secondary)', cursor: 'pointer', fontSize: 12, fontWeight: 600 },
  inviteResultsBox: { display: 'flex', flexDirection: 'column', gap: 6, marginBottom: 12, background: 'var(--bg-elevated)', border: '1px solid var(--border-hairline)', borderRadius: 8, padding: 12 },
  inviteResultRow: { display: 'flex', alignItems: 'center', gap: 8, fontSize: 13, flexWrap: 'wrap' },
  inviteResultOk: { color: 'var(--accent)', fontWeight: 700 },
  inviteResultFail: { color: 'var(--danger)', fontWeight: 700 },
  inviteResultMessage: { color: 'var(--text-muted)', fontSize: 12 },
  status: { color: 'var(--accent)', marginBottom: 12, fontSize: 13 },
  linkBox: { color: 'var(--text-secondary)', fontSize: 13, marginBottom: 12, background: 'var(--bg-elevated)', border: '1px solid var(--border-hairline)', borderRadius: 8, padding: 12 },
  link: { color: 'var(--accent)', wordBreak: 'break-all' },
  row: { display: 'flex', justifyContent: 'space-between', alignItems: 'center', background: 'var(--bg-elevated)', border: '1px solid var(--border-hairline)', borderRadius: 8, padding: 14, marginBottom: 8 },
  rowTitle: { fontWeight: 600, fontSize: 14 },
  rowSub: { color: 'var(--text-muted)', fontSize: 12 },
  badge: { fontSize: 11, color: 'var(--text-secondary)', border: '1px solid var(--border-strong)', padding: '4px 8px', borderRadius: 4 },
  deactivateButton: { fontSize: 10, color: 'var(--danger)', border: '1px solid rgba(255, 77, 94, 0.4)', background: 'none', padding: '4px 8px', borderRadius: 4, cursor: 'pointer' },
  resendButton: { fontSize: 10, color: 'var(--accent)', border: '1px solid var(--border-strong)', background: 'none', padding: '4px 8px', borderRadius: 4, cursor: 'pointer' },
  empty: { color: 'var(--text-muted)', fontStyle: 'italic' },
  reportOverlay: { position: 'fixed', top: 0, left: 0, right: 0, bottom: 0, background: 'rgba(0,0,0,0.75)', display: 'flex', alignItems: 'center', justifyContent: 'center', zIndex: 2500, padding: 20, overflowY: 'auto' },
  reportModal: { background: 'var(--bg-sunken)', border: '1px solid var(--border-strong)', borderRadius: 12, maxWidth: 680, width: '100%', maxHeight: '85vh', overflowY: 'auto' },
  reportModalWide: { background: 'var(--bg-sunken)', border: '1px solid var(--border-strong)', borderRadius: 12, maxWidth: 1080, width: '100%', maxHeight: '85vh', overflowY: 'auto' },
};
