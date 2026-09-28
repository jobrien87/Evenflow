import { useEffect, useState } from 'react';
import { api } from '../lib/api';
import { Card, Badge, StatTile, BarRow, SectionHeader, EmptyState, ExportButton, Modal } from '../ui';
import { downloadCsv } from '../lib/downloadCsv';

function statusTone(status) {
  if (['COMPLETED', 'DISPOSITIONED'].includes(status)) return 'accent';
  if (['REJECTED', 'MISSED', 'FAILED', 'CANCELLED', 'NO_ELIGIBLE_DESTINATION'].includes(status)) return 'danger';
  return 'neutral';
}

// Read-only — the accept/reject/routing workflow this data came from was
// retired in the Yield Transfers rebuild (telemarketer submissions are
// real Leads now, see YieldTransfersPanel.jsx). This just keeps the
// historical record inspectable, per transfers.js's own promise that
// nothing gets deleted.
export default function TransferHistoryPanel() {
  const [transfers, setTransfers] = useState(null);
  const [selected, setSelected] = useState(null);

  useEffect(() => {
    api.transfers().then((data) => setTransfers(data.transfers));
  }, []);

  async function openDetail(id) {
    const data = await api.transferDetail(id);
    setSelected(data.transfer);
  }

  if (transfers === null) return <div style={{ color: 'var(--text-muted)' }}>Loading…</div>;

  const total = transfers.length;
  const won = transfers.filter((t) => statusTone(t.status) === 'accent').length;
  const lost = transfers.filter((t) => statusTone(t.status) === 'danger').length;
  const winRate = total > 0 ? Math.round((won / total) * 100) : 0;
  const totalPremiumCents = transfers.reduce((sum, t) => sum + (t.salePremiumCents || 0), 0);
  const statusBreakdown = Object.entries(
    transfers.reduce((acc, t) => {
      acc[t.status] = (acc[t.status] || 0) + 1;
      return acc;
    }, {})
  )
    .sort((a, b) => b[1] - a[1])
    .slice(0, 6);

  return (
    <div style={{ color: 'var(--text-primary)' }}>
      <SectionHeader
        right={transfers.length > 0 && (
          <ExportButton onExport={() => downloadCsv('transfer-history', transfers, [
            { key: 'firstName', label: 'First Name' },
            { key: 'lastName', label: 'Last Name' },
            { key: 'product', label: 'Product' },
            { key: 'state', label: 'State' },
            { key: 'status', label: 'Status' },
            { key: (t) => t.createdByTM ? `${t.createdByTM.firstName} ${t.createdByTM.lastName}` : '', label: 'Submitted By' },
            { key: 'createdAt', label: 'Created At' },
            { key: 'disposition', label: 'Disposition' },
            { key: (t) => t.salePremiumCents ? (t.salePremiumCents / 100).toFixed(2) : '', label: 'Sale Premium ($)' },
          ])} />
        )}
      >
        TRANSFER HISTORY
      </SectionHeader>

      <div style={s.statsRow}>
        <StatTile label="Total Records" value={total} />
        <StatTile label="Won" value={won} sub={`${winRate}% win rate`} />
        <StatTile label="Lost / Missed" value={lost} />
        <StatTile label="Sale Premium" value={`$${(totalPremiumCents / 100).toFixed(0)}`} sub="from the old workflow" />
      </div>

      {total > 0 && (
        <Card style={s.breakdownCard}>
          <div style={s.breakdownTitle}>BY STATUS</div>
          {statusBreakdown.map(([status, count]) => (
            <BarRow key={status} label={status.replace(/_/g, ' ')} value={count} max={total} valueLabel={count} />
          ))}
        </Card>
      )}

      {transfers.length === 0 ? (
        <EmptyState title="No historical transfers" description="Records from the old Yield Transfers workflow (before the Lead-based rebuild) will show up here." />
      ) : (
        transfers.map((t) => (
          <Card key={t.id} style={s.row} className="ui-row-stack" onClick={() => openDetail(t.id)}>
            <div>
              <div style={s.rowTitle}>{t.firstName} {t.lastName} · {t.product} · {t.state}</div>
              <div style={s.rowSub}>
                Submitted by {t.createdByTM ? `${t.createdByTM.firstName} ${t.createdByTM.lastName}` : 'a telemarketer'} · {new Date(t.createdAt).toLocaleString()}
              </div>
            </div>
            <Badge tone={statusTone(t.status)}>{t.status.replace(/_/g, ' ')}</Badge>
          </Card>
        ))
      )}

      {selected && (
        <Modal title={`${selected.firstName} ${selected.lastName}`} onClose={() => setSelected(null)}>
          <div style={s.detailGrid}>
            <div><span style={s.detailLabel}>Status</span>{selected.status.replace(/_/g, ' ')}</div>
            <div><span style={s.detailLabel}>Product</span>{selected.product}</div>
            <div><span style={s.detailLabel}>State</span>{selected.state || '—'}</div>
            <div><span style={s.detailLabel}>Phone</span>{selected.phone || '—'}</div>
            <div><span style={s.detailLabel}>Email</span>{selected.email || '—'}</div>
            <div><span style={s.detailLabel}>Current Insurance</span>{selected.currentInsurance || '—'}</div>
            <div><span style={s.detailLabel}>Disposition</span>{selected.disposition || '—'}</div>
            <div><span style={s.detailLabel}>Sale Premium</span>{selected.salePremiumCents ? `$${(selected.salePremiumCents / 100).toFixed(2)}` : '—'}</div>
          </div>
          {selected.notes && <div style={s.notes}><strong>Notes:</strong> {selected.notes}</div>}
          {selected.events?.length > 0 && (
            <div style={{ marginTop: 16 }}>
              <div style={s.detailLabel}>EVENT HISTORY</div>
              {selected.events.map((e) => (
                <div key={e.id} style={s.eventRow}>{e.type} · {new Date(e.createdAt).toLocaleString()}</div>
              ))}
            </div>
          )}
        </Modal>
      )}
    </div>
  );
}

const s = {
  statsRow: { display: 'flex', gap: 32, marginBottom: 20, flexWrap: 'wrap' },
  breakdownCard: { marginBottom: 16 },
  breakdownTitle: { color: 'var(--text-muted)', fontSize: 11, letterSpacing: 1.5, fontWeight: 700, marginBottom: 10 },
  row: { display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 8, gap: 8, cursor: 'pointer' },
  rowTitle: { fontWeight: 600, fontSize: 14 },
  rowSub: { color: 'var(--text-muted)', fontSize: 11, marginTop: 2 },
  detailGrid: { display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 12, fontSize: 13, color: 'var(--text-primary)' },
  detailLabel: { display: 'block', color: 'var(--text-muted)', fontSize: 11, marginBottom: 2 },
  notes: { marginTop: 16, fontSize: 13, color: 'var(--text-secondary)' },
  eventRow: { fontSize: 12, color: 'var(--text-secondary)', padding: '4px 0', borderBottom: '1px solid var(--border-hairline)' },
};
