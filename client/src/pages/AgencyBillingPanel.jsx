import { useEffect, useState } from 'react';
import { api } from '../lib/api';
import { useAuth } from '../lib/AuthContext';
import { Card, Badge, Button, SectionHeader, StatTile } from '../ui';

export default function AgencyBillingPanel() {
  const { user } = useAuth();
  const [subscription, setSubscription] = useState(undefined);
  const [showRequest, setShowRequest] = useState(false);
  const [requestNote, setRequestNote] = useState('');
  const [status, setStatus] = useState('');
  const [selfServe, setSelfServe] = useState(undefined);
  const [selfServeBusy, setSelfServeBusy] = useState(false);
  const [selfServeError, setSelfServeError] = useState('');
  const checkoutResult = new URLSearchParams(window.location.search).get('checkout');

  useEffect(() => {
    if (user.agencyId) {
      api.agencySubscription(user.agencyId).then((d) => setSubscription(d.subscription));
    }
    api.selfServeBillingStatus().then(setSelfServe).catch(() => setSelfServe(null));
  }, [user.agencyId]);

  async function startCheckout() {
    setSelfServeBusy(true);
    setSelfServeError('');
    try {
      const res = await api.startSelfServeCheckout();
      window.location.href = res.url;
    } catch (err) {
      setSelfServeError(err.data?.message || 'Could not start checkout.');
      setSelfServeBusy(false);
    }
  }

  async function openPortal() {
    setSelfServeBusy(true);
    setSelfServeError('');
    try {
      const res = await api.openBillingPortal();
      window.location.href = res.url;
    } catch (err) {
      setSelfServeError(err.data?.message || 'Could not open billing portal.');
      setSelfServeBusy(false);
    }
  }

  async function requestChange(e) {
    e.preventDefault();
    setStatus('Submitting…');
    try {
      await api.createSupportTicket({
        category: 'billing',
        subject: 'Plan change request',
        description: requestNote,
      });
      setStatus('Request submitted to the platform team.');
      setRequestNote('');
      setTimeout(() => setShowRequest(false), 1200);
    } catch (err) {
      setStatus(err.data?.message || 'Failed to submit request.');
    }
  }

  if (subscription === undefined || selfServe === undefined) {
    return <div style={{ color: 'var(--text-muted)' }}>Loading…</div>;
  }

  const activeSelfServe = selfServe?.subscription && ['ACTIVE', 'PAST_DUE', 'TRIALING'].includes(selfServe.subscription.status);
  const monthlyTotalCents = selfServe ? selfServe.seatCount * selfServe.pricePerSeatCents : 0;

  return (
    <div style={s.wrap}>
      {checkoutResult === 'success' && (
        <div style={s.banner('success')}>Subscription started — welcome aboard. It may take a few seconds to show as active below.</div>
      )}
      {checkoutResult === 'canceled' && (
        <div style={s.banner('warning')}>Checkout was canceled — no charge was made.</div>
      )}

      <SectionHeader>YOUR SUBSCRIPTION</SectionHeader>
      <Card style={s.card}>
        {!selfServe?.configured ? (
          <div style={{ color: 'var(--text-secondary)', fontSize: 13 }}>
            Self-serve billing isn't turned on yet. Reach out to your platform contact for billing questions.
          </div>
        ) : activeSelfServe ? (
          <>
            <div style={s.planName}>EvenFlow Standard</div>
            <Badge tone={selfServe.subscription.status === 'ACTIVE' ? 'accent' : 'warning'}>{selfServe.subscription.status}</Badge>
            <div style={s.statsRow}>
              <StatTile label="Seats billed" value={selfServe.seatCount} />
              <StatTile label="Per seat" value={`$${(selfServe.pricePerSeatCents / 100).toFixed(2)}/mo`} />
              <StatTile label="Monthly total" value={`$${(monthlyTotalCents / 100).toFixed(2)}`} />
            </div>
            <Button variant="secondary" size="sm" onClick={openPortal} disabled={selfServeBusy} style={{ marginTop: 16 }}>
              {selfServeBusy ? 'OPENING…' : 'MANAGE BILLING'}
            </Button>
          </>
        ) : (
          <>
            <div style={s.planName}>EvenFlow Standard</div>
            <div style={{ color: 'var(--text-secondary)', fontSize: 13, marginTop: 4 }}>
              $35/user/month — every active teammate counts as one seat. Currently {selfServe.seatCount} seat{selfServe.seatCount === 1 ? '' : 's'} (${(monthlyTotalCents / 100).toFixed(2)}/mo).
            </div>
            <Button variant="primary" size="sm" onClick={startCheckout} disabled={selfServeBusy} style={{ marginTop: 16 }}>
              {selfServeBusy ? 'STARTING…' : 'SUBSCRIBE'}
            </Button>
          </>
        )}
        {selfServeError && <div style={s.error}>{selfServeError}</div>}
      </Card>

      <SectionHeader>PLATFORM-ASSIGNED PLAN</SectionHeader>
      {subscription ? (
        <Card style={s.card}>
          <div style={s.planName}>{subscription.plan.name}</div>
          <div style={s.planPrice}>${(subscription.plan.priceCents / 100).toFixed(2)}/{subscription.plan.interval === 'MONTHLY' ? 'month' : 'year'}</div>
          <Badge tone={subscription.status === 'ACTIVE' ? 'accent' : 'warning'} style={{ marginTop: 10 }}>{subscription.status}</Badge>
          <div style={s.moduleList}>
            {[
              { key: 'crmEnabled', label: 'CRM' },
              { key: 'transfersEnabled', label: 'Yield Transfers' },
              { key: 'coachingEnabled', label: 'Sales Coaching' },
            ].map((m) => (
              <div key={m.key} style={s.moduleRow}>
                <span>{m.label}</span>
                <span style={{ color: subscription.plan[m.key] ? 'var(--accent)' : 'var(--text-muted)' }}>
                  {subscription.plan[m.key] ? 'Included' : 'Not included'}
                </span>
              </div>
            ))}
          </div>
        </Card>
      ) : (
        <Card style={s.card}>
          <div style={{ color: 'var(--text-secondary)', fontSize: 13 }}>No plan manually assigned by the platform team — your access comes from the subscription above (if any).</div>
        </Card>
      )}

      <button style={s.requestButton} onClick={() => setShowRequest(!showRequest)}>
        Request a plan change
      </button>

      {showRequest && (
        <form onSubmit={requestChange} style={s.form}>
          <div style={s.hint}>
            Describe what you're looking for and the platform team will follow up.
          </div>
          <textarea
            style={{ ...s.input, minHeight: 80 }}
            placeholder="e.g. We'd like to add Yield Transfers to our plan"
            value={requestNote}
            onChange={(e) => setRequestNote(e.target.value)}
            required
          />
          <button style={s.submitButton} type="submit">Submit Request</button>
          {status && <div style={s.status}>{status}</div>}
        </form>
      )}
    </div>
  );
}

const s = {
  wrap: { maxWidth: 480 },
  card: { marginBottom: 20 },
  planName: { fontSize: 20, fontWeight: 700, color: 'var(--text-primary)' },
  planPrice: { color: 'var(--text-secondary)', fontSize: 13, marginTop: 4 },
  statsRow: { display: 'flex', gap: 16, marginTop: 16, flexWrap: 'wrap' },
  moduleList: { marginTop: 16, borderTop: '1px solid var(--border-hairline)', paddingTop: 12 },
  moduleRow: { display: 'flex', justifyContent: 'space-between', padding: '6px 0', fontSize: 13, color: 'var(--text-secondary)' },
  requestButton: { padding: '10px 16px', background: 'transparent', border: '1px solid var(--border-strong)', color: 'var(--text-secondary)', borderRadius: 6, cursor: 'pointer', fontSize: 13 },
  form: { display: 'flex', flexDirection: 'column', gap: 10, background: 'var(--bg-elevated)', padding: 16, borderRadius: 8, marginTop: 12, border: '1px solid var(--border-hairline)' },
  hint: { color: 'var(--text-muted)', fontSize: 12, lineHeight: 1.5 },
  input: { padding: '10px 12px', background: 'var(--bg-sunken)', border: '1px solid var(--border-strong)', borderRadius: 6, color: 'var(--text-primary)' },
  submitButton: { padding: '10px', background: 'var(--accent)', border: 'none', borderRadius: 6, fontWeight: 700, cursor: 'pointer' },
  status: { color: 'var(--accent)', fontSize: 12 },
  error: { color: 'var(--danger)', fontSize: 12, marginTop: 10 },
  banner: (tone) => ({
    padding: '10px 14px', borderRadius: 8, fontSize: 13, marginBottom: 16,
    background: tone === 'success' ? 'var(--accent-gradient-soft)' : 'var(--warning-soft)',
    color: tone === 'success' ? 'var(--accent)' : 'var(--warning)',
  }),
};
