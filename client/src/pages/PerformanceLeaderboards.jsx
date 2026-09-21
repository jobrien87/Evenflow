import { useEffect, useState } from 'react';
import { api } from '../lib/api';
import { Card, SectionHeader, Button, EmptyState, ExportButton } from '../ui';
import { downloadCsv } from '../lib/downloadCsv';

const PERIODS = [
  { key: 'month', label: 'This month', from: () => { const d = new Date(); return new Date(d.getFullYear(), d.getMonth(), 1); } },
  { key: 'quarter', label: 'This quarter', from: () => { const d = new Date(); return new Date(d.getFullYear(), Math.floor(d.getMonth() / 3) * 3, 1); } },
  { key: 'week', label: 'This week', from: () => { const d = new Date(); const day = d.getDay(); return new Date(d.getFullYear(), d.getMonth(), d.getDate() - day); } },
];

const money = (v) => (v === null || v === undefined ? '—' : `$${v.toLocaleString(undefined, { maximumFractionDigits: 2 })}`);
const pct = (v) => (v === null || v === undefined ? '—' : `${v}%`);

// Every number here is read straight from GET /financials/by-vendor and
// /financials/by-agent — real Lead/CostEvent/salePremiumCents data, same
// "quoted or beyond" definition funnelMetrics.js's quoteRate uses. No
// second, divergent computation of the same KPI.
export default function PerformanceLeaderboards({ agencyId, title = 'PERFORMANCE' }) {
  const [periodKey, setPeriodKey] = useState('month');
  const [vendors, setVendors] = useState(null);
  const [agents, setAgents] = useState(null);
  const [error, setError] = useState('');

  useEffect(() => {
    load();
  }, [periodKey, agencyId]);

  async function load() {
    if (!agencyId) return;
    try {
      const period = PERIODS.find((p) => p.key === periodKey);
      const from = period.from().toISOString();
      const to = new Date().toISOString();
      const params = `?agencyId=${agencyId}&from=${from}&to=${to}`;
      const [vendorRes, agentRes] = await Promise.all([api.financialByVendor(params), api.financialByAgent(params)]);
      setVendors([...vendorRes.vendors].sort((a, b) => b.revenue - a.revenue || b.salesCount - a.salesCount));
      setAgents([...agentRes.agents].sort((a, b) => b.revenue - a.revenue || b.salesCount - a.salesCount));
      setError('');
    } catch (err) {
      setError(err.data?.message || 'Could not load performance metrics.');
    }
  }

  return (
    <div>
      <SectionHeader
        right={
          <div style={s.periodRow}>
            {PERIODS.map((p) => (
              <Button key={p.key} size="sm" variant={p.key === periodKey ? 'primary' : 'secondary'} onClick={() => setPeriodKey(p.key)}>
                {p.label}
              </Button>
            ))}
          </div>
        }
      >
        {title}
      </SectionHeader>
      {error && <div style={s.error}>{error}</div>}

      <div style={s.grid}>
        <Card style={s.card}>
          <div style={s.cardHeaderRow}>
            <div style={s.cardTitle}>VENDOR LEADERBOARD</div>
            {vendors?.length > 0 && (
              <ExportButton onExport={() => downloadCsv('vendor-leaderboard', vendors, [
                { key: 'vendorName', label: 'Vendor' },
                { key: 'leadsReceived', label: 'Leads' },
                { key: 'quotesReceived', label: 'Quotes' },
                { key: 'salesCount', label: 'Sales' },
                { key: 'conversionRate', label: 'Conversion %' },
                { key: 'costPerLead', label: 'Cost/Lead ($)' },
                { key: 'costPerQuote', label: 'Cost/Quote ($)' },
                { key: 'costPerSale', label: 'Cost/Sale ($)' },
                { key: 'totalCost', label: 'Total Cost ($)' },
                { key: 'revenue', label: 'Revenue ($)' },
              ])} />
            )}
          </div>
          {!vendors ? (
            <div style={s.muted}>Loading…</div>
          ) : vendors.length === 0 ? (
            <EmptyState title="No vendor activity yet" description="Leads received from a connected vendor in this period will rank here." />
          ) : (
            <div style={s.tableWrap}>
              <div style={{ ...s.vendorRow, ...s.tableHeader }}>
                <div style={s.colRank}>#</div>
                <div style={s.colName}>Vendor</div>
                <div style={s.colNum}>Leads</div>
                <div style={s.colNum}>Quotes</div>
                <div style={s.colNum}>Sales</div>
                <div style={s.colNum}>Conv%</div>
                <div style={s.colNum}>Cost/Lead</div>
                <div style={s.colNum}>Cost/Quote</div>
                <div style={s.colNum}>Cost/Sale</div>
                <div style={s.colNum}>Revenue</div>
              </div>
              {vendors.map((v, i) => (
                <div key={v.vendorId} style={s.vendorRow}>
                  <div style={s.colRank}><RankBadge n={i + 1} /></div>
                  <div style={s.colName}>{v.vendorName}<span style={s.productTag}>{v.product}</span></div>
                  <div style={s.colNum}>{v.leadsReceived}</div>
                  <div style={s.colNum}>{v.quotesReceived}</div>
                  <div style={s.colNum}>{v.salesCount}</div>
                  <div style={s.colNum}>{pct(v.conversionRate)}</div>
                  <div style={s.colNum}>{money(v.costPerLead)}</div>
                  <div style={s.colNum}>{money(v.costPerQuote)}</div>
                  <div style={s.colNum}>{money(v.costPerSale)}</div>
                  <div style={{ ...s.colNum, color: 'var(--accent)', fontWeight: 700 }}>{money(v.revenue)}</div>
                </div>
              ))}
            </div>
          )}
        </Card>

        <Card style={s.card}>
          <div style={s.cardHeaderRow}>
            <div style={s.cardTitle}>AGENT LEADERBOARD</div>
            {agents?.length > 0 && (
              <ExportButton onExport={() => downloadCsv('agent-leaderboard', agents, [
                { key: 'firstName', label: 'First Name' },
                { key: 'lastName', label: 'Last Name' },
                { key: 'leadsAssigned', label: 'Leads' },
                { key: 'salesCount', label: 'Sales' },
                { key: 'conversionRate', label: 'Conversion %' },
                { key: 'revenue', label: 'Revenue ($)' },
                { key: 'flowScore', label: 'Flow Score' },
              ])} />
            )}
          </div>
          {!agents ? (
            <div style={s.muted}>Loading…</div>
          ) : agents.length === 0 ? (
            <EmptyState title="No producer activity yet" description="Leads assigned to a producer in this period will rank here." />
          ) : (
            <div style={s.tableWrap}>
              <div style={{ ...s.agentRow, ...s.tableHeader }}>
                <div style={s.colRank}>#</div>
                <div style={s.colName}>Producer</div>
                <div style={s.colNum}>Leads</div>
                <div style={s.colNum}>Sales</div>
                <div style={s.colNum}>Conv%</div>
                <div style={s.colNum}>Revenue</div>
                <div style={s.colNum}>Flow Score</div>
              </div>
              {agents.map((a, i) => (
                <div key={a.userId} style={s.agentRow}>
                  <div style={s.colRank}><RankBadge n={i + 1} /></div>
                  <div style={s.colName}>{a.firstName} {a.lastName}</div>
                  <div style={s.colNum}>{a.leadsAssigned}</div>
                  <div style={s.colNum}>{a.salesCount}</div>
                  <div style={s.colNum}>{pct(a.conversionRate)}</div>
                  <div style={{ ...s.colNum, color: 'var(--accent)', fontWeight: 700 }}>{money(a.revenue)}</div>
                  <div style={s.colNum}>{a.flowScore === null ? '—' : a.flowScore}</div>
                </div>
              ))}
            </div>
          )}
        </Card>
      </div>
    </div>
  );
}

function RankBadge({ n }) {
  const tone = n === 1 ? { bg: 'var(--accent-gradient)', color: 'var(--accent-on)' }
    : n === 2 ? { bg: 'var(--border-strong)', color: 'var(--text-primary)' }
    : n === 3 ? { bg: 'rgba(198, 255, 46, 0.15)', color: 'var(--accent)' }
    : { bg: 'transparent', color: 'var(--text-muted)' };
  return (
    <span style={{
      display: 'inline-flex', alignItems: 'center', justifyContent: 'center', width: 22, height: 22,
      borderRadius: '50%', fontSize: 11, fontWeight: 700, background: tone.bg, color: tone.color,
    }}>
      {n}
    </span>
  );
}

const s = {
  periodRow: { display: 'flex', gap: 6, flexWrap: 'wrap' },
  error: { color: 'var(--danger)', fontSize: 13, marginBottom: 12 },
  grid: { display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 16 },
  card: { padding: 0, overflow: 'hidden' },
  cardHeaderRow: { display: 'flex', justifyContent: 'space-between', alignItems: 'center', padding: '14px 16px', borderBottom: '1px solid var(--border-hairline)' },
  cardTitle: { color: 'var(--text-secondary)', fontSize: 11, letterSpacing: 1.5, fontWeight: 700 },
  muted: { color: 'var(--text-muted)', fontSize: 13, padding: 16 },
  tableWrap: { overflowX: 'auto' },
  vendorRow: { display: 'grid', gridTemplateColumns: '28px 1.4fr repeat(8, 0.8fr)', alignItems: 'center', gap: 6, padding: '10px 16px', borderBottom: '1px solid var(--border-hairline)', fontSize: 12, minWidth: 640 },
  agentRow: { display: 'grid', gridTemplateColumns: '28px 1.4fr repeat(5, 0.8fr)', alignItems: 'center', gap: 6, padding: '10px 16px', borderBottom: '1px solid var(--border-hairline)', fontSize: 12, minWidth: 480 },
  tableHeader: { color: 'var(--text-muted)', fontSize: 10, letterSpacing: 0.5, fontWeight: 700, textTransform: 'uppercase' },
  colRank: {},
  colName: { color: 'var(--text-primary)', fontWeight: 600, whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' },
  colNum: { color: 'var(--text-secondary)', textAlign: 'right' },
  productTag: { color: 'var(--text-muted)', fontWeight: 400, fontSize: 10, marginLeft: 6 },
};
