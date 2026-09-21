import { useEffect, useRef, useState } from 'react';
import { useSearchParams } from 'react-router-dom';
import { api } from '../lib/api';
import { useAuth } from '../lib/AuthContext';
import { Button, Modal, ProgressRing } from '../ui';
import FlowScoreCard from './FlowScoreCard';
import FunnelMetricsCard from './FunnelMetricsCard';
import Customer360Modal from './Customer360Modal';
import RunningReportPage from './RunningReportPage';
import AgencySettingsModal from './AgencySettingsModal';

export default function AgencyOwnerDashboard() {
  const { user } = useAuth();
  const [searchParams, setSearchParams] = useSearchParams();
  const [leads, setLeads] = useState([]);
  const [users, setUsers] = useState([]);
  const [selectedCustomerId, setSelectedCustomerId] = useState(null);
  const [showInvite, setShowInvite] = useState(false);
  const [showAddLead, setShowAddLead] = useState(false);
  const [form, setForm] = useState({ email: '', firstName: '', lastName: '', role: 'PRODUCER' });
  const [leadForm, setLeadForm] = useState({ firstName: '', lastName: '', phone: '', email: '', product: 'Auto', assignedToId: '' });
  const [status, setStatus] = useState('');
  const [inviteLink, setInviteLink] = useState('');
  const [leadStatus, setLeadStatus] = useState('');
  const [showReport, setShowReport] = useState(false);
  const [showSettings, setShowSettings] = useState(false);
  const [agency, setAgency] = useState(null);
  const [editingUserId, setEditingUserId] = useState(null);
  const [editUserForm, setEditUserForm] = useState({ firstName: '', lastName: '' });
  const [scoreUser, setScoreUser] = useState(null);
  const [scoreData, setScoreData] = useState(null);

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
    const leadParams = stageFilter
      ? `?stage=${stageFilter.stage}&from=${stageFilter.from}&to=${stageFilter.to}`
      : '';
    const [leadData, userData, agencyData] = await Promise.all([api.leads(leadParams), api.users(''), api.agencyDetail(user.agencyId)]);
    setLeads(leadData.leads);
    setUsers(userData.users);
    setAgency(agencyData.agency);
  }

  function startEditUser(u) {
    setEditingUserId(u.id);
    setEditUserForm({ firstName: u.firstName, lastName: u.lastName });
  }

  async function saveEditUser(userId) {
    try {
      await api.updateUser(userId, editUserForm);
      setEditingUserId(null);
      await load();
    } catch (err) {
      alert(err.data?.message || 'Failed to save.');
    }
  }

  // Producer Flow Score drill-down — userFlowScore/flowScoreHistory were
  // fully functional server-side but never called from any page before
  // this; there was no way to see an individual producer's trend, only
  // the aggregate agency score.
  async function viewProducerScore(u) {
    setScoreUser(u);
    setScoreData(null);
    const [scoreRes, historyRes] = await Promise.all([
      api.userFlowScore(u.id),
      api.flowScoreHistory('USER', u.id),
    ]);
    setScoreData({ snapshot: scoreRes.snapshot, history: historyRes.snapshots });
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
      <section style={s.section}>
        <div style={s.settingsRow}>
          <Button variant="secondary" size="sm" onClick={() => setShowSettings(true)}>AGENCY SETTINGS</Button>
        </div>
        <FlowScoreCard scope="agency" agencyId={user?.agencyId} title="AGENCY FLOW SCORE" onViewReport={() => setShowReport(true)} />
      </section>

      <section style={s.section}>
        <FunnelMetricsCard scope="agency" title="AGENCY FUNNEL" onSelectStage={selectFunnelStage} />
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
                  <button style={s.resendButton} onClick={() => viewProducerScore(u)}>VIEW SCORE</button>
                )}
                <button style={s.resendButton} onClick={() => startEditUser(u)}>EDIT</button>
                {u.status === 'INVITED' && (
                  <button style={s.resendButton} onClick={() => resendUser(u.id)}>RESEND INVITE</button>
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
            <button style={s.smallButton} onClick={() => setShowAddLead(!showAddLead)}>+ ADD LEAD</button>
          </div>
        </div>
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
            onClick={() => l.customer && setSelectedCustomerId(l.customerId)}
          >
            <div>
              <div style={{ ...s.rowTitle, cursor: l.customer ? 'pointer' : 'default', textDecoration: l.customer ? 'underline' : 'none' }}>
                {l.customer ? `${l.customer.firstName} ${l.customer.lastName}` : 'Lead'}
              </div>
              <div style={s.rowSub}>{l.product || l.source} · {l.assignedTo ? `${l.assignedTo.firstName} ${l.assignedTo.lastName}` : 'Unassigned'}</div>
            </div>
            <div style={s.badge}>{l.status}</div>
          </div>
        ))}
        {leads.length === 0 && <div style={s.empty}>No leads yet.</div>}
      </section>

      {selectedCustomerId && (
        <Customer360Modal customerId={selectedCustomerId} onClose={() => setSelectedCustomerId(null)} />
      )}

      {showReport && (
        <div style={s.reportOverlay} onClick={() => setShowReport(false)}>
          <div style={s.reportModal} onClick={(e) => e.stopPropagation()}>
            <RunningReportPage scope="agency" agencyId={user?.agencyId} onClose={() => setShowReport(false)} />
          </div>
        </div>
      )}

      {showSettings && agency && (
        <AgencySettingsModal agency={agency} onClose={() => setShowSettings(false)} onSaved={() => { setShowSettings(false); load(); }} />
      )}

      {scoreUser && (
        <Modal title={`FLOW SCORE — ${scoreUser.firstName} ${scoreUser.lastName}`} onClose={() => { setScoreUser(null); setScoreData(null); }}>
          {!scoreData ? (
            <div style={{ color: 'var(--text-muted)' }}>Loading…</div>
          ) : !scoreData.snapshot ? (
            <div style={{ color: 'var(--text-muted)', fontStyle: 'italic' }}>Not enough activity yet to compute a Flow Score.</div>
          ) : (
            <>
              <div style={{ display: 'flex', justifyContent: 'center', marginBottom: 16 }}>
                <ProgressRing value={scoreData.snapshot.score} label="/ 100" size={110} />
              </div>
              {scoreData.history.length > 1 && (
                <div style={s.trendRow}>
                  {scoreData.history.slice().reverse().map((snap) => (
                    <div key={snap.id} style={s.trendBar(snap.score)} title={`${snap.score} on ${new Date(snap.computedAt).toLocaleDateString()}`} />
                  ))}
                </div>
              )}
            </>
          )}
        </Modal>
      )}
    </div>
  );
}

const s = {
  wrap: { color: 'var(--text-primary)' },
  section: { marginBottom: 32 },
  settingsRow: { display: 'flex', justifyContent: 'flex-end', marginBottom: 8 },
  inlineEditForm: { display: 'flex', gap: 8, alignItems: 'center', padding: '8px 14px', background: 'var(--bg-sunken)', border: '1px solid var(--border-hairline)', borderRadius: 8, marginTop: -4, marginBottom: 8 },
  trendRow: { display: 'flex', gap: 4, alignItems: 'flex-end', height: 40, justifyContent: 'center' },
  trendBar: (score) => ({ width: 10, height: `${Math.max(4, score) / 100 * 40}px`, background: 'var(--border-accent)', borderRadius: 2 }),
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
};
