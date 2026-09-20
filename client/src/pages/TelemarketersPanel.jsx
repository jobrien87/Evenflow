import { useEffect, useState } from 'react';
import { api } from '../lib/api';

export default function TelemarketersPanel() {
  const [tms, setTms] = useState([]);
  const [agencies, setAgencies] = useState([]);
  const [showInvite, setShowInvite] = useState(false);
  const [form, setForm] = useState({ email: '', firstName: '', lastName: '' });
  const [assignAgency, setAssignAgency] = useState({});
  const [status, setStatus] = useState('');
  const [inviteLink, setInviteLink] = useState('');

  useEffect(() => {
    load();
  }, []);

  async function load() {
    const [tmData, agencyData] = await Promise.all([api.telemarketers(), api.agencies()]);
    setTms(tmData.telemarketers);
    setAgencies(agencyData.agencies);
  }

  async function resendTm(tmId) {
    setStatus('Resending…');
    setInviteLink('');
    try {
      const res = await api.resendTelemarketerInvite(tmId);
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
    setStatus('Inviting…');
    setInviteLink('');
    try {
      const res = await api.inviteTelemarketer(form);
      setStatus(`Invited. Email status: ${res.emailStatus}`);
      if (res.emailStatus !== 'SENT' && res.acceptUrl) {
        setInviteLink(res.acceptUrl);
      }
      setForm({ email: '', firstName: '', lastName: '' });
      setShowInvite(false);
      await load();
    } catch (err) {
      setStatus(err.data?.message || 'Failed to invite.');
    }
  }

  async function assign(tmId) {
    const agencyId = assignAgency[tmId];
    if (!agencyId) return;
    try {
      await api.assignTelemarketer({ telemarketerId: tmId, agencyId });
      await load();
    } catch (err) {
      setStatus(err.data?.message || 'Assignment failed.');
    }
  }

  async function endAssignment(id) {
    await api.endAssignment(id);
    await load();
  }

  return (
    <div style={s.wrap}>
      <div style={s.headerRow}>
        <h3 style={s.h3}>TELEMARKETERS ({tms.length})</h3>
        <button style={s.button} onClick={() => setShowInvite(!showInvite)}>+ INVITE TM</button>
      </div>

      {showInvite && (
        <form onSubmit={invite} style={s.form}>
          <input style={s.input} placeholder="First name" value={form.firstName} onChange={(e) => setForm({ ...form, firstName: e.target.value })} required />
          <input style={s.input} placeholder="Last name" value={form.lastName} onChange={(e) => setForm({ ...form, lastName: e.target.value })} required />
          <input style={s.input} type="email" placeholder="Email" value={form.email} onChange={(e) => setForm({ ...form, email: e.target.value })} required />
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

      {tms.map((tm) => (
        <div key={tm.id} style={s.card}>
          <div style={s.cardTop}>
            <div>
              <div style={s.rowTitle}>{tm.firstName} {tm.lastName}</div>
              <div style={s.rowSub}>{tm.email} · {tm.status}</div>
            </div>
            {tm.status === 'INVITED' && (
              <button style={s.resendButton} onClick={() => resendTm(tm.id)}>RESEND INVITE</button>
            )}
          </div>
          <div style={s.assignedList}>
            {tm.telemarketerAssignments.length === 0 && <div style={s.empty}>No offices assigned yet.</div>}
            {tm.telemarketerAssignments.map((a) => (
              <div key={a.id} style={s.assignedRow}>
                <span>{a.agency.name}</span>
                <button style={s.endButton} onClick={() => endAssignment(a.id)}>REMOVE</button>
              </div>
            ))}
          </div>
          <div style={s.assignRow}>
            <select style={s.miniInput} value={assignAgency[tm.id] || ''} onChange={(e) => setAssignAgency({ ...assignAgency, [tm.id]: e.target.value })}>
              <option value="">Select agency…</option>
              {agencies.map((a) => <option key={a.id} value={a.id}>{a.name}</option>)}
            </select>
            <button style={s.smallButton} onClick={() => assign(tm.id)}>ASSIGN OFFICE</button>
          </div>
        </div>
      ))}
      {tms.length === 0 && <div style={s.empty}>No telemarketers yet.</div>}
    </div>
  );
}

const s = {
  wrap: {},
  headerRow: { display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 16 },
  h3: { color: 'var(--text-secondary)', fontSize: 12, letterSpacing: 2 },
  button: { padding: '10px 18px', background: 'var(--accent)', border: 'none', borderRadius: 6, fontWeight: 700, cursor: 'pointer' },
  form: { display: 'flex', flexDirection: 'column', gap: 10, background: 'var(--bg-elevated)', padding: 16, borderRadius: 8, marginBottom: 12, border: '1px solid var(--border-hairline)' },
  input: { padding: '10px 12px', background: 'var(--bg-sunken)', border: '1px solid var(--border-strong)', borderRadius: 6, color: 'var(--text-primary)' },
  submitButton: { padding: '10px', background: 'var(--accent)', border: 'none', borderRadius: 6, fontWeight: 700, cursor: 'pointer' },
  status: { color: 'var(--accent)', marginBottom: 12, fontSize: 13 },
  linkBox: { color: 'var(--text-secondary)', fontSize: 13, marginBottom: 12, background: 'var(--bg-elevated)', border: '1px solid var(--border-hairline)', borderRadius: 8, padding: 12 },
  link: { color: 'var(--accent)', wordBreak: 'break-all' },
  card: { background: 'var(--bg-elevated)', border: '1px solid var(--border-hairline)', borderRadius: 8, padding: 16, marginBottom: 10 },
  cardTop: { marginBottom: 10, display: 'flex', justifyContent: 'space-between', alignItems: 'center' },
  resendButton: { background: 'transparent', border: '1px solid var(--border-strong)', color: 'var(--accent)', padding: '4px 8px', borderRadius: 4, fontSize: 11, cursor: 'pointer' },
  rowTitle: { fontWeight: 600, fontSize: 14 },
  rowSub: { color: 'var(--text-muted)', fontSize: 12 },
  assignedList: { marginBottom: 10 },
  assignedRow: { display: 'flex', justifyContent: 'space-between', alignItems: 'center', padding: '6px 0', color: 'var(--text-secondary)', fontSize: 13 },
  endButton: { background: 'transparent', border: '1px solid var(--border-strong)', color: 'var(--text-secondary)', padding: '4px 8px', borderRadius: 4, fontSize: 11, cursor: 'pointer' },
  assignRow: { display: 'flex', gap: 8 },
  miniInput: { flex: 1, padding: '8px', background: 'var(--bg-sunken)', border: '1px solid var(--border-strong)', borderRadius: 6, color: 'var(--text-primary)', fontSize: 12 },
  smallButton: { padding: '8px 12px', background: 'var(--accent)', border: 'none', borderRadius: 6, fontWeight: 700, cursor: 'pointer', fontSize: 12 },
  empty: { color: 'var(--text-muted)', fontStyle: 'italic', fontSize: 13 },
};
