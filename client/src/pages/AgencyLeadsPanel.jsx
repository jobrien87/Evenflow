import { useEffect, useRef, useState } from 'react';
import { useSearchParams } from 'react-router-dom';
import { api } from '../lib/api';
import { useAuth } from '../lib/AuthContext';
import { Button, Card, LeadTypeIcon, EmptyState } from '../ui';
import LeadDetailModal from './LeadDetailModal';
import BulkLeadUploadBox from './BulkLeadUploadBox';
import AddClosedSaleModal from './AddClosedSaleModal';
import LeadSearchBox from './LeadSearchBox';
import { LeadTypeSortControls, LeadPager, LEAD_PAGE_SIZE } from '../ui/LeadListControls';
import { LEAD_TYPE_LABELS } from '../lib/leadTypeMeta';

// Extracted out of AgencyOwnerDashboard (Main Stage) into its own "Leads"
// tab — same real data/actions (bulk upload, manual add, the leads list,
// the funnel drill-down filter carried in the URL), just its own page
// instead of living inside the Main Stage overview.
export default function AgencyLeadsPanel() {
  const { user } = useAuth();
  const isManager = user?.role === 'AGENCY_MANAGER';
  const [searchParams, setSearchParams] = useSearchParams();
  const [leads, setLeads] = useState([]);
  const [producers, setProducers] = useState([]);
  const [vendors, setVendors] = useState([]);
  const [openLeadId, setOpenLeadId] = useState(null);
  const [showAddLead, setShowAddLead] = useState(false);
  const [showUpload, setShowUpload] = useState(false);
  const [showAddSale, setShowAddSale] = useState(false);
  const [leadForm, setLeadForm] = useState({ firstName: '', lastName: '', phone: '', email: '', product: 'Auto', assignedToId: '', leadTypeOverride: '', vendorId: '', isLiveTransfer: false });
  const [leadStatus, setLeadStatus] = useState('');
  const [total, setTotal] = useState(0);
  const [typeFilter, setTypeFilter] = useState('');
  const [sort, setSort] = useState('priority');
  const [page, setPage] = useState(1);
  const [loadError, setLoadError] = useState('');
  // Real server-side scope for a Manager, not a client-side filter of the
  // already-fetched agency-wide list: 'all' sends no assignedToId param
  // (today's existing agency-wide behavior, unchanged for Owner/Platform
  // Owner, who have no toggle at all); 'mine' re-fetches with
  // assignedToId=self so a selling Manager can see just her own book.
  const [scopeMode, setScopeMode] = useState('all');
  // Whole-agency open-lead workload snapshot — independent of the scope/
  // filter/page state above, since the point is visibility into every
  // producer's own pile, not just whatever's currently being viewed.
  const [producerCounts, setProducerCounts] = useState(null);
  const [showProducerCounts, setShowProducerCounts] = useState(true);

  const stage = searchParams.get('stage');
  const from = searchParams.get('from');
  const to = searchParams.get('to');
  const stageFilter = stage && from && to ? { stage, from, to } : null;
  const highlightId = searchParams.get('highlight');
  const handledHighlightRef = useRef(false);

  useEffect(() => {
    load();
  }, [stage, from, to, scopeMode, typeFilter, sort, page]);

  useEffect(() => {
    api.leadCountsByProducer().then((data) => {
      const sorted = [...data.producers].sort((a, b) => b.openCount - a.openCount);
      setProducerCounts({ producers: sorted, unassignedCount: data.unassignedCount });
    }).catch(() => {
      // Non-critical to the main leads list — fails silently, same
      // convention as this page's own vendor/producer-picker loads.
    });
  }, []);

  useEffect(() => {
    if (!highlightId || handledHighlightRef.current || leads.length === 0) return;
    if (!leads.some((l) => l.id === highlightId)) return;
    handledHighlightRef.current = true;
    document.getElementById(`lead-${highlightId}`)?.scrollIntoView({ behavior: 'smooth', block: 'center' });
  }, [highlightId, leads]);

  async function load() {
    setLoadError('');
    const params = new URLSearchParams({ pageSize: String(LEAD_PAGE_SIZE), page: String(page), sort });
    if (typeFilter) params.set('leadType', typeFilter);
    if (stageFilter) {
      params.set('stage', stageFilter.stage);
      params.set('from', stageFilter.from);
      params.set('to', stageFilter.to);
    }
    if (isManager && scopeMode === 'mine' && user?.id) {
      params.set('assignedToId', user.id);
    }
    const qs = params.toString();
    try {
      const [leadData, userData, vendorData] = await Promise.all([api.leads(qs ? `?${qs}` : ''), api.users(''), api.vendors()]);
      setLeads(leadData.leads);
      setTotal(leadData.total);
      // A selling AGENCY_MANAGER (e.g. Julie) must be a selectable credit
      // target here too, not just a plain PRODUCER — same
      // eligible-production-roles rule as Closed Sale's own producer
      // picker and eligibleProducersQuery.js.
      setProducers(userData.users.filter((u) => ['PRODUCER', 'AGENCY_MANAGER'].includes(u.role) && u.status === 'ACTIVE'));
      setVendors(vendorData.vendors || []);
    } catch (err) {
      setLoadError(err.data?.message || 'Could not load your leads. Try refreshing.');
    }
  }

  function clearStageFilter() {
    setSearchParams({});
  }

  async function addLead(e) {
    e.preventDefault();
    setLeadStatus('Creating…');
    try {
      await api.createLead(leadForm);
      setLeadStatus('Lead created.');
      setLeadForm({ firstName: '', lastName: '', phone: '', email: '', product: 'Auto', assignedToId: '', leadTypeOverride: '', vendorId: '', isLiveTransfer: false });
      setShowAddLead(false);
      await load();
    } catch (err) {
      setLeadStatus(err.data?.message || 'Failed to create lead.');
    }
  }

  if (loadError && leads.length === 0) {
    return <EmptyState title="Couldn't load leads" description={loadError} />;
  }

  return (
    <div style={s.wrap}>
      {loadError && (
        <div style={s.loadErrorBox}>
          {loadError}
          <Button variant="secondary" size="sm" onClick={load}>RETRY</Button>
        </div>
      )}

      <div style={s.headerRow}>
        <h3 style={s.h3}>LEADS ({total}){stageFilter ? ` · ${stageFilter.stage.toUpperCase()}` : ''}{isManager ? ` · ${scopeMode === 'mine' ? 'MY LEADS' : 'ALL LEADS'}` : ''}</h3>
        <div style={{ display: 'flex', gap: 8 }}>
          {isManager && (
            <div style={s.scopeToggle}>
              <button style={scopeMode === 'all' ? s.scopeButtonActive : s.scopeButton} onClick={() => { setScopeMode('all'); setPage(1); }}>ALL LEADS</button>
              <button style={scopeMode === 'mine' ? s.scopeButtonActive : s.scopeButton} onClick={() => { setScopeMode('mine'); setPage(1); }}>MY LEADS</button>
            </div>
          )}
          {stageFilter && (
            <button style={s.smallButtonOutline} onClick={clearStageFilter}>CLEAR FILTER</button>
          )}
          <button style={s.smallButtonOutline} onClick={() => setShowUpload(!showUpload)} data-tour="leads-bulk-upload-button">UPLOAD LEADS</button>
          <button style={s.smallButtonOutline} onClick={() => setShowAddSale(true)}>+ ADD CLOSED SALE</button>
          <button style={s.smallButton} onClick={() => setShowAddLead(!showAddLead)} data-tour="leads-add-button">+ ADD LEAD</button>
        </div>
      </div>
      {producerCounts && (
        <Card style={s.producerCountsCard}>
          <div style={s.producerCountsHeader}>
            <div style={s.producerCountsTitle}>LEADS BY PRODUCER (open/workable)</div>
            <button style={s.smallButtonOutline} onClick={() => setShowProducerCounts((v) => !v)}>
              {showProducerCounts ? 'HIDE' : 'SHOW'}
            </button>
          </div>
          {showProducerCounts && (
            <div style={s.producerCountsGrid}>
              {producerCounts.producers.map((p) => (
                <div key={p.id} style={s.producerCountRow}>
                  <span style={s.producerCountName}>{p.firstName} {p.lastName}</span>
                  <span style={s.producerCountValue}>{p.openCount}</span>
                </div>
              ))}
              {producerCounts.unassignedCount > 0 && (
                <div style={s.producerCountRow}>
                  <span style={s.producerCountName}>Unassigned</span>
                  <span style={s.producerCountValue}>{producerCounts.unassignedCount}</span>
                </div>
              )}
            </div>
          )}
        </Card>
      )}

      {showUpload && (
        <BulkLeadUploadBox agencyId={user?.agencyId} onImported={load} />
      )}
      {showAddSale && (
        <AddClosedSaleModal onClose={() => setShowAddSale(false)} onSaved={load} />
      )}

      <div style={{ marginBottom: 18 }}>
        <LeadSearchBox />
      </div>
      {showAddLead && (
        <form onSubmit={addLead} style={s.form}>
          <input style={s.input} placeholder="First name" value={leadForm.firstName} onChange={(e) => setLeadForm({ ...leadForm, firstName: e.target.value })} required />
          <input style={s.input} placeholder="Last name" value={leadForm.lastName} onChange={(e) => setLeadForm({ ...leadForm, lastName: e.target.value })} required />
          <input style={s.input} placeholder="Phone" value={leadForm.phone} onChange={(e) => setLeadForm({ ...leadForm, phone: e.target.value })} />
          <input style={s.input} type="email" placeholder="Email (optional)" value={leadForm.email} onChange={(e) => setLeadForm({ ...leadForm, email: e.target.value })} />
          <select style={s.input} value={leadForm.product} onChange={(e) => setLeadForm({ ...leadForm, product: e.target.value })}>
            <option>Auto</option><option>Home</option><option>Home and Auto Bundle</option><option>Life</option><option>Health</option><option>Boat</option><option>Motorcycle</option>
          </select>
          <select style={s.input} value={leadForm.leadTypeOverride} onChange={(e) => setLeadForm({ ...leadForm, leadTypeOverride: e.target.value })}>
            <option value="">Lead Source — auto-detect</option>
            {Object.entries(LEAD_TYPE_LABELS).map(([value, label]) => <option key={value} value={value}>{label}</option>)}
          </select>
          <select style={s.input} value={leadForm.vendorId} onChange={(e) => setLeadForm({ ...leadForm, vendorId: e.target.value })}>
            <option value="">No vendor</option>
            {vendors.map((v) => <option key={v.id} value={v.id}>{v.vendorBrand || v.name}</option>)}
          </select>
          <select style={s.input} value={leadForm.assignedToId} onChange={(e) => setLeadForm({ ...leadForm, assignedToId: e.target.value })}>
            <option value="">Unassigned</option>
            {producers.map((p) => <option key={p.id} value={p.id}>{p.firstName} {p.lastName}</option>)}
          </select>
          <label style={s.liveTransferRow}>
            <input
              type="checkbox"
              checked={leadForm.isLiveTransfer}
              onChange={(e) => setLeadForm({ ...leadForm, isLiveTransfer: e.target.checked })}
            />
            This is a live transfer — the caller is on the line right now
          </label>
          <button style={s.submitButton} type="submit">Create Lead</button>
        </form>
      )}
      {leadStatus && <div style={s.status}>{leadStatus}</div>}
      <div style={{ display: 'flex', gap: 10, alignItems: 'center', flexWrap: 'wrap', marginBottom: 12 }}>
        <LeadTypeSortControls leadType={typeFilter} sort={sort} onLeadType={(v) => { setTypeFilter(v); setPage(1); }} onSort={(v) => { setSort(v); setPage(1); }} />
      </div>
      {leads.map((l) => (
        <div
          key={l.id}
          id={`lead-${l.id}`}
          style={l.id === highlightId ? { ...s.row, ...s.rowHighlighted } : s.row}
          className="ui-row-stack"
          onClick={() => setOpenLeadId(l.id)}
        >
          <div>
            <div style={{ ...s.rowTitle, cursor: 'pointer', textDecoration: 'underline' }}>
              <LeadTypeIcon type={l.leadType} product={l.product} crossSellHaveProduct={l.crossSellHaveProduct} style={{ marginRight: 6, textDecoration: 'none' }} />
              {l.customer ? `${l.customer.firstName} ${l.customer.lastName}` : 'Lead'}
            </div>
            <div style={s.rowSub}>{l.product || l.source} · {l.assignedTo ? `${l.assignedTo.firstName} ${l.assignedTo.lastName}` : 'Unassigned'}</div>
          </div>
          <div style={s.badge}>{l.status}</div>
        </div>
      ))}
      {leads.length === 0 && <div style={s.empty}>No leads yet.</div>}
      <LeadPager page={page} total={total} onPage={setPage} />

      {openLeadId && (
        <LeadDetailModal leadId={openLeadId} onClose={() => setOpenLeadId(null)} onChanged={load} />
      )}
    </div>
  );
}

const s = {
  wrap: { color: 'var(--text-primary)' },
  loadErrorBox: { background: 'var(--danger-soft)', border: '1px solid rgba(255, 77, 94, 0.4)', color: 'var(--danger)', padding: 16, borderRadius: 8, fontSize: 13, display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 12, marginBottom: 24 },
  headerRow: { display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 12, flexWrap: 'wrap', gap: 10 },
  h3: { color: 'var(--text-secondary)', fontSize: 12, letterSpacing: 2 },
  rowHighlighted: { outline: '2px solid var(--accent)', boxShadow: 'var(--shadow-glow-accent)', borderRadius: 'var(--radius-md)' },
  smallButton: { padding: '8px 14px', background: 'var(--accent)', border: 'none', borderRadius: 6, fontWeight: 700, cursor: 'pointer', fontSize: 12 },
  scopeToggle: { display: 'flex', border: '1px solid var(--border-strong)', borderRadius: 6, overflow: 'hidden' },
  scopeButton: { padding: '8px 12px', background: 'transparent', border: 'none', color: 'var(--text-secondary)', fontWeight: 700, cursor: 'pointer', fontSize: 12 },
  scopeButtonActive: { padding: '8px 12px', background: 'var(--accent)', border: 'none', color: 'var(--bg)', fontWeight: 700, cursor: 'pointer', fontSize: 12 },
  smallButtonOutline: { padding: '8px 14px', background: 'transparent', border: '1px solid var(--border-strong)', color: 'var(--text-secondary)', borderRadius: 6, fontWeight: 700, cursor: 'pointer', fontSize: 12 },
  form: { display: 'flex', flexDirection: 'column', gap: 10, background: 'var(--bg-elevated)', padding: 16, borderRadius: 8, marginBottom: 12, border: '1px solid var(--border-hairline)' },
  input: { padding: '10px 12px', background: 'var(--bg-sunken)', border: '1px solid var(--border-strong)', borderRadius: 6, color: 'var(--text-primary)' },
  liveTransferRow: { display: 'flex', alignItems: 'center', gap: 8, fontSize: 12, color: 'var(--warning)', background: 'var(--warning-soft)', border: '1px solid rgba(255, 184, 77, 0.4)', borderRadius: 8, padding: '8px 12px', margin: '4px 0 8px' },
  submitButton: { padding: '10px 16px', background: 'var(--accent)', border: 'none', borderRadius: 6, fontWeight: 700, cursor: 'pointer' },
  status: { color: 'var(--accent)', marginBottom: 12, fontSize: 13 },
  row: { display: 'flex', justifyContent: 'space-between', alignItems: 'center', background: 'var(--bg-elevated)', border: '1px solid var(--border-hairline)', borderRadius: 8, padding: 14, marginBottom: 8 },
  rowTitle: { fontWeight: 600, fontSize: 14 },
  rowSub: { color: 'var(--text-muted)', fontSize: 12 },
  badge: { fontSize: 11, color: 'var(--text-secondary)', border: '1px solid var(--border-strong)', padding: '4px 8px', borderRadius: 4 },
  empty: { color: 'var(--text-muted)', fontStyle: 'italic' },
  producerCountsCard: { marginBottom: 18, padding: 14 },
  producerCountsHeader: { display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 10 },
  producerCountsTitle: { fontSize: 11, letterSpacing: 1, color: 'var(--text-muted)', fontWeight: 700, textTransform: 'uppercase' },
  producerCountsGrid: { display: 'flex', flexWrap: 'wrap', gap: 8 },
  producerCountRow: { display: 'flex', alignItems: 'center', gap: 8, padding: '6px 12px', background: 'var(--bg-sunken)', border: '1px solid var(--border-hairline)', borderRadius: 8, fontSize: 13 },
  producerCountName: { color: 'var(--text-secondary)' },
  producerCountValue: { color: 'var(--text-primary)', fontWeight: 700 },
};
