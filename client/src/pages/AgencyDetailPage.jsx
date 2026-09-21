import { useEffect, useState } from 'react';
import { Link, useParams } from 'react-router-dom';
import { api } from '../lib/api';
import { Card, Badge, Button, StatTile, SectionHeader, EmptyState, Modal, ExportButton } from '../ui';
import { downloadCsv } from '../lib/downloadCsv';

function statusTone(status) {
  if (status === 'ACTIVE') return 'accent';
  if (status === 'INVITED') return 'warning';
  return 'neutral';
}

const ENTITLEMENT_FIELDS = [
  { key: 'crmEnabled', label: 'CRM' },
  { key: 'transfersEnabled', label: 'Yield Transfers' },
  { key: 'coachingEnabled', label: 'Sales Coaching' },
];

export default function AgencyDetailPage() {
  const { agencyId } = useParams();
  const [agency, setAgency] = useState(null);
  const [roster, setRoster] = useState(null);
  const [activity, setActivity] = useState([]);
  const [plans, setPlans] = useState([]);
  const [error, setError] = useState('');
  const [showEdit, setShowEdit] = useState(false);
  const [showInvite, setShowInvite] = useState(false);
  const [showChangePlan, setShowChangePlan] = useState(false);

  useEffect(() => {
    load();
  }, [agencyId]);

  async function load() {
    try {
      const [detail, activityData, planData] = await Promise.all([
        api.agencyDetail(agencyId),
        api.agencyActivity(agencyId, '?pageSize=20'),
        api.plans(),
      ]);
      setAgency(detail.agency);
      setRoster(detail.roster);
      setActivity(activityData.events);
      setPlans(planData.plans);
      setError('');
    } catch (err) {
      setError(err.data?.message || 'Could not load agency.');
    }
  }

  async function toggleEntitlement(key) {
    try {
      await api.updateAgencyEntitlements(agencyId, { [key]: !agency[key] });
      await load();
    } catch (err) {
      setError(err.data?.message || 'Failed to update entitlement.');
    }
  }

  if (error && !agency) return <EmptyState title="Couldn't load agency" description={error} />;
  if (!agency) return <div style={{ color: 'var(--text-muted)' }}>Loading…</div>;

  return (
    <div style={s.wrap}>
      <Link to="/platform" style={s.backLink}>← ALL AGENCIES</Link>

      <SectionHeader
        right={
          <div style={{ display: 'flex', gap: 8 }}>
            <Button variant="secondary" size="sm" onClick={() => setShowInvite(true)}>+ INVITE OWNER/MANAGER</Button>
            <Button variant="secondary" size="sm" onClick={() => setShowEdit(true)}>EDIT SETTINGS</Button>
          </div>
        }
      >
        {agency.name}
      </SectionHeader>
      {error && <div style={s.error}>{error}</div>}

      <div style={s.statsRow}>
        <StatTile label="Producers" value={agency.producerCount} />
        <StatTile label="Managers" value={agency.managerCount} />
        <StatTile label="Telemarketers" value={agency.telemarketerCount} />
        <StatTile label="MRR" value={`$${(agency.mrrCents / 100).toFixed(0)}`} />
      </div>

      <div style={s.grid}>
        <Card style={s.section}>
          <div style={s.sectionTitle}>PLAN & BILLING</div>
          {agency.plan ? (
            <>
              <div style={s.planLine}>
                <strong>{agency.plan.name}</strong> — ${(agency.plan.priceCents / 100).toFixed(2)}/{agency.plan.interval === 'MONTHLY' ? 'mo' : 'yr'}
              </div>
              <Badge tone={agency.subscriptionStatus === 'ACTIVE' ? 'accent' : 'warning'}>{agency.subscriptionStatus}</Badge>
            </>
          ) : (
            <div style={{ color: 'var(--text-secondary)', fontSize: 13 }}>No active subscription — default CRM-only access.</div>
          )}
          <Button variant="ghost" style={{ marginTop: 10 }} onClick={() => setShowChangePlan(true)}>CHANGE PLAN →</Button>
        </Card>

        <Card style={s.section}>
          <div style={s.sectionTitle}>MODULE ACCESS</div>
          {ENTITLEMENT_FIELDS.map((f) => (
            <label key={f.key} style={s.toggleRow}>
              <input type="checkbox" checked={agency[f.key]} onChange={() => toggleEntitlement(f.key)} />
              {f.label}
            </label>
          ))}
          <div style={s.toggleNote}>Overrides the assigned plan directly — takes effect immediately.</div>
        </Card>
      </div>

      <Card style={{ ...s.section, marginTop: 16 }}>
        <div style={s.sectionTitle}>AGENCY SETTINGS</div>
        <div style={s.settingsGrid}>
          <div><span style={s.settingsLabel}>Status</span><Badge tone={statusTone(agency.status)}>{agency.status}</Badge></div>
          <div><span style={s.settingsLabel}>Timezone</span>{agency.timezone}</div>
          <div><span style={s.settingsLabel}>Products</span>{agency.products.join(', ') || '—'}</div>
        </div>
      </Card>

      <SectionHeader
        right={
          <ExportButton onExport={() => downloadCsv(`${agency.name}-roster`, [
            ...roster.owners.map((u) => ({ ...u, roleLabel: 'Owner' })),
            ...roster.managers.map((u) => ({ ...u, roleLabel: 'Manager' })),
            ...roster.producers.map((u) => ({ ...u, roleLabel: 'Producer' })),
            ...roster.telemarketers.map((u) => ({ ...u, roleLabel: 'Telemarketer' })),
          ], [
            { key: 'firstName', label: 'First Name' },
            { key: 'lastName', label: 'Last Name' },
            { key: 'email', label: 'Email' },
            { key: 'roleLabel', label: 'Role' },
            { key: 'status', label: 'Status' },
          ])} />
        }
      >
        ROSTER
      </SectionHeader>
      <div style={s.rosterGrid}>
        <RosterSection title="OWNERS" users={roster.owners} />
        <RosterSection title="MANAGERS" users={roster.managers} />
        <RosterSection title="PRODUCERS" users={roster.producers} />
        <RosterSection title="TELEMARKETERS" users={roster.telemarketers} />
      </div>

      <SectionHeader>RECENT ACTIVITY</SectionHeader>
      {activity.length === 0 ? (
        <EmptyState title="No activity yet" description="Actions taken on this agency will show up here." />
      ) : (
        <Card>
          {activity.map((e) => (
            <div key={e.id} style={s.activityRow}>
              <span style={s.activityAction}>{e.action.replace(/_/g, ' ').replace(/\./g, ' · ')}</span>
              <span style={s.activityMeta}>
                {e.actor ? `${e.actor.firstName} ${e.actor.lastName}` : 'System'} · {new Date(e.createdAt).toLocaleString()}
              </span>
            </div>
          ))}
        </Card>
      )}

      {showEdit && (
        <EditSettingsModal agency={agency} onClose={() => setShowEdit(false)} onSaved={() => { setShowEdit(false); load(); }} />
      )}
      {showInvite && (
        <InviteOwnerModal agencyId={agencyId} onClose={() => setShowInvite(false)} onSent={() => { setShowInvite(false); load(); }} />
      )}
      {showChangePlan && (
        <ChangePlanModal agencyId={agencyId} plans={plans} onClose={() => setShowChangePlan(false)} onChanged={() => { setShowChangePlan(false); load(); }} />
      )}
    </div>
  );
}

function RosterSection({ title, users }) {
  return (
    <Card style={s.rosterCard}>
      <div style={s.sectionTitle}>{title} ({users.length})</div>
      {users.length === 0 ? (
        <div style={s.rosterEmpty}>None yet.</div>
      ) : (
        users.map((u) => (
          <div key={u.id} style={s.rosterRow}>
            <div style={s.rosterInfo}>
              <div style={s.rosterName}>{u.firstName} {u.lastName}</div>
              <div style={s.rosterEmail}>{u.email}</div>
            </div>
            <Badge tone={statusTone(u.status)} style={s.rosterBadge}>{u.status}</Badge>
          </div>
        ))
      )}
    </Card>
  );
}

function EditSettingsModal({ agency, onClose, onSaved }) {
  const [form, setForm] = useState({ name: agency.name, timezone: agency.timezone, products: agency.products.join(', ') });
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState('');

  async function submit(e) {
    e.preventDefault();
    setBusy(true);
    setErr('');
    try {
      await api.updateAgency(agency.id, {
        name: form.name,
        timezone: form.timezone,
        products: form.products.split(',').map((p) => p.trim()).filter(Boolean),
      });
      onSaved();
    } catch (error) {
      setErr(error.data?.message || 'Failed to save.');
    } finally {
      setBusy(false);
    }
  }

  return (
    <Modal title="EDIT AGENCY SETTINGS" onClose={onClose}>
      <form onSubmit={submit} style={s.form}>
        <label style={s.fieldLabel}>Name<input style={s.input} value={form.name} onChange={(e) => setForm({ ...form, name: e.target.value })} required /></label>
        <label style={s.fieldLabel}>Timezone<input style={s.input} value={form.timezone} onChange={(e) => setForm({ ...form, timezone: e.target.value })} /></label>
        <label style={s.fieldLabel}>Products (comma-separated)<input style={s.input} value={form.products} onChange={(e) => setForm({ ...form, products: e.target.value })} /></label>
        {err && <div style={s.error}>{err}</div>}
        <Button variant="primary" type="submit" disabled={busy}>{busy ? 'SAVING…' : 'SAVE'}</Button>
      </form>
    </Modal>
  );
}

function InviteOwnerModal({ agencyId, onClose, onSent }) {
  const [form, setForm] = useState({ email: '', firstName: '', lastName: '', role: 'AGENCY_OWNER' });
  const [result, setResult] = useState(null);
  const [busy, setBusy] = useState(false);

  async function submit(e) {
    e.preventDefault();
    setBusy(true);
    try {
      const res = await api.inviteAgencyOwner(agencyId, form);
      setResult(res);
    } catch (error) {
      setResult({ error: error.data?.message || 'Failed to invite.' });
    } finally {
      setBusy(false);
    }
  }

  return (
    <Modal title="INVITE OWNER / MANAGER" onClose={result ? onSent : onClose}>
      {!result ? (
        <form onSubmit={submit} style={s.form}>
          <select style={s.input} value={form.role} onChange={(e) => setForm({ ...form, role: e.target.value })}>
            <option value="AGENCY_OWNER">Agency Owner</option>
            <option value="AGENCY_MANAGER">Agency Manager</option>
          </select>
          <input style={s.input} placeholder="First name" value={form.firstName} onChange={(e) => setForm({ ...form, firstName: e.target.value })} required />
          <input style={s.input} placeholder="Last name" value={form.lastName} onChange={(e) => setForm({ ...form, lastName: e.target.value })} required />
          <input style={s.input} type="email" placeholder="Email" value={form.email} onChange={(e) => setForm({ ...form, email: e.target.value })} required />
          <Button variant="primary" type="submit" disabled={busy}>{busy ? 'SENDING…' : 'SEND INVITATION'}</Button>
        </form>
      ) : result.error ? (
        <div style={s.error}>{result.error}</div>
      ) : (
        <div style={{ color: 'var(--text-secondary)', fontSize: 13 }}>
          Invited. Email status: {result.emailStatus}
          {result.acceptUrl && (
            <div style={{ marginTop: 8 }}>
              <a style={{ color: 'var(--accent)', wordBreak: 'break-all' }} href={result.acceptUrl} target="_blank" rel="noreferrer">{result.acceptUrl}</a>
            </div>
          )}
        </div>
      )}
    </Modal>
  );
}

function ChangePlanModal({ agencyId, plans, onClose, onChanged }) {
  const [planId, setPlanId] = useState('');
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState('');

  async function submit() {
    if (!planId) return;
    setBusy(true);
    setErr('');
    try {
      await api.assignSubscription(agencyId, { planId, status: 'ACTIVE' });
      onChanged();
    } catch (error) {
      setErr(error.data?.message || 'Failed to assign plan.');
    } finally {
      setBusy(false);
    }
  }

  return (
    <Modal title="CHANGE PLAN" onClose={onClose}>
      <div style={s.form}>
        <select style={s.input} value={planId} onChange={(e) => setPlanId(e.target.value)}>
          <option value="">Select plan…</option>
          {plans.filter((p) => p.isActive).map((p) => (
            <option key={p.id} value={p.id}>{p.name} — ${(p.priceCents / 100).toFixed(2)}/{p.interval === 'MONTHLY' ? 'mo' : 'yr'}</option>
          ))}
        </select>
        {err && <div style={s.error}>{err}</div>}
        <Button variant="primary" onClick={submit} disabled={busy || !planId}>{busy ? 'ASSIGNING…' : 'ASSIGN PLAN'}</Button>
      </div>
    </Modal>
  );
}

const s = {
  wrap: { color: 'var(--text-primary)' },
  backLink: { color: 'var(--text-secondary)', fontSize: 12, textDecoration: 'none', display: 'inline-block', marginBottom: 16 },
  error: { color: 'var(--danger)', marginBottom: 12, fontSize: 13 },
  statsRow: { display: 'flex', gap: 32, marginBottom: 24, flexWrap: 'wrap' },
  grid: { display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 16, marginBottom: 16 },
  section: {},
  sectionTitle: { color: 'var(--text-secondary)', fontSize: 12, letterSpacing: 1.5, fontWeight: 700, marginBottom: 12 },
  planLine: { fontSize: 14, marginBottom: 8, color: 'var(--text-primary)' },
  toggleRow: { display: 'flex', alignItems: 'center', gap: 8, fontSize: 13, color: 'var(--text-secondary)', marginBottom: 8, cursor: 'pointer' },
  toggleNote: { color: 'var(--text-muted)', fontSize: 11, marginTop: 4, fontStyle: 'italic' },
  settingsGrid: { display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(160px, 1fr))', gap: 16, fontSize: 13, color: 'var(--text-primary)' },
  settingsLabel: { display: 'block', color: 'var(--text-muted)', fontSize: 11, marginBottom: 4 },
  rosterGrid: { display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(240px, 1fr))', gap: 16, marginBottom: 24 },
  rosterCard: {},
  rosterEmpty: { color: 'var(--text-muted)', fontStyle: 'italic', fontSize: 12 },
  rosterRow: { display: 'flex', justifyContent: 'space-between', alignItems: 'center', gap: 10, padding: '6px 0', borderBottom: '1px solid var(--border-hairline)' },
  rosterInfo: { minWidth: 0, overflow: 'hidden' },
  rosterName: { fontSize: 13, color: 'var(--text-primary)', fontWeight: 600, whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' },
  rosterEmail: { fontSize: 11, color: 'var(--text-muted)', whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' },
  rosterBadge: { flexShrink: 0 },
  activityRow: { display: 'flex', justifyContent: 'space-between', alignItems: 'center', padding: '8px 0', borderBottom: '1px solid var(--border-hairline)', fontSize: 12, gap: 8, flexWrap: 'wrap' },
  activityAction: { color: 'var(--text-primary)', textTransform: 'capitalize' },
  activityMeta: { color: 'var(--text-muted)' },
  form: { display: 'flex', flexDirection: 'column', gap: 10 },
  fieldLabel: { display: 'flex', flexDirection: 'column', gap: 4, fontSize: 11, color: 'var(--text-muted)' },
  input: { padding: '10px 12px', background: 'var(--bg-sunken)', border: '1px solid var(--border-strong)', borderRadius: 6, color: 'var(--text-primary)' },
};
