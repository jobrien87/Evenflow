import { useEffect, useMemo, useState } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import { api } from '../lib/api';
import { useAuth } from '../lib/AuthContext';
import { Card, Badge, Button, StatTile, SectionHeader, EmptyState, ExportButton } from '../ui';
import { downloadCsv } from '../lib/downloadCsv';
import { emailStatusMessage } from '../lib/emailStatus';
import { ENTITLEMENT_FIELDS, DEFAULT_ENTITLEMENTS } from '../lib/entitlementFields';
import AnnouncementComposer from './AnnouncementComposer';

function statusTone(status) {
  if (status === 'ACTIVE') return 'accent';
  if (status === 'INVITED') return 'warning';
  return 'neutral';
}

export default function AgenciesPanel() {
  const navigate = useNavigate();
  const { refreshUser } = useAuth();
  const [agencies, setAgencies] = useState([]);
  const [total, setTotal] = useState(0);
  const [page, setPage] = useState(1);
  const PAGE_SIZE = 50;
  const [search, setSearch] = useState('');
  const [searchInput, setSearchInput] = useState('');
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState('');
  const [showForm, setShowForm] = useState(false);
  const emptyForm = () => ({
    name: '', ownerFirstName: '', ownerLastName: '', ownerEmail: '',
    isComped: false,
    seatPriceDollars: '',
    ...DEFAULT_ENTITLEMENTS,
  });
  const [form, setForm] = useState(emptyForm);
  const [status, setStatus] = useState('');
  const [showAnnounce, setShowAnnounce] = useState(false);

  // Create Demo Agency — a separate flow from + INVITE AGENCY above: that
  // one sends a real email invite and leaves the owner INVITED until they
  // click it; this one activates the owner (and any roster typed in)
  // immediately with a shared password, no email round-trip at all, for a
  // ready-to-log-in sales-demo account. See server lib/demoAgency.js.
  const emptyRosterEntry = () => ({ firstName: '', lastName: '', email: '' });
  const emptyDemoForm = () => ({
    agencyName: '', ownerFirstName: '', ownerLastName: '', ownerEmail: '',
    password: 'password123',
    producers: [emptyRosterEntry()],
    telemarketers: [],
    seedDemoData: true,
  });
  const [showDemoForm, setShowDemoForm] = useState(false);
  const [demoForm, setDemoForm] = useState(emptyDemoForm);
  const [demoStatus, setDemoStatus] = useState('');
  const [demoResult, setDemoResult] = useState(null);

  useEffect(() => {
    refresh();
  }, [page, search]);

  // Debounce the search box rather than refetching on every keystroke.
  useEffect(() => {
    const timer = setTimeout(() => {
      setPage(1);
      setSearch(searchInput);
    }, 300);
    return () => clearTimeout(timer);
  }, [searchInput]);

  async function refresh() {
    setLoadError('');
    try {
      const params = `?page=${page}&pageSize=${PAGE_SIZE}${search ? `&search=${encodeURIComponent(search)}` : ''}`;
      const data = await api.agencies(params);
      setAgencies(data.agencies);
      setTotal(data.total ?? data.agencies.length);
    } catch (err) {
      setLoadError(err.data?.message || 'Could not load agencies. Try refreshing.');
    } finally {
      setLoading(false);
    }
  }

  async function resendAgency(agencyId) {
    setStatus('Resending…');
    try {
      const res = await api.resendAgencyInvite(agencyId);
      setStatus(emailStatusMessage('Invitation resent.', res.emailStatus));
    } catch (err) {
      setStatus(err.data?.message || 'Failed to resend invitation.');
    }
  }

  // Jumps straight into this agency's owner dashboard — same "VIEW AS"
  // impersonation already available globally (ImpersonationBar.jsx), just
  // one click from the row instead of searching by name. Every action
  // taken from here on is tagged as Admin Activity on the audit trail
  // automatically (see server lib/requestContext.js + lib/audit.js) —
  // nothing further to wire up for that per action.
  async function loginAsOwner(ownerId) {
    setStatus('');
    try {
      await api.startImpersonation(ownerId);
      // Refresh AuthContext's cached user BEFORE navigating — without
      // this, the client still believes it's the Platform Owner, so
      // RoleGate immediately bounces the /agency route back here.
      await refreshUser();
      navigate('/agency');
    } catch (err) {
      setStatus(err.data?.message || 'Could not log in as this agency\'s owner.');
    }
  }

  function updateRosterEntry(listKey, index, field, value) {
    setDemoForm((f) => {
      const list = [...f[listKey]];
      list[index] = { ...list[index], [field]: value };
      return { ...f, [listKey]: list };
    });
  }
  function addRosterEntry(listKey) {
    setDemoForm((f) => ({ ...f, [listKey]: [...f[listKey], emptyRosterEntry()] }));
  }
  function removeRosterEntry(listKey, index) {
    setDemoForm((f) => ({ ...f, [listKey]: f[listKey].filter((_, i) => i !== index) }));
  }

  async function submitDemoAgency(e) {
    e.preventDefault();
    setDemoStatus('Creating…');
    setDemoResult(null);
    try {
      const payload = {
        agencyName: demoForm.agencyName,
        owner: { firstName: demoForm.ownerFirstName, lastName: demoForm.ownerLastName, email: demoForm.ownerEmail },
        producers: demoForm.producers.filter((p) => p.firstName && p.lastName && p.email),
        telemarketers: demoForm.telemarketers.filter((t) => t.firstName && t.lastName && t.email),
        password: demoForm.password,
        seedDemoData: demoForm.seedDemoData,
      };
      const res = await api.createDemoAgency(payload);
      setDemoResult(res);
      setDemoStatus('');
      setDemoForm(emptyDemoForm());
      setShowDemoForm(false);
      await refresh();
    } catch (err) {
      setDemoStatus(err.data?.message || 'Failed to create demo agency.');
    }
  }

  async function submit(e) {
    e.preventDefault();
    setStatus('Creating…');
    try {
      const { seatPriceDollars, ...rest } = form;
      const payload = { ...rest };
      if (!form.isComped && seatPriceDollars.trim() !== '') {
        payload.seatPriceCents = Math.round(parseFloat(seatPriceDollars) * 100);
      }
      const res = await api.createAgency(payload);
      setStatus(emailStatusMessage('Agency created.', res.invitation.emailStatus));
      setForm(emptyForm());
      setShowForm(false);
      await refresh();
    } catch (err) {
      setStatus(err.data?.message || 'Failed to create agency.');
    }
  }

  // Only real when every agency is actually loaded (no pagination in
  // effect) — summing producers/TMs/MRR across just the current page
  // would silently understate the real platform totals, which this app
  // never does for a number labeled as a total.
  const fullyLoaded = agencies.length === total;
  const totals = useMemo(() => agencies.reduce((acc, a) => ({
    producers: acc.producers + (a.producerCount || 0),
    telemarketers: acc.telemarketers + (a.telemarketerCount || 0),
    mrrCents: acc.mrrCents + (a.mrrCents || 0),
  }), { producers: 0, telemarketers: 0, mrrCents: 0 }), [agencies]);

  if (loading) {
    return <div style={s.wrap}>Loading…</div>;
  }

  if (loadError) {
    return (
      <div style={s.wrap}>
        <div style={s.loadErrorBox}>
          {loadError}
          <Button variant="secondary" size="sm" onClick={refresh}>RETRY</Button>
        </div>
      </div>
    );
  }

  return (
    <div style={s.wrap}>
      <SectionHeader
        right={
          <div style={{ display: 'flex', gap: 8 }}>
            {agencies.length > 0 && (
              <ExportButton onExport={() => downloadCsv('agencies', agencies, [
                { key: 'name', label: 'Agency' },
                { key: 'status', label: 'Status' },
                { key: (a) => a.plan?.name || '', label: 'Plan' },
                { key: (a) => (a.mrrCents / 100).toFixed(2), label: 'MRR ($)' },
                { key: 'producerCount', label: 'Producers' },
                { key: 'managerCount', label: 'Managers' },
                { key: 'telemarketerCount', label: 'Telemarketers' },
              ])} />
            )}
            <Button variant="secondary" size="sm" onClick={() => setShowAnnounce(true)}>+ ANNOUNCEMENT</Button>
            <Button variant="secondary" size="sm" onClick={() => setShowDemoForm(!showDemoForm)}>+ CREATE DEMO AGENCY</Button>
            <Button variant="primary" size="sm" onClick={() => setShowForm(!showForm)}>+ INVITE AGENCY</Button>
          </div>
        }
      >
        AGENCIES
      </SectionHeader>

      <AnnouncementComposer
        open={showAnnounce}
        onClose={() => setShowAnnounce(false)}
        targets={[
          { value: 'agency', label: 'Entire agency', picker: { field: 'agencyId', placeholder: 'Select agency…', options: agencies.map((a) => ({ id: a.id, label: a.name })) } },
          { value: 'agency_owner', label: 'Specific agency owner', picker: { field: 'targetUserId', placeholder: 'Search by name or email…', search: true, roleFilter: ['AGENCY_OWNER', 'AGENCY_MANAGER'] } },
          { value: 'producer', label: 'Specific producer', picker: { field: 'targetUserId', placeholder: 'Search by name or email…', search: true, roleFilter: ['PRODUCER'] } },
          { value: 'telemarketer', label: 'Specific telemarketer', picker: { field: 'targetUserId', placeholder: 'Search by name or email…', search: true, roleFilter: ['TELEMARKETER'] } },
          { value: 'all_telemarketers', label: 'All telemarketers' },
        ]}
      />

      <div style={s.statsRow}>
        <StatTile label="Agencies" value={total} />
        {fullyLoaded && <StatTile label="Producers" value={totals.producers} />}
        {fullyLoaded && <StatTile label="Telemarketers" value={totals.telemarketers} />}
        {fullyLoaded && <StatTile label="MRR" value={`$${(totals.mrrCents / 100).toFixed(0)}`} />}
      </div>

      <input
        style={s.searchInput}
        placeholder="Search agencies by name…"
        value={searchInput}
        onChange={(e) => setSearchInput(e.target.value)}
      />

      {demoResult && (
        <Card style={s.formCard}>
          <div style={s.formSectionLabel}>DEMO AGENCY READY — "{demoResult.agency.name}"</div>
          <div style={s.linkBox}>
            Nothing was emailed for any of these — this is the only place the logins are shown. Copy them now.
            <div style={{ marginTop: 8 }}>
              <strong>Owner:</strong> {demoResult.owner.email} / {demoResult.password}
            </div>
            {demoResult.producers.length > 0 && (
              <div style={{ marginTop: 6 }}>
                <strong>Producers:</strong>
                {demoResult.producers.map((p) => <div key={p.id}>{p.firstName} {p.lastName} — {p.email} / {demoResult.password}</div>)}
              </div>
            )}
            {demoResult.telemarketers.length > 0 && (
              <div style={{ marginTop: 6 }}>
                <strong>Telemarketers:</strong>
                {demoResult.telemarketers.map((t) => <div key={t.id}>{t.firstName} {t.lastName} — {t.email} / {demoResult.password}</div>)}
              </div>
            )}
            {demoResult.seeded && (
              <div style={{ marginTop: 6 }}>Seeded {demoResult.seeded.leadCount} demo leads, {demoResult.seeded.saleCount} demo closed sales, {demoResult.seeded.vendorCount} demo vendors.</div>
            )}
          </div>
          <Button variant="secondary" size="sm" onClick={() => setDemoResult(null)}>DISMISS</Button>
        </Card>
      )}

      {showDemoForm && (
        <Card style={s.formCard}>
          <form onSubmit={submitDemoAgency} style={s.form}>
            <div style={s.formSectionLabel}>AGENCY</div>
            <input style={s.input} placeholder="Agency name (e.g. Tom Paterson Allstate (Demo))" value={demoForm.agencyName} onChange={(e) => setDemoForm({ ...demoForm, agencyName: e.target.value })} required />

            <div style={s.formSectionLabel}>OWNER</div>
            <input style={s.input} placeholder="Owner first name" value={demoForm.ownerFirstName} onChange={(e) => setDemoForm({ ...demoForm, ownerFirstName: e.target.value })} required />
            <input style={s.input} placeholder="Owner last name" value={demoForm.ownerLastName} onChange={(e) => setDemoForm({ ...demoForm, ownerLastName: e.target.value })} required />
            <input style={s.input} type="email" placeholder="Owner email (login)" value={demoForm.ownerEmail} onChange={(e) => setDemoForm({ ...demoForm, ownerEmail: e.target.value })} required />
            <input style={s.input} placeholder="Shared password (10+ characters)" value={demoForm.password} onChange={(e) => setDemoForm({ ...demoForm, password: e.target.value })} required minLength={10} />

            <div style={s.formSectionLabel}>PRODUCERS</div>
            {demoForm.producers.map((p, i) => (
              <div key={i} style={s.rosterRow}>
                <input style={s.input} placeholder="First name" value={p.firstName} onChange={(e) => updateRosterEntry('producers', i, 'firstName', e.target.value)} />
                <input style={s.input} placeholder="Last name" value={p.lastName} onChange={(e) => updateRosterEntry('producers', i, 'lastName', e.target.value)} />
                <input style={s.input} type="email" placeholder="Email" value={p.email} onChange={(e) => updateRosterEntry('producers', i, 'email', e.target.value)} />
                <Button type="button" variant="secondary" size="sm" onClick={() => removeRosterEntry('producers', i)}>REMOVE</Button>
              </div>
            ))}
            <Button type="button" variant="secondary" size="sm" onClick={() => addRosterEntry('producers')}>+ ADD PRODUCER</Button>

            <div style={s.formSectionLabel}>TELEMARKETERS</div>
            {demoForm.telemarketers.map((t, i) => (
              <div key={i} style={s.rosterRow}>
                <input style={s.input} placeholder="First name" value={t.firstName} onChange={(e) => updateRosterEntry('telemarketers', i, 'firstName', e.target.value)} />
                <input style={s.input} placeholder="Last name" value={t.lastName} onChange={(e) => updateRosterEntry('telemarketers', i, 'lastName', e.target.value)} />
                <input style={s.input} type="email" placeholder="Email" value={t.email} onChange={(e) => updateRosterEntry('telemarketers', i, 'email', e.target.value)} />
                <Button type="button" variant="secondary" size="sm" onClick={() => removeRosterEntry('telemarketers', i)}>REMOVE</Button>
              </div>
            ))}
            <Button type="button" variant="secondary" size="sm" onClick={() => addRosterEntry('telemarketers')}>+ ADD TELEMARKETER</Button>

            <label style={s.checkboxRow}>
              <input type="checkbox" checked={demoForm.seedDemoData} onChange={(e) => setDemoForm({ ...demoForm, seedDemoData: e.target.checked })} />
              Seed sample leads &amp; closed sales (clearly fabricated demo data, never real customer data)
            </label>

            {demoStatus && <div style={s.status}>{demoStatus}</div>}
            <Button variant="primary" type="submit">CREATE DEMO AGENCY</Button>
          </form>
        </Card>
      )}

      {showForm && (
        <Card style={s.formCard}>
          <form onSubmit={submit} style={s.form}>
            <input style={s.input} placeholder="Agency name" value={form.name} onChange={(e) => setForm({ ...form, name: e.target.value })} required />
            <input style={s.input} placeholder="Owner first name" value={form.ownerFirstName} onChange={(e) => setForm({ ...form, ownerFirstName: e.target.value })} required />
            <input style={s.input} placeholder="Owner last name" value={form.ownerLastName} onChange={(e) => setForm({ ...form, ownerLastName: e.target.value })} required />
            <input style={s.input} type="email" placeholder="Owner email" value={form.ownerEmail} onChange={(e) => setForm({ ...form, ownerEmail: e.target.value })} required />

            <div style={s.formSectionLabel}>BILLING</div>
            <label style={s.checkboxRow}>
              <input
                type="checkbox"
                checked={form.isComped}
                onChange={(e) => setForm({ ...form, isComped: e.target.checked })}
              />
              Comp this account (no monthly charge)
            </label>
            {!form.isComped && (
              <input
                style={s.input}
                type="number"
                min="0"
                step="0.01"
                placeholder="Custom price per seat ($, leave blank for the standard $35/seat)"
                value={form.seatPriceDollars}
                onChange={(e) => setForm({ ...form, seatPriceDollars: e.target.value })}
              />
            )}

            <div style={s.formSectionLabel}>MODULE ACCESS</div>
            <div style={s.entitlementGrid}>
              {ENTITLEMENT_FIELDS.map((f) => (
                <label key={f.key} style={s.checkboxRow}>
                  <input
                    type="checkbox"
                    checked={!!form[f.key]}
                    onChange={(e) => setForm({ ...form, [f.key]: e.target.checked })}
                  />
                  {f.label}
                </label>
              ))}
            </div>

            <Button variant="primary" type="submit">Send Invitation</Button>
          </form>
        </Card>
      )}
      {status && <div style={s.status}>{status}</div>}

      {agencies.length === 0 ? (
        <EmptyState
          title={search ? 'No agencies match' : 'EvenFlow is ready'}
          description={search ? `No agency name contains "${search}".` : 'Invite your first agency to get started.'}
        />
      ) : (
        <Card style={s.tableCard}>
          <div style={{ ...s.tableRow, ...s.tableHeader }}>
            <div style={s.colName}>AGENCY</div>
            <div style={s.colSmall}>STATUS</div>
            <div style={s.colSmall}>PLAN</div>
            <div style={s.colSmall}>MRR</div>
            <div style={s.colSmall}>PRODUCERS</div>
            <div style={s.colSmall}>TMS</div>
            <div style={s.colAction} />
          </div>
          {agencies.map((a) => (
            <Link key={a.id} to={`/platform/agencies/${a.id}`} style={s.tableRowLink}>
              <div style={s.tableRow}>
                <div style={s.colName}>
                  {a.name}
                  {a.isDemo && <Badge tone="warning" style={{ marginLeft: 8 }}>DEMO</Badge>}
                </div>
                <div style={s.colSmall}><Badge tone={statusTone(a.status)}>{a.status}</Badge></div>
                <div style={s.colSmall}>{a.plan ? a.plan.name : '—'}</div>
                <div style={s.colSmall}>${(a.mrrCents / 100).toFixed(0)}</div>
                <div style={s.colSmall}>{a.producerCount}</div>
                <div style={s.colSmall}>{a.telemarketerCount}</div>
                <div style={s.colActionRow}>
                  {a.status !== 'ACTIVE' && (
                    <Button variant="secondary" size="sm" onClick={(e) => { e.preventDefault(); resendAgency(a.id); }}>RESEND INVITE</Button>
                  )}
                  {a.ownerId && (
                    <Button
                      variant="secondary"
                      size="sm"
                      title={`Log in as ${a.ownerName}`}
                      onClick={(e) => { e.preventDefault(); loginAsOwner(a.ownerId); }}
                    >
                      LOG IN AS OWNER
                    </Button>
                  )}
                </div>
              </div>
            </Link>
          ))}
        </Card>
      )}

      {total > PAGE_SIZE && (
        <div style={s.pagination}>
          <Button variant="secondary" size="sm" disabled={page <= 1} onClick={() => setPage((p) => p - 1)}>PREV</Button>
          <span style={s.pageLabel}>
            Page {page} of {Math.max(1, Math.ceil(total / PAGE_SIZE))} · {total} agencies
          </span>
          <Button variant="secondary" size="sm" disabled={page * PAGE_SIZE >= total} onClick={() => setPage((p) => p + 1)}>NEXT</Button>
        </div>
      )}
    </div>
  );
}

const s = {
  wrap: { color: 'var(--text-primary)' },
  loadErrorBox: { background: 'var(--danger-soft)', border: '1px solid rgba(255, 77, 94, 0.4)', color: 'var(--danger)', padding: 16, borderRadius: 8, fontSize: 13, display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 12 },
  statsRow: { display: 'flex', gap: 32, marginBottom: 24, flexWrap: 'wrap' },
  searchInput: { width: '100%', maxWidth: 360, padding: '10px 12px', background: 'var(--bg-sunken)', border: '1px solid var(--border-strong)', borderRadius: 6, color: 'var(--text-primary)', marginBottom: 16 },
  pagination: { display: 'flex', alignItems: 'center', justifyContent: 'center', gap: 16, marginTop: 16 },
  pageLabel: { color: 'var(--text-muted)', fontSize: 12 },
  formCard: { marginBottom: 16 },
  form: { display: 'flex', flexDirection: 'column', gap: 10 },
  input: { padding: '10px 12px', background: 'var(--bg-sunken)', border: '1px solid var(--border-strong)', borderRadius: 6, color: 'var(--text-primary)' },
  formSectionLabel: { color: 'var(--text-muted)', fontSize: 11, letterSpacing: 1, fontWeight: 700, marginTop: 6 },
  checkboxRow: { display: 'flex', alignItems: 'center', gap: 8, fontSize: 13, color: 'var(--text-secondary)' },
  rosterRow: { display: 'grid', gridTemplateColumns: '1fr 1fr 1.4fr auto', gap: 8, alignItems: 'center' },
  entitlementGrid: { display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(220px, 1fr))', gap: 8 },
  status: { color: 'var(--accent)', marginBottom: 16, fontSize: 13 },
  linkBox: { color: 'var(--text-secondary)', fontSize: 13, marginBottom: 16, background: 'var(--bg-elevated)', border: '1px solid var(--border-hairline)', borderRadius: 8, padding: 12 },
  link: { color: 'var(--accent)', wordBreak: 'break-all' },
  tableCard: { padding: 0, overflow: 'hidden' },
  tableRowLink: { textDecoration: 'none', color: 'inherit', display: 'block' },
  tableRow: {
    display: 'grid', gridTemplateColumns: '2fr 1fr 1.2fr 0.8fr 1fr 1fr 2fr',
    alignItems: 'center', gap: 8, padding: '12px 16px', borderBottom: '1px solid var(--border-hairline)', fontSize: 13,
  },
  tableHeader: { color: 'var(--text-muted)', fontSize: 11, letterSpacing: 1, fontWeight: 700 },
  colName: { fontWeight: 600, color: 'var(--text-primary)' },
  colSmall: { color: 'var(--text-secondary)' },
  colAction: { textAlign: 'right' },
  colActionRow: { display: 'flex', justifyContent: 'flex-end', gap: 8, flexWrap: 'wrap' },
};
