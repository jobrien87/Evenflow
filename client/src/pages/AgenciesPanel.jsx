import { useEffect, useState } from 'react';
import { api } from '../lib/api';

export default function AgenciesPanel() {
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

  async function resendAgency(agencyId) {
    setStatus('Resending…');
    setInviteLink('');
    try {
      const res = await api.resendAgencyInvite(agencyId);
      setStatus(`Invitation resent. Email status: ${res.emailStatus}`);
      if (res.emailStatus !== 'SENT' && res.acceptUrl) {
        setInviteLink(res.acceptUrl);
      }
    } catch (err) {
      setStatus(err.data?.message || 'Failed to resend invitation.');
    }
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
          <div key={a.id} style={s.row} className="ui-row-stack">
            <div>
              <div style={s.rowTitle}>{a.name}</div>
              <div style={s.rowSub}>{a.status}</div>
            </div>
            <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
              <div style={s.statusBadge}>{a.status}</div>
              {a.status !== 'ACTIVE' && (
                <button style={s.resendButton} onClick={() => resendAgency(a.id)}>RESEND INVITE</button>
              )}
            </div>
          </div>
        ))}
        {agencies.length === 0 && <div style={s.empty}>EvenFlow is ready. Invite your first agency.</div>}
      </div>
    </div>
  );
}

const s = {
  wrap: { color: 'var(--text-primary)' },
  headerRow: { display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 20 },
  h2: { fontWeight: 400 },
  button: { padding: '10px 18px', background: 'var(--accent)', border: 'none', borderRadius: 6, fontWeight: 700, cursor: 'pointer' },
  form: { display: 'flex', flexDirection: 'column', gap: 10, background: 'var(--bg-elevated)', padding: 20, borderRadius: 8, marginBottom: 16, border: '1px solid var(--border-hairline)' },
  input: { padding: '10px 12px', background: 'var(--bg-sunken)', border: '1px solid var(--border-strong)', borderRadius: 6, color: 'var(--text-primary)' },
  submitButton: { padding: '10px', background: 'var(--accent)', border: 'none', borderRadius: 6, fontWeight: 700, cursor: 'pointer' },
  status: { color: 'var(--accent)', marginBottom: 16, fontSize: 13 },
  linkBox: { color: 'var(--text-secondary)', fontSize: 13, marginBottom: 16, background: 'var(--bg-elevated)', border: '1px solid var(--border-hairline)', borderRadius: 8, padding: 12 },
  link: { color: 'var(--accent)', wordBreak: 'break-all' },
  list: { display: 'flex', flexDirection: 'column', gap: 8 },
  row: { display: 'flex', justifyContent: 'space-between', alignItems: 'center', background: 'var(--bg-elevated)', border: '1px solid var(--border-hairline)', borderRadius: 8, padding: 16 },
  rowTitle: { fontWeight: 600 },
  rowSub: { color: 'var(--text-muted)', fontSize: 12 },
  statusBadge: { fontSize: 11, color: 'var(--text-secondary)', border: '1px solid var(--border-strong)', padding: '4px 8px', borderRadius: 4 },
  resendButton: { background: 'transparent', border: '1px solid var(--border-strong)', color: 'var(--accent)', padding: '4px 8px', borderRadius: 4, fontSize: 11, cursor: 'pointer' },
  empty: { color: 'var(--text-muted)', fontStyle: 'italic' },
};
