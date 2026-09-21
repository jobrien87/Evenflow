import { useEffect, useState } from 'react';
import { api } from '../lib/api';
import { useAuth } from '../lib/AuthContext';
import { useIsMobile } from '../lib/useViewport';
import { Card, Badge, Button, SectionHeader, EmptyState } from '../ui';
import ChatThread from './ChatThread';

const LEAD_STATUSES = [
  'NEW', 'ASSIGNED', 'ATTEMPTED', 'CONTACTED', 'APPOINTMENT', 'QUOTE_STARTED',
  'QUOTED', 'FOLLOW_UP', 'SOLD', 'LOST', 'BAD_CONTACT', 'DUPLICATE', 'DO_NOT_CONTACT', 'ARCHIVED',
];

function statusTone(status) {
  if (status === 'SOLD') return 'accent';
  if (['LOST', 'BAD_CONTACT', 'DUPLICATE', 'DO_NOT_CONTACT'].includes(status)) return 'danger';
  if (status === 'NEW') return 'warning';
  return 'neutral';
}

// Yield Transfers rebuild: telemarketer submissions are real Leads
// (source: 'telemarketer'), instantly visible here the moment they're
// created — no accept/reject gate, matching the Inferno Connect
// reference. The team-wide chat lives alongside the leads list; a
// focused per-lead DISCUSS thread is kept too, opened in its own modal.
export default function YieldTransfersPanel() {
  const { user } = useAuth();
  const isMobile = useIsMobile();
  const [leads, setLeads] = useState([]);
  const [error, setError] = useState('');
  const [discussLead, setDiscussLead] = useState(null);

  useEffect(() => {
    load();
    const interval = setInterval(load, 8000);
    return () => clearInterval(interval);
  }, []);

  async function load() {
    try {
      const data = await api.leads('?source=telemarketer');
      setLeads(data.leads);
      setError('');
    } catch (err) {
      setError(err.data?.message || 'Could not load leads.');
    }
  }

  return (
    <div style={s.wrap}>
      <SectionHeader>YIELD TRANSFERS</SectionHeader>
      {error && <div style={s.error}>{error}</div>}

      <div style={isMobile ? s.stacked : s.split}>
        <div style={s.leadsColumn}>
          {leads.length === 0 ? (
            <EmptyState
              title="No leads yet"
              description="Telemarketer submissions land here the instant they're sent — nothing to accept or reject, just real leads to work."
            />
          ) : (
            leads.map((lead) => (
              <LeadCard key={lead.id} lead={lead} onDisposition={load} onDiscuss={() => setDiscussLead(lead)} />
            ))
          )}
        </div>

        <div style={s.chatColumn}>
          <ChatThread entityType="AGENCY" entityId={user.agencyId} variant="inline" title="TEAM CHAT" />
        </div>
      </div>

      {discussLead && (
        <ChatThread
          entityType="LEAD"
          entityId={discussLead.id}
          title={`DISCUSS · ${discussLead.customer?.firstName || 'Lead'} ${discussLead.customer?.lastName || ''}`}
          onClose={() => setDiscussLead(null)}
        />
      )}
    </div>
  );
}

function InfoRow({ icon, children }) {
  if (!children) return null;
  return <div style={s.infoRow}><span style={s.infoIcon}>{icon}</span>{children}</div>;
}

function LeadCard({ lead, onDisposition, onDiscuss }) {
  const c = lead.customer;
  const vehicle = [lead.vehicleYear, lead.vehicleMake, lead.vehicleModel].filter(Boolean).join(' ');
  const home = [lead.ownRent, lead.homeAge && `${lead.homeAge} yrs old`, lead.sqFootage && `${lead.sqFootage} sq ft`].filter(Boolean).join(' · ');
  const carrier = [lead.currentInsurance, lead.currentPremium && `$${lead.currentPremium}/mo`, lead.yearsWithCarrier].filter(Boolean).join(' · ');

  return (
    <Card style={s.card}>
      <div style={s.cardTop} className="ui-row-stack">
        <div>
          <div style={s.name}>
            {c ? `${c.firstName} ${c.lastName}` : 'Lead'}
            {lead.product && <Badge tone="neutral" style={{ marginLeft: 8 }}>{lead.product}</Badge>}
          </div>
          <div style={s.meta}>
            Submitted by {lead.createdBy ? `${lead.createdBy.firstName} ${lead.createdBy.lastName}` : 'a telemarketer'} · {new Date(lead.receivedAt).toLocaleString()}
          </div>
        </div>
        <Badge tone={statusTone(lead.status)}>{lead.status.replace(/_/g, ' ')}</Badge>
      </div>

      <div style={s.infoGrid}>
        <InfoRow icon="📞">{c?.phone || null}</InfoRow>
        <InfoRow icon="✉️">{c?.email || null}</InfoRow>
        <InfoRow icon="🏠">{[lead.address, lead.city, lead.state, lead.zip].filter(Boolean).join(', ') || null}</InfoRow>
        <InfoRow icon="🎂">{lead.dob ? `DOB: ${new Date(lead.dob).toLocaleDateString()}` : null}</InfoRow>
        <InfoRow icon="🚗">{vehicle || null}</InfoRow>
        <InfoRow icon="🏘️">{home || null}</InfoRow>
        <InfoRow icon="🏢">{carrier || null}</InfoRow>
        <InfoRow icon="📅">{lead.callbackTime ? `Callback: ${lead.callbackTime}` : null}</InfoRow>
      </div>

      {lead.tmNotes && (
        <div style={s.notesBox}>
          <strong style={s.notesLabel}>TM Notes:</strong> {lead.tmNotes}
        </div>
      )}

      <div style={s.cardActions}>
        <DispositionControl lead={lead} onDone={onDisposition} />
        <Button variant="secondary" size="sm" onClick={onDiscuss}>DISCUSS</Button>
      </div>
    </Card>
  );
}

function DispositionControl({ lead, onDone }) {
  const [status, setStatus] = useState(lead.status);
  const [premium, setPremium] = useState('');
  const [saleProduct, setSaleProduct] = useState(lead.product || '');
  const [busy, setBusy] = useState(false);

  async function submit() {
    if (status === lead.status) return;
    setBusy(true);
    try {
      await api.dispositionLead(lead.id, {
        status,
        saleProduct: status === 'SOLD' ? saleProduct : undefined,
        salePremiumCents: status === 'SOLD' && premium ? Math.round(parseFloat(premium) * 100) : undefined,
      });
      onDone();
    } finally {
      setBusy(false);
    }
  }

  return (
    <div style={s.dispositionRow}>
      <select style={s.select} value={status} onChange={(e) => setStatus(e.target.value)}>
        {LEAD_STATUSES.map((st) => <option key={st} value={st}>{st.replace(/_/g, ' ')}</option>)}
      </select>
      {status === 'SOLD' && (
        <input style={s.miniInput} placeholder="Premium $" value={premium} onChange={(e) => setPremium(e.target.value)} />
      )}
      <Button variant="primary" size="sm" disabled={busy || status === lead.status} onClick={submit}>SAVE</Button>
    </div>
  );
}

const s = {
  wrap: {},
  error: { color: 'var(--danger)', marginBottom: 12, fontSize: 13 },
  split: { display: 'grid', gridTemplateColumns: '1fr 360px', gap: 20, alignItems: 'start' },
  stacked: { display: 'flex', flexDirection: 'column', gap: 20 },
  leadsColumn: { display: 'flex', flexDirection: 'column', gap: 12, minWidth: 0 },
  chatColumn: { position: 'sticky', top: 0, height: 560 },
  card: {},
  cardTop: { display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start', marginBottom: 12, gap: 8 },
  name: { fontWeight: 700, fontSize: 16, color: 'var(--text-primary)' },
  meta: { color: 'var(--text-muted)', fontSize: 11, marginTop: 2 },
  infoGrid: { display: 'grid', gridTemplateColumns: '1fr 1fr', gap: '4px 20px', fontSize: 12, color: 'var(--text-secondary)', marginBottom: 10 },
  infoRow: { display: 'flex', gap: 6, alignItems: 'baseline' },
  infoIcon: { flexShrink: 0 },
  notesBox: {
    background: 'var(--accent-gradient-soft)', border: '1px solid var(--border-accent)', borderRadius: 'var(--radius-sm)',
    padding: 10, fontSize: 12, color: 'var(--text-secondary)', marginBottom: 10, lineHeight: 1.5,
  },
  notesLabel: { color: 'var(--accent)' },
  cardActions: { display: 'flex', justifyContent: 'space-between', alignItems: 'center', gap: 8, flexWrap: 'wrap', paddingTop: 8, borderTop: '1px solid var(--border-hairline)' },
  dispositionRow: { display: 'flex', gap: 6, alignItems: 'center', flexWrap: 'wrap' },
  select: { padding: '6px 8px', background: 'var(--bg-sunken)', border: '1px solid var(--border-strong)', borderRadius: 6, color: 'var(--text-primary)', fontSize: 12 },
  miniInput: { padding: '6px 8px', background: 'var(--bg-sunken)', border: '1px solid var(--border-strong)', borderRadius: 6, color: 'var(--text-primary)', fontSize: 12, width: 90 },
};
