import { useEffect, useState } from 'react';
import { api } from '../lib/api';
import { Card, Badge, Button, StatTile, BarRow, SectionHeader, EmptyState, ExportButton } from '../ui';
import { downloadCsv } from '../lib/downloadCsv';
import { emailStatusMessage } from '../lib/emailStatus';

const TM_STATUS_ORDER = ['ACTIVE', 'INVITED', 'DEACTIVATED'];

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
  const [assignRowStatus, setAssignRowStatus] = useState({});
  const [status, setStatus] = useState('');

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
    try {
      const res = await api.resendTelemarketerInvite(tmId);
      setStatus(emailStatusMessage('Invitation resent.', res.emailStatus));
    } catch (err) {
      setStatus(err.data?.message || 'Failed to resend invitation.');
    }
  }

  async function invite(e) {
    e.preventDefault();
    setStatus('Inviting…');
    try {
      const res = await api.inviteTelemarketer(form);
      setStatus(emailStatusMessage('Invited.', res.emailStatus));
      setForm({ email: '', firstName: '', lastName: '' });
      setShowInvite(false);
      await load();
    } catch (err) {
      setStatus(err.data?.message || 'Failed to invite.');
    }
  }

  async function sendReset(tmId) {
    setStatus('Sending password reset…');
    try {
      const res = await api.sendPasswordReset(tmId);
      setStatus(emailStatusMessage('Password reset sent.', res.emailStatus));
    } catch (err) {
      setStatus(err.data?.message || 'Failed to send password reset.');
    }
  }

  async function assign(tmId) {
    const agencyId = assignAgency[tmId];
    if (!agencyId) {
      setAssignRowStatus({ ...assignRowStatus, [tmId]: 'Pick an agency first.' });
      return;
    }
    setAssignRowStatus({ ...assignRowStatus, [tmId]: '' });
    try {
      await api.assignTelemarketer({ telemarketerId: tmId, agencyId });
      setAssignAgency({ ...assignAgency, [tmId]: '' });
      await load();
    } catch (err) {
      setAssignRowStatus({ ...assignRowStatus, [tmId]: err.data?.message || 'Assignment failed.' });
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

  const total = tms.length;
  const active = tms.filter((tm) => tm.status === 'ACTIVE').length;
  const unassigned = tms.filter((tm) => tm.telemarketerAssignments.length === 0).length;
  const coveredAgencyIds = new Set(tms.flatMap((tm) => tm.telemarketerAssignments.map((a) => a.agency.id)));
  const statusCounts = TM_STATUS_ORDER.map((st) => ({
    status: st,
    count: tms.filter((tm) => tm.status === st).length,
  })).filter((row) => row.count > 0);

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

      <div style={s.statsRow}>
        <StatTile label="Total TMs" value={total} />
        <StatTile label="Active" value={active} />
        <StatTile label="Unassigned" value={unassigned} sub={unassigned > 0 ? 'sitting idle' : 'everyone has a desk'} />
        <StatTile label="Agencies Covered" value={`${coveredAgencyIds.size}/${agencies.length}`} />
      </div>

      {total > 0 && (
        <Card style={s.breakdownCard}>
          <div style={s.breakdownTitle}>BY STATUS</div>
          {statusCounts.map((row) => (
            <BarRow key={row.status} label={row.status} value={row.count} max={total} valueLabel={row.count} />
          ))}
        </Card>
      )}

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
                {(tm.status === 'INVITED' || tm.status === 'DEACTIVATED') && (
                  <Button variant="secondary" size="sm" onClick={() => resendTm(tm.id)}>
                    {tm.status === 'DEACTIVATED' ? 'RESEND & REACTIVATE' : 'RESEND INVITE'}
                  </Button>
                )}
                {tm.status === 'ACTIVE' && (
                  <Button variant="secondary" size="sm" onClick={() => sendReset(tm.id)}>RESET PASSWORD</Button>
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
            {assignRowStatus[tm.id] && <div style={s.assignRowStatus}>{assignRowStatus[tm.id]}</div>}
          </Card>
        ))
      )}
    </div>
  );
}

const s = {
  wrap: {},
  loadErrorBox: { background: 'var(--danger-soft)', border: '1px solid rgba(255, 77, 94, 0.4)', color: 'var(--danger)', padding: 16, borderRadius: 8, fontSize: 13, display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 12 },
  statsRow: { display: 'flex', gap: 32, marginBottom: 20, flexWrap: 'wrap' },
  breakdownCard: { marginBottom: 16 },
  breakdownTitle: { color: 'var(--text-muted)', fontSize: 11, letterSpacing: 1.5, fontWeight: 700, marginBottom: 10 },
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
  assignRowStatus: { color: 'var(--danger)', fontSize: 12, marginTop: 6 },
  miniInput: { flex: 1, padding: '8px', background: 'var(--bg-sunken)', border: '1px solid var(--border-strong)', borderRadius: 6, color: 'var(--text-primary)', fontSize: 12 },
  empty: { color: 'var(--text-muted)', fontStyle: 'italic', fontSize: 13 },
};
