import { useEffect, useState } from 'react';
import { api } from '../lib/api';
import { Card, SectionHeader, Button, EmptyState } from '../ui';

// Platform Owner reconciliation tool for Sale.items rows that look wrong —
// a bundled/multi-product sale logged before the prefill/backfill fixes
// shipped can be stuck showing items=1 even though its lead actually
// reached SOLD on more than one product. Never auto-corrected server-side
// (a producer may have legitimately logged items:1 on a multi-quote lead
// where only one product actually closed), so each row is reviewed here
// with the suggested real count pre-filled and editable before saving —
// one click for the common case, still a human decision every time.
export default function SaleItemsReviewPanel() {
  const [sales, setSales] = useState(null);
  const [drafts, setDrafts] = useState({});
  const [busyId, setBusyId] = useState(null);
  const [error, setError] = useState('');

  useEffect(() => {
    load();
  }, []);

  async function load() {
    setError('');
    try {
      const data = await api.saleItemsMismatch();
      setSales(data.sales);
      setDrafts(Object.fromEntries(data.sales.map((s) => [s.id, String(s.soldQuoteCount)])));
    } catch (err) {
      setError(err.data?.message || 'Could not load the items review list.');
    }
  }

  async function save(saleId) {
    const value = Number(drafts[saleId]);
    if (!Number.isInteger(value) || value < 1) {
      setError('Items must be a whole number of 1 or more.');
      return;
    }
    setBusyId(saleId);
    setError('');
    try {
      await api.updateSale(saleId, { items: value });
      setSales((prev) => prev.filter((s) => s.id !== saleId));
    } catch (err) {
      setError(err.data?.message || 'Could not save this correction.');
    } finally {
      setBusyId(null);
    }
  }

  if (sales === null) return null;

  return (
    <div>
      <SectionHeader>Sale Items Review</SectionHeader>
      <Card style={s.card}>
        <div style={s.cardTitle}>LIKELY WRONG ITEM COUNTS</div>
        <div style={s.rowSub}>
          Sales still showing 1 item whose lead actually reached SOLD on more than one product. Confirm or adjust the real
          count, then save — nothing here is changed automatically.
        </div>
        {error && <div style={s.error}>{error}</div>}
        {sales.length === 0 && (
          <EmptyState title="Nothing to review" description="No Sale rows currently look mismatched." />
        )}
        {sales.map((sale) => (
          <div key={sale.id} style={s.row}>
            <div>
              <div style={s.rowTitle}>{sale.firstName} {sale.lastName} {sale.policyNumber ? `— ${sale.policyNumber}` : ''}</div>
              <div style={s.rowSub}>
                {sale.agencyName} · {sale.assignedToName} · sold {new Date(sale.saleDate).toLocaleDateString()} · currently {sale.items} item{sale.items === 1 ? '' : 's'} ·
                lead shows {sale.soldQuoteCount} sold product{sale.soldQuoteCount === 1 ? '' : 's'}
              </div>
            </div>
            <div style={s.actions}>
              <input
                style={s.input}
                type="number"
                min={1}
                value={drafts[sale.id] ?? ''}
                onChange={(e) => setDrafts({ ...drafts, [sale.id]: e.target.value })}
              />
              <Button size="sm" variant="primary" disabled={busyId === sale.id} onClick={() => save(sale.id)}>
                SAVE
              </Button>
            </div>
          </div>
        ))}
      </Card>
    </div>
  );
}

const s = {
  card: { marginBottom: 16, padding: 'var(--space-4)' },
  cardTitle: { fontSize: 11, letterSpacing: 1.5, fontWeight: 700, color: 'var(--text-secondary)', marginBottom: 8, textTransform: 'uppercase' },
  rowSub: { color: 'var(--text-muted)', fontSize: 12, marginBottom: 10 },
  error: { color: 'var(--danger)', fontSize: 12, marginBottom: 10 },
  row: { display: 'flex', justifyContent: 'space-between', alignItems: 'center', padding: '10px 0', borderBottom: '1px solid var(--border-hairline)', gap: 10 },
  rowTitle: { fontWeight: 600, fontSize: 13, color: 'var(--text-primary)' },
  actions: { display: 'flex', alignItems: 'center', gap: 8, flexShrink: 0 },
  input: { width: 56, padding: '6px 8px', background: 'var(--bg-sunken)', border: '1px solid var(--border-strong)', borderRadius: 6, color: 'var(--text-primary)', fontSize: 13 },
};
