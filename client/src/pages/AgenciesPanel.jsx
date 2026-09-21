import { useEffect, useMemo, useState } from 'react';
import { Link } from 'react-router-dom';
import { api } from '../lib/api';
import { Card, Badge, Button, StatTile, SectionHeader, EmptyState, ExportButton } from '../ui';
import { downloadCsv } from '../lib/downloadCsv';

function statusTone(status) {
  if (status === 'ACTIVE') return 'accent';
  if (status === 'INVITED') return 'warning';
  return 'neutral';
}

export default function AgenciesPanel() {
  const [agencies, setAgencies] = useState([]);
  const [total, setTotal] = useState(0);
  const [page, setPage] = useState(1);
  const PAGE_SIZE = 50;
  const [search, setSearch] = useState('');
  const [searchInput, setSearchInput] = useState('');
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState('');
  const [showForm, setShowForm] = useState(false);
  const [form, setForm] = useState({ name: '', ownerFirstName: '', ownerLastName: '', ownerEmail: '' });
  const [status, setStatus] = useState('');
  const [inviteLink, setInviteLink] = useState('');

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
            <Button variant="primary" size="sm" onClick={() => setShowForm(!showForm)}>+ INVITE AGENCY</Button>
          </div>
        }
      >
        AGENCIES
      </SectionHeader>

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

      {showForm && (
        <Card style={s.formCard}>
          <form onSubmit={submit} style={s.form}>
            <input style={s.input} placeholder="Agency name" value={form.name} onChange={(e) => setForm({ ...form, name: e.target.value })} required />
            <input style={s.input} placeholder="Owner first name" value={form.ownerFirstName} onChange={(e) => setForm({ ...form, ownerFirstName: e.target.value })} required />
            <input style={s.input} placeholder="Owner last name" value={form.ownerLastName} onChange={(e) => setForm({ ...form, ownerLastName: e.target.value })} required />
            <input style={s.input} type="email" placeholder="Owner email" value={form.ownerEmail} onChange={(e) => setForm({ ...form, ownerEmail: e.target.value })} required />
            <Button variant="primary" type="submit">Send Invitation</Button>
          </form>
        </Card>
      )}
      {status && <div style={s.status}>{status}</div>}
      {inviteLink && (
        <div style={s.linkBox}>
          Email wasn't sent — share this activation link with the agency owner directly:
          <br />
          <a style={s.link} href={inviteLink} target="_blank" rel="noreferrer">{inviteLink}</a>
        </div>
      )}

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
                <div style={s.colName}>{a.name}</div>
                <div style={s.colSmall}><Badge tone={statusTone(a.status)}>{a.status}</Badge></div>
                <div style={s.colSmall}>{a.plan ? a.plan.name : '—'}</div>
                <div style={s.colSmall}>${(a.mrrCents / 100).toFixed(0)}</div>
                <div style={s.colSmall}>{a.producerCount}</div>
                <div style={s.colSmall}>{a.telemarketerCount}</div>
                <div style={s.colAction}>
                  {a.status !== 'ACTIVE' && (
                    <Button variant="secondary" size="sm" onClick={(e) => { e.preventDefault(); resendAgency(a.id); }}>RESEND INVITE</Button>
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
  status: { color: 'var(--accent)', marginBottom: 16, fontSize: 13 },
  linkBox: { color: 'var(--text-secondary)', fontSize: 13, marginBottom: 16, background: 'var(--bg-elevated)', border: '1px solid var(--border-hairline)', borderRadius: 8, padding: 12 },
  link: { color: 'var(--accent)', wordBreak: 'break-all' },
  tableCard: { padding: 0, overflow: 'hidden' },
  tableRowLink: { textDecoration: 'none', color: 'inherit', display: 'block' },
  tableRow: {
    display: 'grid', gridTemplateColumns: '2fr 1fr 1.2fr 0.8fr 1fr 1fr 1.4fr',
    alignItems: 'center', gap: 8, padding: '12px 16px', borderBottom: '1px solid var(--border-hairline)', fontSize: 13,
  },
  tableHeader: { color: 'var(--text-muted)', fontSize: 11, letterSpacing: 1, fontWeight: 700 },
  colName: { fontWeight: 600, color: 'var(--text-primary)' },
  colSmall: { color: 'var(--text-secondary)' },
  colAction: { textAlign: 'right' },
};
