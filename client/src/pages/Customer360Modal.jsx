import { useEffect, useState } from 'react';
import { api } from '../lib/api';

export default function Customer360Modal({ customerId, onClose }) {
  const [data, setData] = useState(null);

  useEffect(() => {
    api.customerDetail(customerId).then(setData);
  }, [customerId]);

  if (!data) {
    return (
      <div style={s.overlay} onClick={onClose}>
        <div style={s.modal} onClick={(e) => e.stopPropagation()}>Loading…</div>
      </div>
    );
  }

  const { customer, leads, transfers, calls, opportunities, timeline } = data;

  return (
    <div style={s.overlay} onClick={onClose}>
      <div style={s.modal} onClick={(e) => e.stopPropagation()}>
        <div style={s.header}>
          <div>
            <div style={s.name}>{customer.firstName} {customer.lastName}</div>
            <div style={s.contact}>{customer.phoneNormalized || '—'} · {customer.email || '—'}</div>
          </div>
          <button style={s.closeButton} onClick={onClose}>CLOSE</button>
        </div>

        <div style={s.productsRow}>
          {customer.products.length > 0 ? (
            customer.products.map((p) => <span key={p} style={s.productChip}>{p}</span>)
          ) : (
            <span style={s.noProducts}>No confirmed products yet</span>
          )}
        </div>

        <div style={s.grid}>
          <SummaryBox label="Leads" value={leads.length} />
          <SummaryBox label="Transfers" value={transfers.length} />
          <SummaryBox label="Calls" value={calls.length} />
          <SummaryBox label="Opportunities" value={opportunities.length} />
        </div>

        <div style={s.section}>
          <div style={s.sectionTitle}>TIMELINE</div>
          <div style={s.timeline}>
            {timeline.length === 0 && <div style={s.empty}>No recorded activity yet.</div>}
            {timeline.map((entry, i) => (
              <div key={i} style={s.timelineRow}>
                <div style={s.timelineTime}>{new Date(entry.at).toLocaleString()}</div>
                <div style={s.timelineLabel}>{entry.label}</div>
              </div>
            ))}
          </div>
        </div>

        {opportunities.length > 0 && (
          <div style={s.section}>
            <div style={s.sectionTitle}>OPEN OPPORTUNITIES</div>
            {opportunities.filter((o) => !['WON', 'DECLINED'].includes(o.status)).map((o) => (
              <div key={o.id} style={s.oppRow}>
                <span style={s.oppType(o.type)}>{o.type === 'WINBACK' ? 'WINBACK' : 'CROSS-SELL'}</span>
                {o.product} — {o.status}
              </div>
            ))}
          </div>
        )}
      </div>
    </div>
  );
}

function SummaryBox({ label, value }) {
  return (
    <div style={s.summaryBox}>
      <div style={s.summaryValue}>{value}</div>
      <div style={s.summaryLabel}>{label}</div>
    </div>
  );
}

const s = {
  overlay: { position: 'fixed', top: 0, left: 0, right: 0, bottom: 0, background: 'rgba(0,0,0,0.75)', display: 'flex', alignItems: 'center', justifyContent: 'center', zIndex: 2500, padding: 20 },
  modal: { background: '#111', border: '1px solid #333', borderRadius: 12, padding: 24, maxWidth: 600, width: '100%', maxHeight: '85vh', overflowY: 'auto', color: '#fff' },
  header: { display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start', marginBottom: 12 },
  name: { fontSize: 22, fontWeight: 700 },
  contact: { color: '#888', fontSize: 13, marginTop: 4 },
  closeButton: { padding: '6px 12px', background: 'transparent', border: '1px solid #333', color: '#aaa', borderRadius: 6, cursor: 'pointer', fontSize: 11 },
  productsRow: { display: 'flex', gap: 6, flexWrap: 'wrap', marginBottom: 20 },
  productChip: { fontSize: 11, color: '#00e5ff', border: '1px solid #00e5ff44', padding: '4px 10px', borderRadius: 12 },
  noProducts: { color: '#666', fontSize: 12, fontStyle: 'italic' },
  grid: { display: 'grid', gridTemplateColumns: 'repeat(4, 1fr)', gap: 10, marginBottom: 24 },
  summaryBox: { background: '#0d0d0d', border: '1px solid #222', borderRadius: 8, padding: 12, textAlign: 'center' },
  summaryValue: { fontSize: 20, fontWeight: 700, color: '#00e5ff' },
  summaryLabel: { fontSize: 10, color: '#666', marginTop: 2 },
  section: { marginBottom: 20 },
  sectionTitle: { fontSize: 11, color: '#666', letterSpacing: 1, marginBottom: 10 },
  timeline: { borderLeft: '2px solid #222', paddingLeft: 14 },
  timelineRow: { marginBottom: 10 },
  timelineTime: { color: '#555', fontSize: 10 },
  timelineLabel: { color: '#ccc', fontSize: 13, marginTop: 2 },
  empty: { color: '#666', fontStyle: 'italic', fontSize: 13 },
  oppRow: { color: '#ccc', fontSize: 13, padding: '6px 0', display: 'flex', gap: 8, alignItems: 'center' },
  oppType: (type) => ({
    fontSize: 9, padding: '2px 6px', borderRadius: 4,
    color: type === 'WINBACK' ? '#ffb84d' : '#00e5ff', border: `1px solid ${type === 'WINBACK' ? '#ffb84d44' : '#00e5ff44'}`,
  }),
};
