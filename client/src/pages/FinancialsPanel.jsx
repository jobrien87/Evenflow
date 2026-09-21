import { useEffect, useState } from 'react';
import { api } from '../lib/api';
import { useAuth } from '../lib/AuthContext';
import { ExportButton } from '../ui';
import { downloadCsv, fetchAllPages } from '../lib/downloadCsv';

const REVENUE_CATEGORIES = ['SUBSCRIPTION', 'TRANSFER_REVENUE', 'LEAD_REVENUE', 'OTHER'];
const COST_CATEGORIES = ['VENDOR_LEAD_COST', 'TELEMARKETER_COST', 'TRANSFER_COST', 'API_COST', 'CREDIT', 'REFUND', 'OTHER'];

export default function FinancialsPanel() {
  const { user } = useAuth();
  const [summary, setSummary] = useState(null);
  const [vendors, setVendors] = useState([]);
  const [aiUsage, setAiUsage] = useState(null);
  const [showEntryForm, setShowEntryForm] = useState(false);
  const [entryType, setEntryType] = useState('revenue');
  const [entryForm, setEntryForm] = useState({ category: 'OTHER', amount: '', notes: '' });
  const [entryStatus, setEntryStatus] = useState('');

  const isPlatformOwner = user.role === 'PLATFORM_OWNER';

  useEffect(() => {
    load();
  }, []);

  async function load() {
    const promises = [api.financialSummary(), api.financialByVendor()];
    if (isPlatformOwner) promises.push(api.edUsageSummary());
    const results = await Promise.all(promises);
    setSummary(results[0]);
    setVendors(results[1].vendors);
    if (isPlatformOwner) setAiUsage(results[2]);
  }

  async function submitEntry(e) {
    e.preventDefault();
    setEntryStatus('Saving…');
    try {
      const amountCents = Math.round(parseFloat(entryForm.amount) * 100);
      if (entryType === 'revenue') {
        await api.createRevenueEvent({ category: entryForm.category, amountCents, notes: entryForm.notes });
      } else {
        await api.createCostEvent({ category: entryForm.category, amountCents, notes: entryForm.notes });
      }
      setEntryStatus('Recorded.');
      setEntryForm({ category: 'OTHER', amount: '', notes: '' });
      await load();
      setTimeout(() => { setShowEntryForm(false); setEntryStatus(''); }, 1000);
    } catch (err) {
      setEntryStatus(err.data?.message || 'Failed to record.');
    }
  }

  async function exportLedger() {
    const events = await fetchAllPages(
      (page, pageSize) => api.financialEvents(`?from=2000-01-01&to=2100-01-01&page=${page}&pageSize=${pageSize}`),
      { itemsKey: 'events' }
    );
    downloadCsv('financial-ledger', events, [
      { key: 'type', label: 'Type' },
      { key: 'category', label: 'Category' },
      { key: (e) => (e.amountCents / 100).toFixed(2), label: 'Amount ($)' },
      { key: 'occurredAt', label: 'Date' },
      { key: 'notes', label: 'Notes' },
    ]);
  }

  if (!summary) return <div style={{ color: 'var(--text-muted)' }}>Loading…</div>;

  return (
    <div style={s.wrap}>
      <div style={s.periodHeaderRow}>
        <div style={s.periodLabel}>
          {new Date(summary.period.from).toLocaleDateString()} – {new Date(summary.period.to).toLocaleDateString()}
        </div>
        <ExportButton label="EXPORT FULL LEDGER" onExport={exportLedger} />
      </div>

      <div style={s.statsRow}>
        <Stat label="Revenue" value={`$${summary.revenue.toLocaleString()}`} />
        <Stat label="Cost" value={`$${summary.cost.toLocaleString()}`} />
        <Stat label="Gross Profit" value={`$${summary.grossProfit.toLocaleString()}`} highlight={summary.grossProfit >= 0} />
      </div>

      <div style={s.statsRow}>
        <Stat
          label="Margin"
          value={summary.marginPercent !== null ? `${summary.marginPercent}%` : 'INSUFFICIENT DATA'}
          muted={summary.marginPercent === null}
        />
        <Stat
          label="ROI"
          value={summary.roiPercent !== null ? `${summary.roiPercent}%` : 'INSUFFICIENT DATA'}
          muted={summary.roiPercent === null}
        />
        <Stat label="Sales Recorded" value={summary.salesRecorded} />
      </div>

      {(summary.marginReason || summary.roiReason) && (
        <div style={s.reasonNote}>
          {summary.marginReason && <div>{summary.marginReason}</div>}
          {summary.roiReason && <div>{summary.roiReason}</div>}
        </div>
      )}

      {isPlatformOwner && (
        <section style={s.section}>
          <div style={s.headerRow}>
            <h3 style={s.h3}>MANUAL LEDGER ENTRY</h3>
            <button style={s.smallButton} onClick={() => setShowEntryForm(!showEntryForm)}>+ RECORD ENTRY</button>
          </div>
          {showEntryForm && (
            <form onSubmit={submitEntry} style={s.form}>
              <div style={s.toggleRow}>
                <button type="button" style={s.miniTab(entryType === 'revenue')} onClick={() => setEntryType('revenue')}>REVENUE</button>
                <button type="button" style={s.miniTab(entryType === 'cost')} onClick={() => setEntryType('cost')}>COST</button>
              </div>
              <select style={s.input} value={entryForm.category} onChange={(e) => setEntryForm({ ...entryForm, category: e.target.value })}>
                {(entryType === 'revenue' ? REVENUE_CATEGORIES : COST_CATEGORIES).map((c) => (
                  <option key={c} value={c}>{c.replace(/_/g, ' ')}</option>
                ))}
              </select>
              <input style={s.input} type="number" step="0.01" min="0" placeholder="Amount ($)" value={entryForm.amount} onChange={(e) => setEntryForm({ ...entryForm, amount: e.target.value })} required />
              <input style={s.input} placeholder="Notes" value={entryForm.notes} onChange={(e) => setEntryForm({ ...entryForm, notes: e.target.value })} />
              <button style={s.submitButton} type="submit">Record {entryType === 'revenue' ? 'Revenue' : 'Cost'}</button>
              {entryStatus && <div style={s.status}>{entryStatus}</div>}
            </form>
          )}
        </section>
      )}

      <section style={s.section}>
        <div style={s.headerRow}>
          <h3 style={s.h3}>REVENUE BY CATEGORY</h3>
          {summary.revenueByCategory.length > 0 && (
            <ExportButton onExport={() => downloadCsv('revenue-by-category', summary.revenueByCategory, [
              { key: 'category', label: 'Category' },
              { key: 'amount', label: 'Amount ($)' },
            ])} />
          )}
        </div>
        {summary.revenueByCategory.length === 0 && <div style={s.empty}>No revenue events recorded this period.</div>}
        {summary.revenueByCategory.map((r) => (
          <div key={r.category} style={s.catRow}>
            <span>{r.category.replace(/_/g, ' ')}</span>
            <span style={{ color: 'var(--accent)' }}>${r.amount.toLocaleString()}</span>
          </div>
        ))}
      </section>

      <section style={s.section}>
        <div style={s.headerRow}>
          <h3 style={s.h3}>COST BY CATEGORY</h3>
          {summary.costByCategory.length > 0 && (
            <ExportButton onExport={() => downloadCsv('cost-by-category', summary.costByCategory, [
              { key: 'category', label: 'Category' },
              { key: 'amount', label: 'Amount ($)' },
            ])} />
          )}
        </div>
        {summary.costByCategory.length === 0 && <div style={s.empty}>No cost events recorded this period.</div>}
        {summary.costByCategory.map((c) => (
          <div key={c.category} style={s.catRow}>
            <span>{c.category.replace(/_/g, ' ')}</span>
            <span style={{ color: 'var(--danger)' }}>${c.amount.toLocaleString()}</span>
          </div>
        ))}
      </section>

      <section style={s.section}>
        <div style={s.headerRow}>
          <h3 style={s.h3}>VENDOR COST PER LEAD</h3>
          {vendors.length > 0 && (
            <ExportButton onExport={() => downloadCsv('vendor-cost-per-lead', vendors, [
              { key: 'vendorName', label: 'Vendor' },
              { key: 'product', label: 'Product' },
              { key: 'status', label: 'Status' },
              { key: 'leadsReceived', label: 'Leads Received' },
              { key: 'totalCost', label: 'Total Cost ($)' },
              { key: 'costPerLead', label: 'Cost Per Lead ($)' },
            ])} />
          )}
        </div>
        {vendors.map((v) => (
          <div key={v.vendorId} style={s.vendorRow}>
            <div>
              <div style={s.rowTitle}>{v.vendorName} <span style={s.vendorProduct}>· {v.product}</span></div>
              <div style={s.rowSub}>{v.leadsReceived} leads · {v.status} · ${v.totalCost.toLocaleString()} total cost</div>
            </div>
            <div style={s.costPer}>
              {v.costPerLead !== null ? `$${v.costPerLead.toFixed(2)}/lead` : 'not configured'}
            </div>
          </div>
        ))}
        {vendors.length === 0 && <div style={s.empty}>No vendors yet.</div>}
      </section>

      {isPlatformOwner && aiUsage && (
        <section style={s.section}>
          <h3 style={s.h3}>AI OPERATIONAL COST (ED)</h3>
          <div style={s.aiUsageBox}>
            <div style={s.aiUsageRow}><span>Total calls</span><span>{aiUsage.totalCalls}</span></div>
            <div style={s.aiUsageRow}><span>Input tokens</span><span>{aiUsage.totalInputTokens.toLocaleString()}</span></div>
            <div style={s.aiUsageRow}><span>Output tokens</span><span>{aiUsage.totalOutputTokens.toLocaleString()}</span></div>
            <div style={s.aiUsageRow}><span>Estimated total cost</span><span>${aiUsage.estimatedTotalCostUsd.toFixed(4)}</span></div>
            <div style={s.aiUsageNote}>{aiUsage.note}</div>
          </div>
        </section>
      )}
    </div>
  );
}

function Stat({ label, value, highlight, muted }) {
  return (
    <div style={s.stat}>
      <div style={{ ...s.statValue, color: muted ? 'var(--text-muted)' : highlight === false ? 'var(--danger)' : highlight ? 'var(--accent)' : 'var(--text-primary)', fontSize: muted ? 14 : 24 }}>
        {value}
      </div>
      <div style={s.statLabel}>{label}</div>
    </div>
  );
}

const s = {
  wrap: {},
  periodHeaderRow: { display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 16, gap: 8, flexWrap: 'wrap' },
  periodLabel: { color: 'var(--text-muted)', fontSize: 12 },
  statsRow: { display: 'flex', gap: 16, marginBottom: 16 },
  stat: { background: 'var(--bg-elevated)', border: '1px solid var(--border-hairline)', borderRadius: 8, padding: 16, flex: 1, textAlign: 'center' },
  statValue: { fontSize: 24, fontWeight: 700 },
  statLabel: { fontSize: 11, color: 'var(--text-secondary)', marginTop: 4 },
  reasonNote: { color: 'var(--warning)', fontSize: 12, marginBottom: 20, fontStyle: 'italic' },
  section: { marginBottom: 28 },
  headerRow: { display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 10 },
  h3: { color: 'var(--text-secondary)', fontSize: 12, letterSpacing: 2 },
  smallButton: { padding: '8px 14px', background: 'var(--accent)', border: 'none', borderRadius: 6, fontWeight: 700, cursor: 'pointer', fontSize: 12 },
  form: { display: 'flex', flexDirection: 'column', gap: 10, background: 'var(--bg-elevated)', padding: 16, borderRadius: 8, border: '1px solid var(--border-hairline)' },
  toggleRow: { display: 'flex', gap: 8 },
  miniTab: (active) => ({
    flex: 1, padding: '8px', borderRadius: 6, border: '1px solid var(--border-strong)', cursor: 'pointer', fontSize: 11, fontWeight: 700,
    background: active ? 'var(--accent)' : 'transparent', color: active ? 'var(--accent-on)' : 'var(--text-secondary)',
  }),
  input: { padding: '10px 12px', background: 'var(--bg-sunken)', border: '1px solid var(--border-strong)', borderRadius: 6, color: 'var(--text-primary)' },
  submitButton: { padding: '10px', background: 'var(--accent)', border: 'none', borderRadius: 6, fontWeight: 700, cursor: 'pointer' },
  status: { color: 'var(--accent)', fontSize: 12 },
  catRow: { display: 'flex', justifyContent: 'space-between', padding: '8px 0', borderBottom: '1px solid var(--border-hairline)', fontSize: 13 },
  vendorRow: { display: 'flex', justifyContent: 'space-between', alignItems: 'center', background: 'var(--bg-elevated)', border: '1px solid var(--border-hairline)', borderRadius: 8, padding: 12, marginBottom: 8 },
  rowTitle: { fontWeight: 600, fontSize: 13 },
  vendorProduct: { color: 'var(--text-muted)', fontWeight: 400 },
  rowSub: { color: 'var(--text-muted)', fontSize: 11 },
  costPer: { color: 'var(--accent)', fontSize: 13, fontWeight: 600 },
  empty: { color: 'var(--text-muted)', fontStyle: 'italic', fontSize: 13 },
  aiUsageBox: { background: 'var(--bg-elevated)', border: '1px solid var(--border-hairline)', borderRadius: 8, padding: 16 },
  aiUsageRow: { display: 'flex', justifyContent: 'space-between', padding: '6px 0', fontSize: 13, color: 'var(--text-secondary)' },
  aiUsageNote: { color: 'var(--text-muted)', fontSize: 11, marginTop: 8, fontStyle: 'italic' },
};
