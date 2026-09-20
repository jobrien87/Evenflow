import { useEffect, useState } from 'react';
import { api } from '../lib/api';
import FlowScoreCard from './FlowScoreCard';
import FunnelMetricsCard from './FunnelMetricsCard';
import RunningReportPage from './RunningReportPage';

export default function ProducerDashboard() {
  const [recap, setRecap] = useState(null);
  const [queue, setQueue] = useState(null);
  const [started, setStarted] = useState(false);
  const [busyId, setBusyId] = useState(null);
  const [showReport, setShowReport] = useState(false);

  useEffect(() => {
    load();
  }, []);

  async function load() {
    const [recapData, queueData] = await Promise.all([api.startMyDay(), api.workQueue()]);
    setRecap(recapData);
    setQueue(queueData);
  }

  async function disposition(item, status, extra) {
    setBusyId(item.id);
    try {
      if (item.itemType === 'LEAD') {
        await api.dispositionLead(item.id, { status, ...extra });
      } else if (item.itemType === 'OPPORTUNITY') {
        await api.dispositionOpportunity(item.id, { status, ...extra });
      } else {
        await api.completeTask(item.id, { status: status === 'COMPLETED' ? 'COMPLETED' : 'CANCELLED' });
      }
      await load();
    } finally {
      setBusyId(null);
    }
  }

  if (!started) {
    return (
      <div style={s.center}>
        <h2 style={s.h2}>Ready when you are.</h2>
        <button style={s.bigButton} onClick={() => setStarted(true)}>
          START MY DAY ⚡
        </button>
      </div>
    );
  }

  if (!recap || !queue) return <div style={s.wrap}>Loading…</div>;

  const next = queue.nextUp;

  return (
    <div style={s.wrap}>
      <section style={s.section}>
        <FlowScoreCard scope="me" onViewReport={() => setShowReport(true)} />
      </section>

      <section style={s.section}>
        <FunnelMetricsCard scope="me" title="MY FUNNEL" />
      </section>

      <section style={s.section}>
        <h3 style={s.h3}>YESTERDAY</h3>
        <div style={s.statsRow}>
          <Stat label="Contacts" value={recap.yesterday.contacts} />
          <Stat label="Quotes" value={recap.yesterday.quotes} />
          <Stat label="Sales" value={recap.yesterday.sales} />
        </div>
      </section>

      {recap.month && (
        <section style={s.section}>
          <h3 style={s.h3}>THIS MONTH</h3>
          <div style={s.statsRow}>
            <Stat label="Goal" value={recap.month.goal} />
            <Stat label="Actual" value={recap.month.actual} />
            <Stat label="Ahead/Behind" value={recap.month.aheadBehind >= 0 ? `+${recap.month.aheadBehind}` : recap.month.aheadBehind} />
          </div>
        </section>
      )}

      <section style={s.section}>
        <h3 style={s.h3}>NEXT UP</h3>
        {next ? (
          <div style={s.nextCard}>
            <div style={s.priorityBadge(next.priorityBand)}>{next.priorityBand} PRIORITY</div>
            <div style={s.nextTitle}>{next.title}</div>
            <div style={s.nextSubtitle}>{next.subtitle}</div>
            <div style={s.nextReason}>{next.priorityReason}</div>
            {next.itemType === 'OPPORTUNITY' ? (
              <OpportunityNextUpActions item={next} busy={busyId === next.id} onAdvance={(status, extra) => disposition(next, status, extra)} />
            ) : (
              <>
                <div style={s.actionsRow}>
                  <button
                    style={s.actionButton}
                    disabled={busyId === next.id}
                    onClick={() => disposition(next, next.itemType === 'LEAD' ? 'CONTACTED' : 'COMPLETED')}
                  >
                    {next.itemType === 'LEAD' ? 'MARK CONTACTED' : 'COMPLETE'}
                  </button>
                  <button style={s.skipButton} disabled={busyId === next.id} onClick={() => disposition(next, next.itemType === 'LEAD' ? 'FOLLOW_UP' : 'CANCELLED')}>
                    SKIP
                  </button>
                </div>
                {next.itemType === 'LEAD' && (
                  <SoldRow item={next} busy={busyId === next.id} onSold={(premium) => disposition(next, 'SOLD', { salePremiumCents: premium })} />
                )}
              </>
            )}
          </div>
        ) : (
          <div style={s.empty}>You're clear right now. Nice work.</div>
        )}
      </section>

      <section style={s.section}>
        <h3 style={s.h3}>QUEUE ({queue.counts.total})</h3>
        {queue.queue.slice(1).map((item) => (
          <div key={item.id} style={s.queueRow}>
            <span style={s.queueBand(item.priorityBand)}>{item.priorityBand[0]}</span>
            <div style={{ flex: 1 }}>
              <div style={s.queueTitle}>{item.title}</div>
              <div style={s.queueSubtitle}>{item.subtitle}</div>
            </div>
          </div>
        ))}
      </section>

      {showReport && (
        <div style={s.reportOverlay} onClick={() => setShowReport(false)}>
          <div style={s.reportModal} onClick={(e) => e.stopPropagation()}>
            <RunningReportPage scope="me" onClose={() => setShowReport(false)} />
          </div>
        </div>
      )}
    </div>
  );
}

function Stat({ label, value }) {
  return (
    <div style={s.stat}>
      <div style={s.statValue}>{value}</div>
      <div style={s.statLabel}>{label}</div>
    </div>
  );
}

function OpportunityNextUpActions({ item, busy, onAdvance }) {
  const [showWon, setShowWon] = useState(false);
  const [premium, setPremium] = useState('');
  const currentStatus = item.status;

  // Advances through the real opportunity state machine one honest step at
  // a time — never guesses a status the backend would reject.
  const nextStepMap = { OPEN: 'ATTEMPTED', ASSIGNED: 'ATTEMPTED', ATTEMPTED: 'CONTACTED', CONTACTED: 'QUOTED', SNOOZED: 'ATTEMPTED' };
  const nextStep = nextStepMap[currentStatus];

  if (currentStatus === 'QUOTED') {
    return (
      <div style={s.actionsRow}>
        {!showWon ? (
          <>
            <button style={s.actionButton} disabled={busy} onClick={() => setShowWon(true)}>WON</button>
            <button style={s.skipButton} disabled={busy} onClick={() => onAdvance('DECLINED')}>DECLINE</button>
          </>
        ) : (
          <>
            <input style={s.soldInput} placeholder="Premium $" value={premium} onChange={(e) => setPremium(e.target.value)} />
            <button style={s.actionButton} disabled={busy || !premium} onClick={() => onAdvance('WON', { wonPremiumCents: Math.round(parseFloat(premium) * 100) })}>
              CONFIRM
            </button>
          </>
        )}
      </div>
    );
  }

  return (
    <div style={s.actionsRow}>
      {nextStep && (
        <button style={s.actionButton} disabled={busy} onClick={() => onAdvance(nextStep)}>
          MARK {nextStep}
        </button>
      )}
      <button style={s.skipButton} disabled={busy} onClick={() => onAdvance('DECLINED')}>
        DECLINE
      </button>
    </div>
  );
}

function SoldRow({ item, busy, onSold }) {
  const [open, setOpen] = useState(false);
  const [premium, setPremium] = useState('');

  if (!open) {
    return (
      <button style={s.soldToggle} onClick={() => setOpen(true)}>
        Mark SOLD instead
      </button>
    );
  }

  return (
    <div style={s.soldRow}>
      <input
        style={s.soldInput}
        type="number"
        step="0.01"
        min="0"
        placeholder="Premium $"
        value={premium}
        onChange={(e) => setPremium(e.target.value)}
      />
      <button
        style={s.soldButton}
        disabled={busy || !premium}
        onClick={() => onSold(Math.round(parseFloat(premium) * 100))}
      >
        CONFIRM SOLD
      </button>
    </div>
  );
}

const s = {
  center: { display: 'flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'center', height: '70vh', gap: 24 },
  h2: { color: 'var(--text-primary)', fontWeight: 400 },
  bigButton: { padding: '20px 48px', fontSize: 20, fontWeight: 800, background: 'var(--accent)', border: 'none', borderRadius: 8, cursor: 'pointer' },
  wrap: { color: 'var(--text-primary)' },
  section: { marginBottom: 32 },
  h3: { color: 'var(--text-secondary)', fontSize: 12, letterSpacing: 2, marginBottom: 12 },
  statsRow: { display: 'flex', gap: 16 },
  stat: { background: 'var(--bg-elevated)', border: '1px solid var(--border-hairline)', borderRadius: 8, padding: 16, flex: 1, textAlign: 'center' },
  statValue: { fontSize: 28, fontWeight: 700 },
  statLabel: { fontSize: 11, color: 'var(--text-secondary)', marginTop: 4 },
  nextCard: { background: 'var(--bg-elevated)', border: '1px solid var(--border-accent)', borderRadius: 12, padding: 20 },
  priorityBadge: (band) => ({
    display: 'inline-block',
    fontSize: 11,
    fontWeight: 700,
    padding: '4px 10px',
    borderRadius: 4,
    marginBottom: 10,
    background: band === 'HIGH' ? 'var(--danger-soft)' : band === 'MEDIUM' ? 'var(--warning-soft)' : 'var(--bg-hover)',
    color: band === 'HIGH' ? 'var(--danger)' : band === 'MEDIUM' ? 'var(--warning)' : 'var(--text-secondary)',
  }),
  nextTitle: { fontSize: 22, fontWeight: 700 },
  nextSubtitle: { color: 'var(--text-secondary)', marginTop: 2 },
  nextReason: { color: 'var(--text-muted)', fontSize: 13, marginTop: 8 },
  actionsRow: { display: 'flex', gap: 10, marginTop: 16 },
  actionButton: { flex: 1, padding: '12px', background: 'var(--accent)', border: 'none', borderRadius: 6, fontWeight: 700, cursor: 'pointer' },
  skipButton: { padding: '12px 20px', background: 'transparent', border: '1px solid var(--border-strong)', color: 'var(--text-secondary)', borderRadius: 6, cursor: 'pointer' },
  soldToggle: { background: 'none', border: 'none', color: 'var(--text-muted)', fontSize: 12, marginTop: 10, cursor: 'pointer', textDecoration: 'underline' },
  soldRow: { display: 'flex', gap: 8, marginTop: 10 },
  soldInput: { flex: 1, padding: '8px 10px', background: 'var(--bg-sunken)', border: '1px solid var(--border-strong)', borderRadius: 6, color: 'var(--text-primary)', fontSize: 13 },
  soldButton: { padding: '8px 14px', background: 'var(--accent)', border: 'none', borderRadius: 6, fontWeight: 700, cursor: 'pointer', fontSize: 12 },
  empty: { color: 'var(--text-muted)', fontStyle: 'italic' },
  queueRow: { display: 'flex', alignItems: 'center', gap: 12, padding: '10px 0', borderBottom: '1px solid var(--border-hairline)' },
  queueBand: (band) => ({
    width: 24, height: 24, borderRadius: '50%', display: 'flex', alignItems: 'center', justifyContent: 'center', fontSize: 11, fontWeight: 700,
    background: band === 'HIGH' ? 'var(--danger-soft)' : band === 'MEDIUM' ? 'var(--warning-soft)' : 'var(--bg-hover)',
    color: band === 'HIGH' ? 'var(--danger)' : band === 'MEDIUM' ? 'var(--warning)' : 'var(--text-secondary)',
  }),
  queueTitle: { fontSize: 14 },
  queueSubtitle: { fontSize: 12, color: 'var(--text-muted)' },
  reportOverlay: { position: 'fixed', top: 0, left: 0, right: 0, bottom: 0, background: 'rgba(0,0,0,0.75)', display: 'flex', alignItems: 'center', justifyContent: 'center', zIndex: 2500, padding: 20, overflowY: 'auto' },
  reportModal: { background: 'var(--bg-sunken)', border: '1px solid var(--border-strong)', borderRadius: 12, maxWidth: 680, width: '100%', maxHeight: '85vh', overflowY: 'auto' },
};
