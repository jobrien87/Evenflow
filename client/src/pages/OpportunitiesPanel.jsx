import { useEffect, useState } from 'react';
import { api } from '../lib/api';
import { useAuth } from '../lib/AuthContext';

export default function OpportunitiesPanel() {
  const { user } = useAuth();
  const canCreateWinback = ['AGENCY_OWNER', 'AGENCY_MANAGER', 'PLATFORM_OWNER'].includes(user.role);
  const [tab, setTab] = useState('all');
  const [opportunities, setOpportunities] = useState([]);
  const [showWinbackForm, setShowWinbackForm] = useState(false);
  const [customerQuery, setCustomerQuery] = useState('');
  const [customerResults, setCustomerResults] = useState([]);
  const [form, setForm] = useState({ customerId: '', product: '', previousProduct: '', previousPremiumCents: '', lostAt: '', lostReason: '' });
  const [status, setStatus] = useState('');

  useEffect(() => {
    load();
  }, [tab]);

  async function load() {
    const params = tab === 'all' ? '' : `?type=${tab}`;
    const data = await api.opportunities(params);
    setOpportunities(data.opportunities);
  }

  async function searchCustomers(q) {
    setCustomerQuery(q);
    if (q.length < 2) { setCustomerResults([]); return; }
    const data = await api.searchCustomers(q);
    setCustomerResults(data.customers);
  }

  function pickCustomer(c) {
    setForm({ ...form, customerId: c.id });
    setCustomerResults([]);
    setCustomerQuery(`${c.firstName} ${c.lastName}`);
  }

  async function submitWinback(e) {
    e.preventDefault();
    setStatus('Creating…');
    try {
      await api.createWinback({
        customerId: form.customerId,
        product: form.product,
        previousProduct: form.previousProduct || undefined,
        previousPremiumCents: form.previousPremiumCents ? Math.round(parseFloat(form.previousPremiumCents) * 100) : undefined,
        lostAt: form.lostAt ? new Date(form.lostAt).toISOString() : undefined,
        lostReason: form.lostReason || undefined,
      });
      setStatus('Winback opportunity created.');
      setForm({ customerId: '', product: '', previousProduct: '', previousPremiumCents: '', lostAt: '', lostReason: '' });
      setCustomerQuery('');
      setShowWinbackForm(false);
      await load();
    } catch (err) {
      setStatus(err.data?.message || 'Failed to create.');
    }
  }

  async function disposition(id, newStatus, extra) {
    await api.dispositionOpportunity(id, { status: newStatus, ...extra });
    await load();
  }

  return (
    <div style={s.wrap}>
      <div style={s.headerRow}>
        <div style={s.tabRow}>
          <button style={s.tab(tab === 'all')} onClick={() => setTab('all')}>ALL</button>
          <button style={s.tab(tab === 'WINBACK')} onClick={() => setTab('WINBACK')}>WINBACKS</button>
          <button style={s.tab(tab === 'CROSS_SELL')} onClick={() => setTab('CROSS_SELL')}>CROSS-SELLS</button>
        </div>
        {canCreateWinback && (
          <button style={s.smallButton} onClick={() => setShowWinbackForm(!showWinbackForm)}>+ RECORD WINBACK</button>
        )}
      </div>

      {showWinbackForm && canCreateWinback && (
        <form onSubmit={submitWinback} style={s.form}>
          <div style={s.hint}>
            Winbacks are always manually recorded — this app doesn't track policy cancellations automatically, so enter what you know about the lapsed customer.
          </div>
          <div style={{ position: 'relative' }}>
            <input style={s.input} placeholder="Search customer by name or phone…" value={customerQuery} onChange={(e) => searchCustomers(e.target.value)} required />
            {customerResults.length > 0 && (
              <div style={s.searchResults}>
                {customerResults.map((c) => (
                  <div key={c.id} style={s.searchResultRow} onClick={() => pickCustomer(c)}>
                    {c.firstName} {c.lastName} {c.phoneNormalized ? `· ${c.phoneNormalized}` : ''}
                  </div>
                ))}
              </div>
            )}
          </div>
          <input style={s.input} placeholder="Product to win back (e.g. Auto)" value={form.product} onChange={(e) => setForm({ ...form, product: e.target.value })} required />
          <input style={s.input} placeholder="Previous product (optional)" value={form.previousProduct} onChange={(e) => setForm({ ...form, previousProduct: e.target.value })} />
          <input style={s.input} type="number" step="0.01" placeholder="Previous premium $ (optional)" value={form.previousPremiumCents} onChange={(e) => setForm({ ...form, previousPremiumCents: e.target.value })} />
          <input style={s.input} type="date" placeholder="Lapse date" value={form.lostAt} onChange={(e) => setForm({ ...form, lostAt: e.target.value })} />
          <input style={s.input} placeholder="Reason lost (optional)" value={form.lostReason} onChange={(e) => setForm({ ...form, lostReason: e.target.value })} />
          <button style={s.submitButton} type="submit" disabled={!form.customerId}>Create Winback Opportunity</button>
          {status && <div style={s.status}>{status}</div>}
        </form>
      )}

      <section>
        {opportunities.map((o) => (
          <div key={o.id} style={s.row}>
            <div>
              <div style={s.rowTitle}>
                {o.customer.firstName} {o.customer.lastName}
                <span style={s.typeTag(o.type)}>{o.type === 'WINBACK' ? 'WINBACK' : 'CROSS-SELL'}</span>
              </div>
              <div style={s.rowSub}>{o.product} · {o.reason}</div>
            </div>
            <div style={s.actionsRow}>
              <div style={s.badge}>{o.status}</div>
              {['OPEN', 'ASSIGNED'].includes(o.status) && (
                <button style={s.actionButton} onClick={() => disposition(o.id, 'ATTEMPTED')}>ATTEMPT</button>
              )}
              {['ATTEMPTED', 'ASSIGNED'].includes(o.status) && (
                <button style={s.actionButton} onClick={() => disposition(o.id, 'CONTACTED')}>CONTACTED</button>
              )}
              {o.status === 'CONTACTED' && (
                <button style={s.actionButton} onClick={() => disposition(o.id, 'QUOTED')}>QUOTED</button>
              )}
              {o.status === 'QUOTED' && (
                <WonForm onWon={(premium) => disposition(o.id, 'WON', { wonPremiumCents: premium })} />
              )}
              {!['WON', 'DECLINED'].includes(o.status) && (
                <button style={s.declineButton} onClick={() => disposition(o.id, 'DECLINED')}>DECLINE</button>
              )}
            </div>
          </div>
        ))}
        {opportunities.length === 0 && <div style={s.empty}>No open opportunities.</div>}
      </section>
    </div>
  );
}

function WonForm({ onWon }) {
  const [open, setOpen] = useState(false);
  const [premium, setPremium] = useState('');
  if (!open) return <button style={s.wonButton} onClick={() => setOpen(true)}>WON</button>;
  return (
    <div style={{ display: 'flex', gap: 6 }}>
      <input style={s.miniInput} placeholder="Premium $" value={premium} onChange={(e) => setPremium(e.target.value)} />
      <button style={s.wonButton} onClick={() => onWon(Math.round(parseFloat(premium) * 100))} disabled={!premium}>CONFIRM</button>
    </div>
  );
}

const s = {
  wrap: {},
  headerRow: { display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 16, flexWrap: 'wrap', gap: 10 },
  tabRow: { display: 'flex', gap: 8 },
  tab: (active) => ({
    padding: '8px 14px', borderRadius: 6, border: '1px solid #333', cursor: 'pointer', fontSize: 11, fontWeight: 700,
    background: active ? '#00e5ff' : 'transparent', color: active ? '#000' : '#aaa',
  }),
  smallButton: { padding: '8px 14px', background: '#00e5ff', border: 'none', borderRadius: 6, fontWeight: 700, cursor: 'pointer', fontSize: 12 },
  form: { display: 'flex', flexDirection: 'column', gap: 10, background: '#111', padding: 16, borderRadius: 8, marginBottom: 16, border: '1px solid #222' },
  hint: { color: '#666', fontSize: 12, lineHeight: 1.5 },
  input: { padding: '10px 12px', background: '#000', border: '1px solid #333', borderRadius: 6, color: '#fff', width: '100%', boxSizing: 'border-box' },
  searchResults: { position: 'absolute', top: '100%', left: 0, right: 0, background: '#000', border: '1px solid #333', borderRadius: 6, zIndex: 10, maxHeight: 160, overflowY: 'auto' },
  searchResultRow: { padding: '8px 12px', color: '#ccc', fontSize: 13, cursor: 'pointer', borderBottom: '1px solid #1a1a1a' },
  submitButton: { padding: '10px', background: '#00e5ff', border: 'none', borderRadius: 6, fontWeight: 700, cursor: 'pointer' },
  status: { color: '#00e5ff', fontSize: 12 },
  row: { display: 'flex', justifyContent: 'space-between', alignItems: 'center', background: '#111', border: '1px solid #1a1a1a', borderRadius: 8, padding: 14, marginBottom: 8, flexWrap: 'wrap', gap: 10 },
  rowTitle: { fontWeight: 600, fontSize: 14, color: '#fff', display: 'flex', alignItems: 'center', gap: 8 },
  typeTag: (type) => ({
    fontSize: 9, padding: '2px 6px', borderRadius: 4,
    color: type === 'WINBACK' ? '#ffb84d' : '#00e5ff', border: `1px solid ${type === 'WINBACK' ? '#ffb84d44' : '#00e5ff44'}`,
  }),
  rowSub: { color: '#666', fontSize: 12, marginTop: 2 },
  actionsRow: { display: 'flex', gap: 6, alignItems: 'center', flexWrap: 'wrap' },
  badge: { fontSize: 11, color: '#888', border: '1px solid #333', padding: '4px 8px', borderRadius: 4 },
  actionButton: { padding: '6px 10px', background: '#00e5ff', border: 'none', borderRadius: 6, fontWeight: 700, cursor: 'pointer', fontSize: 11 },
  wonButton: { padding: '6px 10px', background: '#00ff88', border: 'none', borderRadius: 6, fontWeight: 700, cursor: 'pointer', fontSize: 11 },
  declineButton: { padding: '6px 10px', background: 'transparent', border: '1px solid #ff4d4d', color: '#ff4d4d', borderRadius: 6, cursor: 'pointer', fontSize: 11 },
  miniInput: { padding: '6px 8px', background: '#000', border: '1px solid #333', borderRadius: 6, color: '#fff', fontSize: 12, width: 90 },
  empty: { color: '#666', fontStyle: 'italic', fontSize: 13 },
};
