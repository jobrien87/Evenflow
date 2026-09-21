import { useEffect, useState } from 'react';
import { api } from '../lib/api';
import { Card, Badge, Button, SectionHeader, EmptyState, ExportButton } from '../ui';
import { downloadCsv } from '../lib/downloadCsv';

function statusTone(status) {
  if (status === 'ACTIVE') return 'accent';
  if (status === 'INVITED') return 'warning';
  return 'neutral';
}

export default function TelemarketersPanel() {
  const [tms, setTms] = useState([]);
  const [agencies, setAgencies] = useState([]);
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState('');
  const [showInvite, setShowInvite] = useState(false);
  const [form, setForm] = useState({ email: '', firstName: '', lastName: '' });
  const [assignAgency, setAssignAgency] = useState({});
  const [status, setStatus] = useState('');
  const [inviteLink, setInviteLink] = useState('');

  useEffect(() => {
    load();
  }, []);

  async function load() {
    setLoadError('');
    try {
      const [tmData, agencyData] = await Promise.all([api.telemarketers(), api.agencies()]);
      setTms(tmData.telemarketers);
      setAgencies(agencyData.agencies);
    } catch (err) {
      setLoadError(err.data?.message || 'Could not load telemarketers. Try refreshing.');
    } finally {
      setLoading(false);
    }
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

  if (loading) {
    return <div style={s.wrap}>Loading…</div>;
  }

  if (loadError) {
    return (
      <div style={s.wrap}>
        <div style={s.loadErrorBox}>
          {loadError}
          <Button variant="secondary" size="sm" onClick={load}>RETRY</Button>
        </div>
      </div>
    );
  }

  return (
    <div style={s.wrap}>
      <SectionHeader
        right={
          <div style={{ display: 'flex', gap: 8 }}>
            {tms.length > 0 && (
              <ExportButton onExport={() => downloadCsv('telemarketers', tms, [
                { key: 'firstName', label: 'First Name' },
                { key: 'lastName', label: 'Last Name' },
                { key: 'email', label: 'Email' },
                { key: 'status', label: 'Status' },
                { key: (tm) => tm.telemarketerAssignments.map((a) => a.agency.name).join('; '), label: 'Assigned Agencies' },
              ])} />
            )}
            <Button variant="primary" size="sm" onClick={() => setShowInvite(!showInvite)}>+ INVITE TM</Button>
          </div>
        }
      >
        TELEMARKETERS ({tms.length})
      </SectionHeader>

      {showInvite && (
        <Card style={s.formCard}>
          <form onSubmit={invite} style={s.form}>
            <input style={s.input} placeholder="First name" value={form.firstName} onChange={(e) => setForm({ ...form, firstName: e.target.value })} required />
            <input style={s.input} placeholder="Last name" value={form.lastName} onChange={(e) => setForm({ ...form, lastName: e.target.value })} required />
            <input style={s.input} type="email" placeholder="Email" value={form.email} onChange={(e) => setForm({ ...form, email: e.target.value })} required />
            <Button variant="primary" type="submit">Send Invitation</Button>
          </form>
        </Card>
      )}
      {status && <div style={s.status}>{status}</div>}
      {inviteLink && (
        <div style={s.linkBox}>
          Email wasn't sent — share this activation link directly:
          <br />
          <a style={s.link} href={inviteLink} target="_blank" rel="noreferrer">{inviteLink}</a>
        </div>
      )}

      {tms.length === 0 ? (
        <EmptyState title="No telemarketers yet" description="Invite a telemarketer to get started." />
      ) : (
        tms.map((tm) => (
          <Card key={tm.id} style={s.card}>
            <div style={s.cardTop} className="ui-row-stack">
              <div>
                <div style={s.rowTitle}>{tm.firstName} {tm.lastName}</div>
                <div style={s.rowSub}>{tm.email}</div>
              </div>
              <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                <Badge tone={statusTone(tm.status)}>{tm.status}</Badge>
                {tm.status === 'INVITED' && (
                  <Button variant="secondary" size="sm" onClick={() => resendTm(tm.id)}>RESEND INVITE</Button>
                )}
              </div>
            </div>
            <div style={s.assignedList}>
              {tm.telemarketerAssignments.length === 0 && <div style={s.empty}>No offices assigned yet.</div>}
              {tm.telemarketerAssignments.map((a) => (
                <div key={a.id} style={s.assignedRow}>
                  <span>{a.agency.name}</span>
                  <Button variant="secondary" size="sm" onClick={() => endAssignment(a.id)}>REMOVE</Button>
                </div>
              ))}
            </div>
            <div style={s.assignRow}>
              <select style={s.miniInput} value={assignAgency[tm.id] || ''} onChange={(e) => setAssignAgency({ ...assignAgency, [tm.id]: e.target.value })}>
                <option value="">Select agency…</option>
                {agencies.map((a) => <option key={a.id} value={a.id}>{a.name}</option>)}
              </select>
              <Button variant="primary" size="sm" onClick={() => assign(tm.id)}>ASSIGN OFFICE</Button>
            </div>
          </Card>
        ))
      )}
    </div>
  );
}

const s = {
  wrap: {},
  loadErrorBox: { background: 'var(--danger-soft)', border: '1px solid rgba(255, 77, 94, 0.4)', color: 'var(--danger)', padding: 16, borderRadius: 8, fontSize: 13, display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 12 },
  formCard: { marginBottom: 12 },
  form: { display: 'flex', flexDirection: 'column', gap: 10 },
  input: { padding: '10px 12px', background: 'var(--bg-sunken)', border: '1px solid var(--border-strong)', borderRadius: 6, color: 'var(--text-primary)' },
  status: { color: 'var(--accent)', marginBottom: 12, fontSize: 13 },
  linkBox: { color: 'var(--text-secondary)', fontSize: 13, marginBottom: 12, background: 'var(--bg-elevated)', border: '1px solid var(--border-hairline)', borderRadius: 8, padding: 12 },
  link: { color: 'var(--accent)', wordBreak: 'break-all' },
  card: { marginBottom: 10 },
  cardTop: { marginBottom: 10, display: 'flex', justifyContent: 'space-between', alignItems: 'center', gap: 8 },
  rowTitle: { fontWeight: 600, fontSize: 14, color: 'var(--text-primary)' },
  rowSub: { color: 'var(--text-muted)', fontSize: 12 },
  assignedList: { marginBottom: 10 },
  assignedRow: { display: 'flex', justifyContent: 'space-between', alignItems: 'center', padding: '6px 0', color: 'var(--text-secondary)', fontSize: 13 },
  assignRow: { display: 'flex', gap: 8 },
  miniInput: { flex: 1, padding: '8px', background: 'var(--bg-sunken)', border: '1px solid var(--border-strong)', borderRadius: 6, color: 'var(--text-primary)', fontSize: 12 },
  empty: { color: 'var(--text-muted)', fontStyle: 'italic', fontSize: 13 },
};
