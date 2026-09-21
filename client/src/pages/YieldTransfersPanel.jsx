import { useEffect, useMemo, useState } from 'react';
import { api } from '../lib/api';
import { useAuth } from '../lib/AuthContext';
import { useIsMobile } from '../lib/useViewport';
import { Card, Badge, Button, SectionHeader, EmptyState, ExportButton } from '../ui';
import { downloadCsv, fetchAllPages } from '../lib/downloadCsv';
import ChatThread from './ChatThread';

const LEAD_STATUSES = [
  'NEW', 'ASSIGNED', 'ATTEMPTED', 'CONTACTED', 'APPOINTMENT', 'QUOTE_STARTED',
  'QUOTED', 'FOLLOW_UP', 'SOLD', 'LOST', 'BAD_CONTACT', 'DUPLICATE', 'DO_NOT_CONTACT', 'ARCHIVED',
];

// SOLD is deliberately excluded from bulk actions — a sale needs a real,
// entered premium/product per lead, which a bulk action can't honestly
// supply (see financialEvents.js's recordLeadSaleRevenue: only real,
// entered numbers, never fabricated).
const BULK_STATUSES = ['CONTACTED', 'FOLLOW_UP', 'LOST', 'BAD_CONTACT', 'DUPLICATE', 'DO_NOT_CONTACT', 'ARCHIVED'];

function statusTone(status) {
  if (status === 'SOLD') return 'accent';
  if (['LOST', 'BAD_CONTACT', 'DUPLICATE', 'DO_NOT_CONTACT'].includes(status)) return 'danger';
  if (status === 'NEW') return 'warning';
  return 'neutral';
}

// A stable, distinct color per Telemarketer id so an Agency Owner can
// pattern-match "who submitted this" across a long list at a glance,
// without reading names on every card. Hashed to a hue rather than
// picked from the app's small semantic token palette (accent/danger/
// warning already carry status meaning) so it scales to any number of
// TMs without colliding with those meanings.
function tmColor(id) {
  let hash = 0;
  for (let i = 0; i < id.length; i++) hash = (hash * 31 + id.charCodeAt(i)) >>> 0;
  const hue = hash % 360;
  return `hsl(${hue}, 65%, 55%)`;
}

function tmInitials(user) {
  if (!user) return '?';
  return `${user.firstName?.[0] || ''}${user.lastName?.[0] || ''}`.toUpperCase();
}

// Yield Transfers rebuild: telemarketer submissions are real Leads
// (source: 'telemarketer'), instantly visible here the moment they're
// created — no accept/reject gate, matching the Inferno Connect
// reference. The team-wide chat lives alongside the leads list; a
// focused per-lead DISCUSS thread is kept too, opened in its own modal.
export default function YieldTransfersPanel() {
  const { user } = useAuth();
  const isMobile = useIsMobile();
  const [leads, setLeads] = useState([]);
  const [error, setError] = useState('');
  const [discussLead, setDiscussLead] = useState(null);
  const [tmFilter, setTmFilter] = useState(null);
  const [selectedIds, setSelectedIds] = useState([]);
  const [bulkStatus, setBulkStatus] = useState(BULK_STATUSES[0]);
  const [bulkBusy, setBulkBusy] = useState(false);
  const [bulkError, setBulkError] = useState('');

  useEffect(() => {
    load();
    const interval = setInterval(load, 8000);
    return () => clearInterval(interval);
  }, []);

  async function load() {
    try {
      const data = await api.leads('?source=telemarketer');
      setLeads(data.leads);
      setError('');
    } catch (err) {
      setError(err.data?.message || 'Could not load leads.');
    }
  }

  // GET /leads is server-paginated (25/page) — the leads array in state
  // is only whatever's currently loaded, so an export needs every page,
  // not just what's on screen.
  async function exportAllLeads() {
    const allLeads = await fetchAllPages(
      (page, pageSize) => api.leads(`?source=telemarketer&page=${page}&pageSize=${pageSize}`),
      { itemsKey: 'leads' }
    );
    downloadCsv('yield-transfers-leads', allLeads, [
      { key: (l) => l.customer?.firstName || '', label: 'First Name' },
      { key: (l) => l.customer?.lastName || '', label: 'Last Name' },
      { key: (l) => l.customer?.phone || '', label: 'Phone' },
      { key: (l) => l.customer?.email || '', label: 'Email' },
      { key: 'product', label: 'Product' },
      { key: 'status', label: 'Status' },
      { key: (l) => l.createdBy ? `${l.createdBy.firstName} ${l.createdBy.lastName}` : '', label: 'Submitted By' },
      { key: 'receivedAt', label: 'Received At' },
      { key: 'address', label: 'Address' },
      { key: 'city', label: 'City' },
      { key: 'state', label: 'State' },
      { key: 'zip', label: 'Zip' },
      { key: 'vehicleYear', label: 'Vehicle Year' },
      { key: 'vehicleMake', label: 'Vehicle Make' },
      { key: 'vehicleModel', label: 'Vehicle Model' },
      { key: 'currentInsurance', label: 'Current Insurance' },
      { key: 'currentPremium', label: 'Current Premium' },
      { key: 'callbackTime', label: 'Callback Time' },
      { key: 'tmNotes', label: 'TM Notes' },
      { key: 'saleProduct', label: 'Sale Product' },
      { key: (l) => l.salePremiumCents ? (l.salePremiumCents / 100).toFixed(2) : '', label: 'Sale Premium ($)' },
    ]);
  }

  const telemarketers = useMemo(() => {
    const byId = new Map();
    for (const lead of leads) {
      if (lead.createdBy && !byId.has(lead.createdBy.id)) byId.set(lead.createdBy.id, lead.createdBy);
    }
    return [...byId.values()];
  }, [leads]);

  const visibleLeads = useMemo(
    () => (tmFilter ? leads.filter((l) => l.createdBy?.id === tmFilter) : leads),
    [leads, tmFilter]
  );

  function toggleSelected(leadId) {
    setSelectedIds((prev) => (prev.includes(leadId) ? prev.filter((id) => id !== leadId) : [...prev, leadId]));
  }

  function toggleSelectAllVisible() {
    const visibleIds = visibleLeads.map((l) => l.id);
    const allSelected = visibleIds.length > 0 && visibleIds.every((id) => selectedIds.includes(id));
    setSelectedIds(allSelected ? [] : visibleIds);
  }

  async function applyBulkStatus() {
    setBulkBusy(true);
    setBulkError('');
    try {
      const results = await Promise.allSettled(
        selectedIds.map((id) => api.dispositionLead(id, { status: bulkStatus }))
      );
      const failed = results.filter((r) => r.status === 'rejected').length;
      if (failed > 0) setBulkError(`${failed} of ${selectedIds.length} lead(s) failed to update.`);
      setSelectedIds([]);
      await load();
    } finally {
      setBulkBusy(false);
    }
  }

  return (
    <div style={s.wrap}>
      <SectionHeader right={leads.length > 0 && <ExportButton onExport={exportAllLeads} />}>YIELD TRANSFERS</SectionHeader>
      {error && <div style={s.error}>{error}</div>}

      {telemarketers.length > 1 && (
        <div style={s.tmFilterRow}>
          <button
            type="button"
            style={s.tmChip(tmFilter === null)}
            onClick={() => setTmFilter(null)}
          >
            All
          </button>
          {telemarketers.map((tm) => (
            <button
              key={tm.id}
              type="button"
              style={s.tmChip(tmFilter === tm.id)}
              onClick={() => setTmFilter(tmFilter === tm.id ? null : tm.id)}
            >
              <span style={s.tmDot(tmColor(tm.id))} />
              {tm.firstName} {tm.lastName}
            </button>
          ))}
        </div>
      )}

      {selectedIds.length > 0 && (
        <Card style={s.bulkBar}>
          <span style={s.bulkCount}>{selectedIds.length} selected</span>
          <select style={s.select} value={bulkStatus} onChange={(e) => setBulkStatus(e.target.value)}>
            {BULK_STATUSES.map((st) => <option key={st} value={st}>{st.replace(/_/g, ' ')}</option>)}
          </select>
          <Button variant="primary" size="sm" disabled={bulkBusy} onClick={applyBulkStatus}>
            {bulkBusy ? 'APPLYING…' : `APPLY TO ${selectedIds.length}`}
          </Button>
          <Button variant="ghost" size="sm" onClick={() => setSelectedIds([])}>CLEAR</Button>
          {bulkError && <span style={s.bulkError}>{bulkError}</span>}
        </Card>
      )}

      <div style={isMobile ? s.stacked : s.split}>
        <div style={s.leadsColumn}>
          {visibleLeads.length === 0 ? (
            <EmptyState
              title="No leads yet"
              description="Telemarketer submissions land here the instant they're sent — nothing to accept or reject, just real leads to work."
            />
          ) : (
            <>
              <button type="button" style={s.selectAllLink} onClick={toggleSelectAllVisible}>
                {visibleLeads.every((l) => selectedIds.includes(l.id)) ? 'Deselect all' : 'Select all visible'}
              </button>
              {visibleLeads.map((lead) => (
                <LeadCard
                  key={lead.id}
                  lead={lead}
                  onDisposition={load}
                  onDiscuss={() => setDiscussLead(lead)}
                  selected={selectedIds.includes(lead.id)}
                  onToggleSelected={() => toggleSelected(lead.id)}
                />
              ))}
            </>
          )}
        </div>

        <div style={s.chatColumn}>
          <ChatThread entityType="AGENCY" entityId={user.agencyId} variant="inline" title="TEAM CHAT" />
        </div>
      </div>

      {discussLead && (
        <ChatThread
          entityType="LEAD"
          entityId={discussLead.id}
          title={`DISCUSS · ${discussLead.customer?.firstName || 'Lead'} ${discussLead.customer?.lastName || ''}`}
          onClose={() => setDiscussLead(null)}
        />
      )}
    </div>
  );
}

function InfoRow({ icon, children }) {
  if (!children) return null;
  return <div style={s.infoRow}><span style={s.infoIcon}>{icon}</span>{children}</div>;
}

function LeadCard({ lead, onDisposition, onDiscuss, selected, onToggleSelected }) {
  const c = lead.customer;
  const vehicle = [lead.vehicleYear, lead.vehicleMake, lead.vehicleModel].filter(Boolean).join(' ');
  const home = [lead.ownRent, lead.homeAge && `${lead.homeAge} yrs old`, lead.sqFootage && `${lead.sqFootage} sq ft`].filter(Boolean).join(' · ');
  const carrier = [lead.currentInsurance, lead.currentPremium && `$${lead.currentPremium}/mo`, lead.yearsWithCarrier].filter(Boolean).join(' · ');

  return (
    <Card style={selected ? { ...s.card, ...s.cardSelected } : s.card}>
      <div style={s.cardTop} className="ui-row-stack">
        <div style={s.cardTopLeft}>
          <input type="checkbox" style={s.checkbox} checked={selected} onChange={onToggleSelected} />
          <div>
            <div style={s.name}>
              {c ? `${c.firstName} ${c.lastName}` : 'Lead'}
              {lead.product && <Badge tone="neutral" style={{ marginLeft: 8 }}>{lead.product}</Badge>}
            </div>
            <div style={s.meta}>
              {lead.createdBy && <span style={s.tmBadge(tmColor(lead.createdBy.id))} title={`${lead.createdBy.firstName} ${lead.createdBy.lastName}`}>{tmInitials(lead.createdBy)}</span>}
              Submitted by {lead.createdBy ? `${lead.createdBy.firstName} ${lead.createdBy.lastName}` : 'a telemarketer'} · {new Date(lead.receivedAt).toLocaleString()}
            </div>
          </div>
        </div>
        <Badge tone={statusTone(lead.status)}>{lead.status.replace(/_/g, ' ')}</Badge>
      </div>

      <div style={s.infoGrid}>
        <InfoRow icon="📞">{c?.phone || null}</InfoRow>
        <InfoRow icon="✉️">{c?.email || null}</InfoRow>
        <InfoRow icon="🏠">{[lead.address, lead.city, lead.state, lead.zip].filter(Boolean).join(', ') || null}</InfoRow>
        <InfoRow icon="🎂">{lead.dob ? `DOB: ${new Date(lead.dob).toLocaleDateString()}` : null}</InfoRow>
        <InfoRow icon="🚗">{vehicle || null}</InfoRow>
        <InfoRow icon="🏘️">{home || null}</InfoRow>
        <InfoRow icon="🏢">{carrier || null}</InfoRow>
        <InfoRow icon="📅">{lead.callbackTime ? `Callback: ${lead.callbackTime}` : null}</InfoRow>
      </div>

      {lead.tmNotes && (
        <div style={s.notesBox}>
          <strong style={s.notesLabel}>TM Notes:</strong> {lead.tmNotes}
        </div>
      )}

      <div style={s.cardActions}>
        <DispositionControl lead={lead} onDone={onDisposition} />
        <Button variant="secondary" size="sm" onClick={onDiscuss}>DISCUSS</Button>
      </div>
    </Card>
  );
}

function DispositionControl({ lead, onDone }) {
  const [status, setStatus] = useState(lead.status);
  const [premium, setPremium] = useState('');
  const [saleProduct, setSaleProduct] = useState(lead.product || '');
  const [busy, setBusy] = useState(false);

  async function submit() {
    if (status === lead.status) return;
    setBusy(true);
    try {
      await api.dispositionLead(lead.id, {
        status,
        saleProduct: status === 'SOLD' ? saleProduct : undefined,
        salePremiumCents: status === 'SOLD' && premium ? Math.round(parseFloat(premium) * 100) : undefined,
      });
      onDone();
    } finally {
      setBusy(false);
    }
  }

  return (
    <div style={s.dispositionRow}>
      <select style={s.select} value={status} onChange={(e) => setStatus(e.target.value)}>
        {LEAD_STATUSES.map((st) => <option key={st} value={st}>{st.replace(/_/g, ' ')}</option>)}
      </select>
      {status === 'SOLD' && (
        <input style={s.miniInput} placeholder="Premium $" value={premium} onChange={(e) => setPremium(e.target.value)} />
      )}
      <Button variant="primary" size="sm" disabled={busy || status === lead.status} onClick={submit}>SAVE</Button>
    </div>
  );
}

const s = {
  wrap: {},
  error: { color: 'var(--danger)', marginBottom: 12, fontSize: 13 },
  tmFilterRow: { display: 'flex', gap: 8, flexWrap: 'wrap', marginBottom: 12 },
  tmChip: (active) => ({
    display: 'flex', alignItems: 'center', gap: 6, padding: '6px 12px', borderRadius: 6, fontSize: 12, fontWeight: 600, cursor: 'pointer',
    background: active ? 'var(--accent-gradient-soft)' : 'var(--bg-elevated)', color: active ? 'var(--accent)' : 'var(--text-secondary)',
    border: `1px solid ${active ? 'var(--border-accent)' : 'var(--border-hairline)'}`,
  }),
  tmDot: (color) => ({ width: 8, height: 8, borderRadius: '50%', background: color, flexShrink: 0 }),
  tmBadge: (color) => ({
    display: 'inline-flex', alignItems: 'center', justifyContent: 'center', width: 18, height: 18, borderRadius: '50%',
    background: color, color: '#0a0a0a', fontSize: 9, fontWeight: 700, marginRight: 6, verticalAlign: 'middle',
  }),
  bulkBar: { display: 'flex', alignItems: 'center', gap: 10, padding: '10px 14px', marginBottom: 12, flexWrap: 'wrap' },
  bulkCount: { fontSize: 12, fontWeight: 700, color: 'var(--text-primary)' },
  bulkError: { color: 'var(--danger)', fontSize: 12 },
  selectAllLink: { background: 'none', border: 'none', color: 'var(--accent)', fontSize: 11, cursor: 'pointer', padding: '2px 0', textAlign: 'left', alignSelf: 'flex-start' },
  split: { display: 'grid', gridTemplateColumns: '1fr 360px', gap: 20, alignItems: 'start' },
  stacked: { display: 'flex', flexDirection: 'column', gap: 20 },
  leadsColumn: { display: 'flex', flexDirection: 'column', gap: 12, minWidth: 0 },
  chatColumn: { position: 'sticky', top: 0, height: 560 },
  card: {},
  cardSelected: { outline: '2px solid var(--accent)', outlineOffset: -1 },
  cardTop: { display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start', marginBottom: 12, gap: 8 },
  cardTopLeft: { display: 'flex', alignItems: 'flex-start', gap: 10 },
  checkbox: { marginTop: 4, width: 16, height: 16, cursor: 'pointer', flexShrink: 0 },
  name: { fontWeight: 700, fontSize: 16, color: 'var(--text-primary)' },
  meta: { color: 'var(--text-muted)', fontSize: 11, marginTop: 2, display: 'flex', alignItems: 'center' },
  infoGrid: { display: 'grid', gridTemplateColumns: '1fr 1fr', gap: '4px 20px', fontSize: 12, color: 'var(--text-secondary)', marginBottom: 10 },
  infoRow: { display: 'flex', gap: 6, alignItems: 'baseline' },
  infoIcon: { flexShrink: 0 },
  notesBox: {
    background: 'var(--accent-gradient-soft)', border: '1px solid var(--border-accent)', borderRadius: 'var(--radius-sm)',
    padding: 10, fontSize: 12, color: 'var(--text-secondary)', marginBottom: 10, lineHeight: 1.5,
  },
  notesLabel: { color: 'var(--accent)' },
  cardActions: { display: 'flex', justifyContent: 'space-between', alignItems: 'center', gap: 8, flexWrap: 'wrap', paddingTop: 8, borderTop: '1px solid var(--border-hairline)' },
  dispositionRow: { display: 'flex', gap: 6, alignItems: 'center', flexWrap: 'wrap' },
  select: { padding: '6px 8px', background: 'var(--bg-sunken)', border: '1px solid var(--border-strong)', borderRadius: 6, color: 'var(--text-primary)', fontSize: 12 },
  miniInput: { padding: '6px 8px', background: 'var(--bg-sunken)', border: '1px solid var(--border-strong)', borderRadius: 6, color: 'var(--text-primary)', fontSize: 12, width: 90 },
};
