import { useEffect, useRef, useState } from 'react';
import { useSearchParams, useNavigate } from 'react-router-dom';
import { api } from '../lib/api';
import { useAuth } from '../lib/AuthContext';
import { useIsMobile } from '../lib/useViewport';
import { Button, EdSuggestionBox, LeadTypeIcon } from '../ui';
import FlowScoreCard from './FlowScoreCard';
import LeadsSnapshotBox from './LeadsSnapshotBox';
import ZipCodeBox from './ZipCodeBox';
import ZipReportPage from './ZipReportPage';
import FunnelMetricsCard from './FunnelMetricsCard';
import LeadDetailModal from './LeadDetailModal';
import RunningReportPage from './RunningReportPage';
import AgencySettingsModal from './AgencySettingsModal';
import PerformanceLeaderboards from './PerformanceLeaderboards';
import BulkLeadUploadBox from './BulkLeadUploadBox';
import TeamClockStatusBox from './TeamClockStatusBox';
import AnnouncementComposer from './AnnouncementComposer';

export default function AgencyOwnerDashboard() {
  const { user } = useAuth();
  const isMobile = useIsMobile();
  const navigate = useNavigate();
  const [searchParams, setSearchParams] = useSearchParams();
  const [leads, setLeads] = useState([]);
  const [users, setUsers] = useState([]);
  const [openLeadId, setOpenLeadId] = useState(null);
  const [showInvite, setShowInvite] = useState(false);
  const [showAddLead, setShowAddLead] = useState(false);
  const [showUpload, setShowUpload] = useState(false);
  const [form, setForm] = useState({ email: '', firstName: '', lastName: '', role: 'PRODUCER' });
  const [leadForm, setLeadForm] = useState({ firstName: '', lastName: '', phone: '', email: '', product: 'Auto', assignedToId: '' });
  const [status, setStatus] = useState('');
  const [inviteLink, setInviteLink] = useState('');
  const [leadStatus, setLeadStatus] = useState('');
  const [showReport, setShowReport] = useState(false);
  const [showZipReport, setShowZipReport] = useState(false);
  const [showSettings, setShowSettings] = useState(false);
  const [showAnnounce, setShowAnnounce] = useState(false);
  const [agency, setAgency] = useState(null);
  const [editingUserId, setEditingUserId] = useState(null);
  const [editUserForm, setEditUserForm] = useState({ firstName: '', lastName: '' });
  const [editUserError, setEditUserError] = useState('');
  const [loadError, setLoadError] = useState('');
  const [producerScores, setProducerScores] = useState({});

  // The funnel drill-down's filter lives in the URL (not component state)
  // so it's shareable and survives the back button.
  const stage = searchParams.get('stage');
  const from = searchParams.get('from');
  const to = searchParams.get('to');
  const stageFilter = stage && from && to ? { stage, from, to } : null;
  const highlightId = searchParams.get('highlight');
  const handledHighlightRef = useRef(false);

  useEffect(() => {
    load();
  }, [stage, from, to]);

  // Destination side of notification deep-linking: scroll to and highlight
  // whichever lead a "new lead" notification pointed at.
  useEffect(() => {
    if (!highlightId || handledHighlightRef.current || leads.length === 0) return;
    if (!leads.some((l) => l.id === highlightId)) return;
    handledHighlightRef.current = true;
    document.getElementById(`lead-${highlightId}`)?.scrollIntoView({ behavior: 'smooth', block: 'center' });
  }, [highlightId, leads]);

  async function load() {
    setLoadError('');
    const leadParams = stageFilter
      ? `?stage=${stageFilter.stage}&from=${stageFilter.from}&to=${stageFilter.to}`
      : '';
    try {
      const [leadData, userData, agencyData] = await Promise.all([api.leads(leadParams), api.users(''), api.agencyDetail(user.agencyId)]);
      setLeads(leadData.leads);
      setUsers(userData.users);
      setAgency(agencyData.agency);
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
    setEditUserForm({ firstName: u.firstName, lastName: u.lastName });
  }

  async function saveEditUser(userId) {
    setEditUserError('');
    try {
      await api.updateUser(userId, editUserForm);
      setEditingUserId(null);
      await load();
    } catch (err) {
      setEditUserError(err.data?.message || 'Failed to save.');
    }
  }

  function selectFunnelStage(stageKey, range) {
    setSearchParams({ stage: stageKey, from: range.from, to: range.to });
  }

  function clearStageFilter() {
    setSearchParams({});
  }

  async function resendUser(userId) {
    setStatus('Resending…');
    setInviteLink('');
    try {
      const res = await api.resendUserInvite(userId);
      setStatus(`Invitation resent. Email status: ${res.emailStatus}`);
      if (res.emailStatus !== 'SENT' && res.acceptUrl) {
        setInviteLink(res.acceptUrl);
      }
    } catch (err) {
      setStatus(err.data?.message || 'Failed to resend invitation.');
    }
  }

  async function invite(e) {
    e.preventDefault();
    setStatus('Sending invitation…');
    setInviteLink('');
    try {
      const res = await api.inviteUser(form);
      setStatus(`Invited. Email status: ${res.emailStatus}`);
      if (res.emailStatus !== 'SENT' && res.acceptUrl) {
        setInviteLink(res.acceptUrl);
      }
      setForm({ email: '', firstName: '', lastName: '', role: 'PRODUCER' });
      setShowInvite(false);
      await load();
    } catch (err) {
      setStatus(err.data?.message || 'Failed to invite.');
    }
  }

  async function deactivate(userId) {
    if (!confirm('Deactivate this user? Their history and attribution stay intact, but they will not be able to log in.')) return;
    await api.deactivateUser(userId);
    await load();
  }

  async function sendReset(userId) {
    setStatus('Sending password reset…');
    setInviteLink('');
    try {
      const res = await api.sendPasswordReset(userId);
      setStatus(`Password reset sent. Email status: ${res.emailStatus}`);
      if (res.emailStatus !== 'SENT' && res.resetUrl) {
        setInviteLink(res.resetUrl);
      }
    } catch (err) {
      setStatus(err.data?.message || 'Failed to send password reset.');
    }
  }

  async function addLead(e) {
    e.preventDefault();
    setLeadStatus('Creating…');
    try {
      await api.createLead(leadForm);
      setLeadStatus('Lead created.');
      setLeadForm({ firstName: '', lastName: '', phone: '', email: '', product: 'Auto', assignedToId: '' });
      setShowAddLead(false);
      await load();
    } catch (err) {
      setLeadStatus(err.data?.message || 'Failed to create lead.');
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
          <h3 style={s.h3}>TEAM ({users.length})</h3>
          <button style={s.smallButton} onClick={() => setShowInvite(!showInvite)}>
            + INVITE PRODUCER
          </button>
        </div>
        {showInvite && (
          <form onSubmit={invite} style={s.form}>
            <input style={s.input} placeholder="First name" value={form.firstName} onChange={(e) => setForm({ ...form, firstName: e.target.value })} required />
            <input style={s.input} placeholder="Last name" value={form.lastName} onChange={(e) => setForm({ ...form, lastName: e.target.value })} required />
            <input style={s.input} type="email" placeholder="Email" value={form.email} onChange={(e) => setForm({ ...form, email: e.target.value })} required />
            <select style={s.input} value={form.role} onChange={(e) => setForm({ ...form, role: e.target.value })}>
              <option value="PRODUCER">Producer</option>
              <option value="AGENCY_MANAGER">Manager</option>
            </select>
            <button style={s.submitButton} type="submit">Send Invitation</button>
          </form>
        )}
        {status && <div style={s.status}>{status}</div>}
        {inviteLink && (
          <div style={s.linkBox}>
            Email wasn't sent — share this activation link directly:
            <br />
            <a style={s.link} href={inviteLink} target="_blank" rel="noreferrer">{inviteLink}</a>
          </div>
        )}
        {users.map((u) => (
          <div key={u.id}>
            <div style={s.row} className="ui-row-stack">
              <div>
                <div style={s.rowTitle}>{u.firstName} {u.lastName}</div>
                <div style={s.rowSub}>{u.email} · {u.role}</div>
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
          <h3 style={s.h3}>LEADS ({leads.length}){stageFilter ? ` · ${stageFilter.stage.toUpperCase()}` : ''}</h3>
          <div style={{ display: 'flex', gap: 8 }}>
            {stageFilter && (
              <button style={s.smallButtonOutline} onClick={clearStageFilter}>CLEAR FILTER</button>
            )}
            <button style={s.smallButtonOutline} onClick={() => setShowUpload(!showUpload)}>UPLOAD LEADS</button>
            <button style={s.smallButton} onClick={() => setShowAddLead(!showAddLead)}>+ ADD LEAD</button>
          </div>
        </div>
        {showUpload && (
          <BulkLeadUploadBox agencyId={user?.agencyId} onImported={load} />
        )}
        {showAddLead && (
          <form onSubmit={addLead} style={s.form}>
            <input style={s.input} placeholder="First name" value={leadForm.firstName} onChange={(e) => setLeadForm({ ...leadForm, firstName: e.target.value })} required />
            <input style={s.input} placeholder="Last name" value={leadForm.lastName} onChange={(e) => setLeadForm({ ...leadForm, lastName: e.target.value })} required />
            <input style={s.input} placeholder="Phone" value={leadForm.phone} onChange={(e) => setLeadForm({ ...leadForm, phone: e.target.value })} />
            <input style={s.input} type="email" placeholder="Email (optional)" value={leadForm.email} onChange={(e) => setLeadForm({ ...leadForm, email: e.target.value })} />
            <select style={s.input} value={leadForm.product} onChange={(e) => setLeadForm({ ...leadForm, product: e.target.value })}>
              <option>Auto</option><option>Home</option><option>Life</option><option>Health</option>
            </select>
            <select style={s.input} value={leadForm.assignedToId} onChange={(e) => setLeadForm({ ...leadForm, assignedToId: e.target.value })}>
              <option value="">Unassigned</option>
              {producers.map((p) => <option key={p.id} value={p.id}>{p.firstName} {p.lastName}</option>)}
            </select>
            <button style={s.submitButton} type="submit">Create Lead</button>
          </form>
        )}
        {leadStatus && <div style={s.status}>{leadStatus}</div>}
        {leads.map((l) => (
          <div
            key={l.id}
            id={`lead-${l.id}`}
            style={l.id === highlightId ? { ...s.row, ...s.rowHighlighted } : s.row}
            className="ui-row-stack"
            onClick={() => setOpenLeadId(l.id)}
          >
            <div>
              <div style={{ ...s.rowTitle, cursor: 'pointer', textDecoration: 'underline' }}>
                <LeadTypeIcon type={l.leadType} style={{ marginRight: 6, textDecoration: 'none' }} />
                {l.customer ? `${l.customer.firstName} ${l.customer.lastName}` : 'Lead'}
              </div>
              <div style={s.rowSub}>{l.product || l.source} · {l.assignedTo ? `${l.assignedTo.firstName} ${l.assignedTo.lastName}` : 'Unassigned'}</div>
            </div>
            <div style={s.badge}>{l.status}</div>
          </div>
        ))}
        {leads.length === 0 && <div style={s.empty}>No leads yet.</div>}
      </section>

      {openLeadId && (
        <LeadDetailModal leadId={openLeadId} onClose={() => setOpenLeadId(null)} onChanged={load} />
      )}

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
  rowHighlighted: { outline: '2px solid var(--accent)', boxShadow: 'var(--shadow-glow-accent)', borderRadius: 'var(--radius-md)' },
  smallButton: { padding: '8px 14px', background: 'var(--accent)', border: 'none', borderRadius: 6, fontWeight: 700, cursor: 'pointer', fontSize: 12 },
  smallButtonOutline: { padding: '8px 14px', background: 'transparent', border: '1px solid var(--border-strong)', color: 'var(--text-secondary)', borderRadius: 6, fontWeight: 700, cursor: 'pointer', fontSize: 12 },
  form: { display: 'flex', flexDirection: 'column', gap: 10, background: 'var(--bg-elevated)', padding: 16, borderRadius: 8, marginBottom: 12, border: '1px solid var(--border-hairline)' },
  input: { padding: '10px 12px', background: 'var(--bg-sunken)', border: '1px solid var(--border-strong)', borderRadius: 6, color: 'var(--text-primary)' },
  submitButton: { padding: '10px', background: 'var(--accent)', border: 'none', borderRadius: 6, fontWeight: 700, cursor: 'pointer' },
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
