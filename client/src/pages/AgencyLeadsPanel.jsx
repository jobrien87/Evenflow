import { useEffect, useRef, useState } from 'react';
import { useSearchParams } from 'react-router-dom';
import { api } from '../lib/api';
import { useAuth } from '../lib/AuthContext';
import { Button, LeadTypeIcon, EmptyState } from '../ui';
import LeadDetailModal from './LeadDetailModal';
import BulkLeadUploadBox from './BulkLeadUploadBox';
import AddClosedSaleModal from './AddClosedSaleModal';
import LeadSearchBox from './LeadSearchBox';

// Extracted out of AgencyOwnerDashboard (Main Stage) into its own "Leads"
// tab — same real data/actions (bulk upload, manual add, the leads list,
// the funnel drill-down filter carried in the URL), just its own page
// instead of living inside the Main Stage overview.
export default function AgencyLeadsPanel() {
  const { user } = useAuth();
  const [searchParams, setSearchParams] = useSearchParams();
  const [leads, setLeads] = useState([]);
  const [producers, setProducers] = useState([]);
  const [openLeadId, setOpenLeadId] = useState(null);
  const [showAddLead, setShowAddLead] = useState(false);
  const [showUpload, setShowUpload] = useState(false);
  const [showAddSale, setShowAddSale] = useState(false);
  const [leadForm, setLeadForm] = useState({ firstName: '', lastName: '', phone: '', email: '', product: 'Auto', assignedToId: '' });
  const [leadStatus, setLeadStatus] = useState('');
  const [loadError, setLoadError] = useState('');

  const stage = searchParams.get('stage');
  const from = searchParams.get('from');
  const to = searchParams.get('to');
  const stageFilter = stage && from && to ? { stage, from, to } : null;
  const highlightId = searchParams.get('highlight');
  const handledHighlightRef = useRef(false);

  useEffect(() => {
    load();
  }, [stage, from, to]);

  useEffect(() => {
    if (!highlightId || handledHighlightRef.current || leads.length === 0) return;
    if (!leads.some((l) => l.id === highlightId)) return;
    handledHighlightRef.current = true;
    document.getElementById(`lead-${highlightId}`)?.scrollIntoView({ behavior: 'smooth', block: 'center' });
  }, [highlightId, leads]);

  async function load() {
    setLoadError('');
    const leadParams = stageFilter
      ? `?stage=${stageFilter.stage}&from=${stageFilter.from}&to=${stageFilter.to}`
      : '';
    try {
      const [leadData, userData] = await Promise.all([api.leads(leadParams), api.users('')]);
      setLeads(leadData.leads);
      setProducers(userData.users.filter((u) => u.role === 'PRODUCER' && u.status === 'ACTIVE'));
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
      setLeadForm({ firstName: '', lastName: '', phone: '', email: '', product: 'Auto', assignedToId: '' });
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
        <h3 style={s.h3}>LEADS ({leads.length}){stageFilter ? ` · ${stageFilter.stage.toUpperCase()}` : ''}</h3>
        <div style={{ display: 'flex', gap: 8 }}>
          {stageFilter && (
            <button style={s.smallButtonOutline} onClick={clearStageFilter}>CLEAR FILTER</button>
          )}
          <button style={s.smallButtonOutline} onClick={() => setShowUpload(!showUpload)}>UPLOAD LEADS</button>
          <button style={s.smallButtonOutline} onClick={() => setShowAddSale(true)}>+ ADD CLOSED SALE</button>
          <button style={s.smallButton} onClick={() => setShowAddLead(!showAddLead)}>+ ADD LEAD</button>
        </div>
      </div>
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
            <option>Auto</option><option>Home</option><option>Home and Auto Bundle</option><option>Life</option><option>Health</option>
          </select>
          <select style={s.input} value={leadForm.assignedToId} onChange={(e) => setLeadForm({ ...leadForm, assignedToId: e.target.value })}>
            <option value="">Unassigned</option>
            {producers.map((p) => <option key={p.id} value={p.id}>{p.firstName} {p.lastName}</option>)}
          </select>
          <button style={s.submitButton} type="submit">Create Lead</button>
        </form>
      )}
      {leadStatus && <div style={s.status}>{leadStatus}</div>}
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
  smallButtonOutline: { padding: '8px 14px', background: 'transparent', border: '1px solid var(--border-strong)', color: 'var(--text-secondary)', borderRadius: 6, fontWeight: 700, cursor: 'pointer', fontSize: 12 },
  form: { display: 'flex', flexDirection: 'column', gap: 10, background: 'var(--bg-elevated)', padding: 16, borderRadius: 8, marginBottom: 12, border: '1px solid var(--border-hairline)' },
  input: { padding: '10px 12px', background: 'var(--bg-sunken)', border: '1px solid var(--border-strong)', borderRadius: 6, color: 'var(--text-primary)' },
  submitButton: { padding: '10px 16px', background: 'var(--accent)', border: 'none', borderRadius: 6, fontWeight: 700, cursor: 'pointer' },
  status: { color: 'var(--accent)', marginBottom: 12, fontSize: 13 },
  row: { display: 'flex', justifyContent: 'space-between', alignItems: 'center', background: 'var(--bg-elevated)', border: '1px solid var(--border-hairline)', borderRadius: 8, padding: 14, marginBottom: 8 },
  rowTitle: { fontWeight: 600, fontSize: 14 },
  rowSub: { color: 'var(--text-muted)', fontSize: 12 },
  badge: { fontSize: 11, color: 'var(--text-secondary)', border: '1px solid var(--border-strong)', padding: '4px 8px', borderRadius: 4 },
  empty: { color: 'var(--text-muted)', fontStyle: 'italic' },
};
