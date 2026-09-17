import { useEffect, useState } from 'react';
import { api } from '../lib/api';
import TelemarketersPanel from './TelemarketersPanel';
import FinancialsPanel from './FinancialsPanel';
import SupportPanel from './SupportPanel';
import CreditRequestsPanel from './CreditRequestsPanel';
import BillingPanel from './BillingPanel';
import CoursesAdminPanel from './CoursesAdminPanel';

export default function PlatformOwnerHome() {
  const [tab, setTab] = useState('agencies');
  const [agencies, setAgencies] = useState([]);
  const [showForm, setShowForm] = useState(false);
  const [form, setForm] = useState({ name: '', ownerFirstName: '', ownerLastName: '', ownerEmail: '' });
  const [status, setStatus] = useState('');
  const [inviteLink, setInviteLink] = useState('');

  useEffect(() => {
    refresh();
  }, []);

  async function refresh() {
    const data = await api.agencies();
    setAgencies(data.agencies);
  }

  async function submit(e) {
    e.preventDefault();
    setStatus('Creating…');
    setInviteLink('');
    try {
      const res = await api.createAgency(form);
      setStatus(`Agency created. Invitation email: ${res.invitation.emailStatus}`);
      if (res.invitation.emailStatus !== 'SENT' && res.invitation.acceptUrl) {
        setInviteLink(res.invitation.acceptUrl);
      }
      setForm({ name: '', ownerFirstName: '', ownerLastName: '', ownerEmail: '' });
      setShowForm(false);
      await refresh();
    } catch (err) {
      setStatus(err.data?.message || 'Failed to create agency.');
    }
  }

  return (
    <div style={s.wrap}>
      <div style={s.tabRow}>
        <button style={s.tab(tab === 'agencies')} onClick={() => setTab('agencies')}>AGENCIES</button>
        <button style={s.tab(tab === 'tms')} onClick={() => setTab('tms')}>TELEMARKETERS</button>
        <button style={s.tab(tab === 'financials')} onClick={() => setTab('financials')}>FINANCIALS</button>
        <button style={s.tab(tab === 'credits')} onClick={() => setTab('credits')}>CREDIT REQUESTS</button>
        <button style={s.tab(tab === 'support')} onClick={() => setTab('support')}>SUPPORT</button>
        <button style={s.tab(tab === 'billing')} onClick={() => setTab('billing')}>BILLING</button>
        <button style={s.tab(tab === 'training')} onClick={() => setTab('training')}>TRAINING</button>
      </div>

      {tab === 'tms' ? (
        <TelemarketersPanel />
      ) : tab === 'financials' ? (
        <FinancialsPanel />
      ) : tab === 'credits' ? (
        <CreditRequestsPanel />
      ) : tab === 'support' ? (
        <SupportPanel />
      ) : tab === 'billing' ? (
        <BillingPanel />
      ) : tab === 'training' ? (
        <CoursesAdminPanel />
      ) : (
        <>
          <div style={s.headerRow}>
            <h2 style={s.h2}>Agencies ({agencies.length})</h2>
            <button style={s.button} onClick={() => setShowForm(!showForm)}>
              + INVITE AGENCY
            </button>
          </div>

          {showForm && (
            <form onSubmit={submit} style={s.form}>
              <input style={s.input} placeholder="Agency name" value={form.name} onChange={(e) => setForm({ ...form, name: e.target.value })} required />
              <input style={s.input} placeholder="Owner first name" value={form.ownerFirstName} onChange={(e) => setForm({ ...form, ownerFirstName: e.target.value })} required />
              <input style={s.input} placeholder="Owner last name" value={form.ownerLastName} onChange={(e) => setForm({ ...form, ownerLastName: e.target.value })} required />
              <input style={s.input} type="email" placeholder="Owner email" value={form.ownerEmail} onChange={(e) => setForm({ ...form, ownerEmail: e.target.value })} required />
              <button style={s.submitButton} type="submit">
                Send Invitation
              </button>
            </form>
          )}
          {status && <div style={s.status}>{status}</div>}
          {inviteLink && (
            <div style={s.linkBox}>
              Email wasn't sent — share this activation link with the agency owner directly:
              <br />
              <a style={s.link} href={inviteLink} target="_blank" rel="noreferrer">{inviteLink}</a>
            </div>
          )}

          <div style={s.list}>
            {agencies.map((a) => (
              <div key={a.id} style={s.row}>
                <div>
                  <div style={s.rowTitle}>{a.name}</div>
                  <div style={s.rowSub}>{a.status}</div>
                </div>
                <div style={s.statusBadge}>{a.status}</div>
              </div>
            ))}
            {agencies.length === 0 && <div style={s.empty}>EvenFlow is ready. Invite your first agency.</div>}
          </div>
        </>
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
  headerRow: { display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 20 },
  h2: { fontWeight: 400 },
  button: { padding: '10px 18px', background: '#00e5ff', border: 'none', borderRadius: 6, fontWeight: 700, cursor: 'pointer' },
  form: { display: 'flex', flexDirection: 'column', gap: 10, background: '#111', padding: 20, borderRadius: 8, marginBottom: 16, border: '1px solid #222' },
  input: { padding: '10px 12px', background: '#000', border: '1px solid #333', borderRadius: 6, color: '#fff' },
  submitButton: { padding: '10px', background: '#00e5ff', border: 'none', borderRadius: 6, fontWeight: 700, cursor: 'pointer' },
  status: { color: '#00e5ff', marginBottom: 16, fontSize: 13 },
  linkBox: { color: '#aaa', fontSize: 13, marginBottom: 16, background: '#111', border: '1px solid #222', borderRadius: 8, padding: 12 },
  link: { color: '#00e5ff', wordBreak: 'break-all' },
  list: { display: 'flex', flexDirection: 'column', gap: 8 },
  row: { display: 'flex', justifyContent: 'space-between', alignItems: 'center', background: '#111', border: '1px solid #1a1a1a', borderRadius: 8, padding: 16 },
  rowTitle: { fontWeight: 600 },
  rowSub: { color: '#666', fontSize: 12 },
  statusBadge: { fontSize: 11, color: '#888', border: '1px solid #333', padding: '4px 8px', borderRadius: 4 },
  empty: { color: '#666', fontStyle: 'italic' },
};
