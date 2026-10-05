import { useEffect, useState } from 'react';
import { useAuth } from '../lib/AuthContext';
import { api } from '../lib/api';
import { Card, Badge, Button, SectionHeader, StatTile, DateRangeFilter, EmptyState, LeadTypeIcon } from '../ui';
import { resolveDateRange } from '../lib/dateRange';
import LeadDetailModal from './LeadDetailModal';

const PERIODS = [
  { key: 'month', label: 'This month', from: () => { const d = new Date(); return new Date(d.getFullYear(), d.getMonth(), 1); } },
  { key: 'quarter', label: 'This quarter', from: () => { const d = new Date(); return new Date(d.getFullYear(), Math.floor(d.getMonth() / 3) * 3, 1); } },
  { key: 'week', label: 'This week', from: () => { const d = new Date(); const day = d.getDay(); return new Date(d.getFullYear(), d.getMonth(), d.getDate() - day); } },
];

function statusTone(status) {
  if (status === 'SOLD') return 'accent';
  if (['LOST', 'BAD_CONTACT', 'DUPLICATE', 'DO_NOT_CONTACT'].includes(status)) return 'danger';
  if (status === 'NEW') return 'warning';
  return 'neutral';
}

const pct = (v) => (v === null || v === undefined ? '—' : `${v}%`);

export default function MyLeadsPanel() {
  const { user } = useAuth();
  const [periodKey, setPeriodKey] = useState('month');
  const [customFrom, setCustomFrom] = useState('');
  const [customTo, setCustomTo] = useState('');
  const [performance, setPerformance] = useState(null);
  const [leads, setLeads] = useState([]);
  const [total, setTotal] = useState(0);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [openLeadId, setOpenLeadId] = useState(null);
  const [statusFilter, setStatusFilter] = useState('');

  useEffect(() => {
    load();
  }, [periodKey, customFrom, customTo, user?.id]);

  useEffect(() => {
    loadLeads();
  }, [statusFilter, user?.id]);

  async function load() {
    if (!user?.id) return;
    const range = resolveDateRange(periodKey, PERIODS, customFrom, customTo);
    if (!range) return; // custom selected, dates not both picked yet
    setError('');
    try {
      const [perfRes] = await Promise.all([
        api.userPerformance(user.id, `?from=${range.from}&to=${range.to}`),
        loadLeads(),
      ]);
      setPerformance(perfRes);
    } catch (err) {
      setError(err.data?.message || 'Could not load your leads performance. Try refreshing.');
    } finally {
      setLoading(false);
    }
  }

  async function loadLeads() {
    try {
      const params = statusFilter ? `?status=${statusFilter}&pageSize=100` : '?pageSize=100';
      const data = await api.leads(params);
      setLeads(data.leads);
      setTotal(data.total);
    } catch {
      // Leave existing leads in place — the performance box above already
      // surfaces a load error banner for this same fetch cycle.
    }
  }

  const untouchedCount = leads.filter((l) => !l.firstAttemptAt).length;

  if (loading) return <div style={s.wrap}>Loading…</div>;

  return (
    <div style={s.wrap}>
      <div style={s.headerRow}>
        <h3 style={s.h3}>MY LEADS ({total})</h3>
        <DateRangeFilter
          presets={PERIODS.map((p) => ({ key: p.key, label: p.label.toUpperCase() }))}
          periodKey={periodKey}
          onSelectPreset={setPeriodKey}
          customFrom={customFrom}
          customTo={customTo}
          onCustomFromChange={setCustomFrom}
          onCustomToChange={setCustomTo}
        />
      </div>

      {error && (
        <div style={s.loadErrorBox}>
          {error}
          <button style={s.retryButton} onClick={load}>RETRY</button>
        </div>
      )}

      <section style={s.statsSection}>
        <SectionHeader>At a Glance</SectionHeader>
        <div style={s.statsRow}>
          <StatTile label="Total Leads" value={total} />
          <StatTile label="Untouched" value={untouchedCount} sub={untouchedCount > 0 ? 'need a first attempt' : 'all touched'} />
          <StatTile label="Contact Rate" value={pct(performance?.funnel?.contactRate)} />
          <StatTile label="Quote Rate" value={pct(performance?.funnel?.quoteRate)} />
          <StatTile label="Close Rate" value={pct(performance?.funnel?.closeRate)} />
        </div>
      </section>

      <section style={s.section}>
        <SectionHeader>Vendor Breakdown</SectionHeader>
        {(performance?.vendorBreakdown || []).length === 0 ? (
          <EmptyState title="No vendor leads yet this period" description="Once vendors send you leads, each one's numbers show up here." />
        ) : (
          <Card style={s.tableCard}>
            <div style={s.tableHeaderRow}>
              <span style={s.colVendor}>VENDOR</span>
              <span style={s.col}>LEADS</span>
              <span style={s.col}>UNTOUCHED</span>
              <span style={s.col}>CONTACT%</span>
              <span style={s.col}>QUOTE%</span>
              <span style={s.col}>CLOSE%</span>
            </div>
            {performance.vendorBreakdown.map((v) => (
              <div key={v.vendorId} style={s.tableRow}>
                <span style={s.colVendor}>{v.vendorName}</span>
                <span style={s.col}>{v.totalLeads}</span>
                <span style={s.col}>{v.untouched}</span>
                <span style={s.col}>{pct(v.contactRate)}</span>
                <span style={s.col}>{pct(v.quoteRate)}</span>
                <span style={s.col}>{pct(v.closeRate)}</span>
              </div>
            ))}
          </Card>
        )}
      </section>

      <section style={s.section}>
        <div style={s.headerRow}>
          <SectionHeader>Your Leads</SectionHeader>
          <select style={s.filterSelect} value={statusFilter} onChange={(e) => setStatusFilter(e.target.value)}>
            <option value="">All statuses</option>
            {['NEW', 'CONTACTED', 'APPOINTMENT', 'QUOTED', 'FOLLOW_UP', 'SOLD', 'LOST'].map((st) => (
              <option key={st} value={st}>{st.replace(/_/g, ' ')}</option>
            ))}
          </select>
        </div>

        {leads.length === 0 ? (
          <EmptyState title="No leads here yet" description="Leads assigned to you will show up in this list." />
        ) : (
          <Card style={s.tableCard}>
            <div style={s.leadHeaderRow}>
              <span style={s.colLeadName}>NAME</span>
              <span style={s.col}>VENDOR</span>
              <span style={s.col}>STATUS</span>
              <span style={s.col}>ACTIVITY</span>
              <span style={s.col}>RECEIVED</span>
            </div>
            {leads.map((lead) => (
              <div key={lead.id} style={s.leadRow} onClick={() => setOpenLeadId(lead.id)}>
                <span style={s.colLeadName}>
                  <LeadTypeIcon type={lead.leadType} style={{ marginRight: 6 }} />
                  {lead.customer ? `${lead.customer.firstName} ${lead.customer.lastName}` : 'Lead'}
                  {!lead.firstAttemptAt && <Badge tone="warning" style={{ marginLeft: 8 }}>UNTOUCHED</Badge>}
                </span>
                <span style={s.col}>{lead.vendor?.name || '—'}</span>
                <span style={s.col}><Badge tone={statusTone(lead.status)}>{lead.status.replace(/_/g, ' ')}</Badge></span>
                <span style={s.col}>{(lead._count?.activities || 0) + (lead._count?.notes || 0)}</span>
                <span style={s.col}>{new Date(lead.receivedAt).toLocaleDateString()}</span>
              </div>
            ))}
          </Card>
        )}
      </section>

      {openLeadId && (
        <LeadDetailModal leadId={openLeadId} onClose={() => setOpenLeadId(null)} onChanged={loadLeads} />
      )}
    </div>
  );
}

const s = {
  wrap: {},
  headerRow: { display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 16, flexWrap: 'wrap', gap: 10 },
  h3: { color: 'var(--text-secondary)', fontSize: 12, letterSpacing: 2 },
  loadErrorBox: { background: 'var(--danger-soft)', border: '1px solid rgba(255, 77, 94, 0.4)', color: 'var(--danger)', padding: 16, borderRadius: 8, fontSize: 13, display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 12, marginBottom: 16 },
  retryButton: { padding: '6px 12px', background: 'var(--accent)', border: 'none', borderRadius: 6, fontWeight: 700, cursor: 'pointer', fontSize: 11 },
  statsSection: { marginBottom: 24 },
  statsRow: { display: 'flex', gap: 32, flexWrap: 'wrap' },
  section: { marginBottom: 24 },
  tableCard: { padding: 0, overflow: 'hidden' },
  tableHeaderRow: { display: 'grid', gridTemplateColumns: '2fr 1fr 1fr 1fr 1fr 1fr', padding: '10px 16px', fontSize: 10, letterSpacing: 1, color: 'var(--text-muted)', fontWeight: 700, borderBottom: '1px solid var(--border-hairline)' },
  tableRow: { display: 'grid', gridTemplateColumns: '2fr 1fr 1fr 1fr 1fr 1fr', padding: '10px 16px', fontSize: 12, color: 'var(--text-primary)', borderBottom: '1px solid var(--border-hairline)' },
  colVendor: { fontWeight: 600 },
  col: { color: 'var(--text-secondary)' },
  leadHeaderRow: { display: 'grid', gridTemplateColumns: '2fr 1fr 1.2fr 0.8fr 1fr', padding: '10px 16px', fontSize: 10, letterSpacing: 1, color: 'var(--text-muted)', fontWeight: 700, borderBottom: '1px solid var(--border-hairline)' },
  leadRow: { display: 'grid', gridTemplateColumns: '2fr 1fr 1.2fr 0.8fr 1fr', padding: '12px 16px', fontSize: 12, color: 'var(--text-primary)', borderBottom: '1px solid var(--border-hairline)', cursor: 'pointer', alignItems: 'center' },
  colLeadName: { fontWeight: 600 },
  filterSelect: { padding: '8px 10px', background: 'var(--bg-sunken)', border: '1px solid var(--border-strong)', borderRadius: 6, color: 'var(--text-primary)', fontSize: 11 },
};
