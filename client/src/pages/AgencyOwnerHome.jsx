import { useEffect, useState } from 'react';
import { api } from '../lib/api';
import { useAuth } from '../lib/AuthContext';
import FlowScoreCard from './FlowScoreCard';
import FunnelMetricsCard from './FunnelMetricsCard';
import TransfersPanel from './TransfersPanel';
import VendorsPanel from './VendorsPanel';
import FinancialsPanel from './FinancialsPanel';
import AgencySettingsPanel from './AgencySettingsPanel';
import SupportPanel from './SupportPanel';
import CallsPanel from './CallsPanel';
import AgencyBillingPanel from './AgencyBillingPanel';
import CoursesAdminPanel from './CoursesAdminPanel';
import OpportunitiesPanel from './OpportunitiesPanel';
import GoalsPanel from './GoalsPanel';
import Customer360Modal from './Customer360Modal';

export default function AgencyOwnerHome() {
  const { user } = useAuth();
  const [tab, setTab] = useState('team');
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

  useEffect(() => {
    load();
  }, []);

  async function load() {
    const [leadData, userData] = await Promise.all([api.leads(''), api.users('')]);
    setLeads(leadData.leads);
    setUsers(userData.users);
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
      <div style={s.tabRow}>
        <button style={s.tab(tab === 'team')} onClick={() => setTab('team')}>TEAM & LEADS</button>
        <button style={s.tab(tab === 'transfers')} onClick={() => setTab('transfers')}>YIELD TRANSFERS</button>
        <button style={s.tab(tab === 'vendors')} onClick={() => setTab('vendors')}>VENDORS</button>
        <button style={s.tab(tab === 'financials')} onClick={() => setTab('financials')}>FINANCIALS</button>
        <button style={s.tab(tab === 'settings')} onClick={() => setTab('settings')}>SETTINGS</button>
        <button style={s.tab(tab === 'support')} onClick={() => setTab('support')}>SUPPORT</button>
        <button style={s.tab(tab === 'coaching')} onClick={() => setTab('coaching')}>COACHING</button>
        <button style={s.tab(tab === 'billing')} onClick={() => setTab('billing')}>BILLING</button>
        <button style={s.tab(tab === 'training')} onClick={() => setTab('training')}>TRAINING</button>
        <button style={s.tab(tab === 'opportunities')} onClick={() => setTab('opportunities')}>WINBACKS & CROSS-SELLS</button>
        <button style={s.tab(tab === 'goals')} onClick={() => setTab('goals')}>GOALS</button>
      </div>

      {tab === 'transfers' ? (
        <TransfersPanel />
      ) : tab === 'vendors' ? (
        <VendorsPanel />
      ) : tab === 'financials' ? (
        <FinancialsPanel />
      ) : tab === 'settings' ? (
        <AgencySettingsPanel />
      ) : tab === 'support' ? (
        <SupportPanel />
      ) : tab === 'coaching' ? (
        <CallsPanel />
      ) : tab === 'billing' ? (
        <AgencyBillingPanel />
      ) : tab === 'training' ? (
        <CoursesAdminPanel />
      ) : tab === 'opportunities' ? (
        <OpportunitiesPanel />
      ) : tab === 'goals' ? (
        <GoalsPanel />
      ) : (
        <>
          <section style={s.section}>
            <FlowScoreCard scope="agency" agencyId={user?.agencyId} title="AGENCY FLOW SCORE" />
          </section>

          <section style={s.section}>
            <FunnelMetricsCard scope="agency" title="AGENCY FUNNEL" />
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
              <div key={u.id} style={s.row}>
                <div>
                  <div style={s.rowTitle}>{u.firstName} {u.lastName}</div>
                  <div style={s.rowSub}>{u.email} · {u.role}</div>
                </div>
                <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                  <div style={s.badge}>{u.status}</div>
                  {u.status === 'INVITED' && (
                    <button style={s.resendButton} onClick={() => resendUser(u.id)}>RESEND INVITE</button>
                  )}
                  {u.status !== 'DEACTIVATED' && (
                    <button style={s.deactivateButton} onClick={() => deactivate(u.id)}>DEACTIVATE</button>
                  )}
                </div>
              </div>
            ))}
          </section>

          <section style={s.section}>
            <div style={s.headerRow}>
              <h3 style={s.h3}>LEADS ({leads.length})</h3>
              <button style={s.smallButton} onClick={() => setShowAddLead(!showAddLead)}>+ ADD LEAD</button>
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
              <div key={l.id} style={s.row} onClick={() => l.customer && setSelectedCustomerId(l.customerId)}>
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
        </>
      )}

      {selectedCustomerId && (
        <Customer360Modal customerId={selectedCustomerId} onClose={() => setSelectedCustomerId(null)} />
      )}
    </div>
  );
}

const s = {
  wrap: { color: '#fff', maxWidth: 720, margin: '0 auto', padding: 24 },
  tabRow: { display: 'flex', gap: 8, marginBottom: 20, flexWrap: 'wrap' },
  tab: (active) => ({
    padding: '8px 16px', borderRadius: 6, border: '1px solid #333', cursor: 'pointer', fontSize: 12, fontWeight: 700,
    background: active ? '#00e5ff' : 'transparent', color: active ? '#000' : '#aaa',
  }),
  section: { marginBottom: 32 },
  headerRow: { display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 12 },
  h3: { color: '#888', fontSize: 12, letterSpacing: 2 },
  smallButton: { padding: '8px 14px', background: '#00e5ff', border: 'none', borderRadius: 6, fontWeight: 700, cursor: 'pointer', fontSize: 12 },
  form: { display: 'flex', flexDirection: 'column', gap: 10, background: '#111', padding: 16, borderRadius: 8, marginBottom: 12, border: '1px solid #222' },
  input: { padding: '10px 12px', background: '#000', border: '1px solid #333', borderRadius: 6, color: '#fff' },
  submitButton: { padding: '10px', background: '#00e5ff', border: 'none', borderRadius: 6, fontWeight: 700, cursor: 'pointer' },
  status: { color: '#00e5ff', marginBottom: 12, fontSize: 13 },
  linkBox: { color: '#aaa', fontSize: 13, marginBottom: 12, background: '#111', border: '1px solid #222', borderRadius: 8, padding: 12 },
  link: { color: '#00e5ff', wordBreak: 'break-all' },
  row: { display: 'flex', justifyContent: 'space-between', alignItems: 'center', background: '#111', border: '1px solid #1a1a1a', borderRadius: 8, padding: 14, marginBottom: 8 },
  rowTitle: { fontWeight: 600, fontSize: 14 },
  rowSub: { color: '#666', fontSize: 12 },
  badge: { fontSize: 11, color: '#888', border: '1px solid #333', padding: '4px 8px', borderRadius: 4 },
  deactivateButton: { fontSize: 10, color: '#ff4d4d', border: '1px solid #ff4d4d44', background: 'none', padding: '4px 8px', borderRadius: 4, cursor: 'pointer' },
  resendButton: { fontSize: 10, color: '#00e5ff', border: '1px solid #333', background: 'none', padding: '4px 8px', borderRadius: 4, cursor: 'pointer' },
  empty: { color: '#666', fontStyle: 'italic' },
};
