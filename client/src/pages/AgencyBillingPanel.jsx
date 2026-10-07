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
  const [salesStudioBusy, setSalesStudioBusy] = useState(false);
  const [salesStudioError, setSalesStudioError] = useState('');
  const [seatInput, setSeatInput] = useState('');
  const [addSeatsInput, setAddSeatsInput] = useState('');
  const [addSeatsBusy, setAddSeatsBusy] = useState(false);
  const [addSeatsError, setAddSeatsError] = useState('');
  const params = new URLSearchParams(window.location.search);
  const checkoutResult = params.get('checkout');
  const salesStudioResult = params.get('salesStudio');

  useEffect(() => {
    if (user.agencyId) {
      api.agencySubscription(user.agencyId).then((d) => setSubscription(d.subscription));
    }
    loadSelfServe();
  }, [user.agencyId]);

  async function loadSelfServe() {
    try {
      const d = await api.selfServeBillingStatus();
      setSelfServe(d);
      setSeatInput(String(d.seatCount || 1));
    } catch {
      setSelfServe(null);
    }
  }

  async function startCheckout() {
    setSelfServeBusy(true);
    setSelfServeError('');
    try {
      const res = await api.startSelfServeCheckout(Number(seatInput) || undefined);
      window.location.href = res.url;
    } catch (err) {
      setSelfServeError(err.data?.message || 'Could not start checkout.');
      setSelfServeBusy(false);
    }
  }

  async function addSeats() {
    setAddSeatsBusy(true);
    setAddSeatsError('');
    try {
      await api.updateSelfServeSeats(Number(addSeatsInput));
      setAddSeatsInput('');
      await loadSelfServe();
    } catch (err) {
      setAddSeatsError(err.data?.message || 'Could not update seats.');
    } finally {
      setAddSeatsBusy(false);
    }
  }

  async function startSalesStudioCheckout() {
    setSalesStudioBusy(true);
    setSalesStudioError('');
    try {
      const res = await api.startSalesStudioCheckout();
      window.location.href = res.url;
    } catch (err) {
      setSalesStudioError(err.data?.message || 'Could not start checkout.');
      setSalesStudioBusy(false);
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
  const monthlyTotalCents = selfServe ? (selfServe.seatLimit ?? selfServe.seatCount) * selfServe.pricePerSeatCents : 0;

  return (
    <div style={s.wrap}>
      {checkoutResult === 'success' && (
        <div style={s.banner('success')}>Subscription started — welcome aboard. It may take a few seconds to show as active below.</div>
      )}
      {checkoutResult === 'canceled' && (
        <div style={s.banner('warning')}>Checkout was canceled — no charge was made.</div>
      )}
      {salesStudioResult === 'success' && (
        <div style={s.banner('success')}>Sales Studio unlocked — it may take a few seconds to show below.</div>
      )}
      {salesStudioResult === 'canceled' && (
        <div style={s.banner('warning')}>Sales Studio checkout was canceled — no charge was made.</div>
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
              <StatTile label="Seats purchased" value={selfServe.seatLimit ?? selfServe.seatCount} />
              <StatTile label="Seats in use" value={selfServe.occupiedSeats} sub={selfServe.seatLimit != null ? `of ${selfServe.seatLimit}` : undefined} />
              <StatTile label="Per seat" value={`$${(selfServe.pricePerSeatCents / 100).toFixed(2)}/mo`} />
              <StatTile label="Monthly total" value={`$${(monthlyTotalCents / 100).toFixed(2)}`} />
            </div>
            <div style={s.addSeatsRow}>
              <input
                style={s.seatInputSmall}
                type="number"
                min={selfServe.seatCount}
                value={addSeatsInput}
                placeholder={`New total (≥ ${selfServe.seatCount})`}
                onChange={(e) => setAddSeatsInput(e.target.value)}
              />
              <Button variant="secondary" size="sm" onClick={addSeats} disabled={addSeatsBusy || !addSeatsInput}>
                {addSeatsBusy ? 'UPDATING…' : 'UPDATE SEATS'}
              </Button>
            </div>
            {addSeatsError && <div style={s.error}>{addSeatsError}</div>}
            <Button variant="secondary" size="sm" onClick={openPortal} disabled={selfServeBusy} style={{ marginTop: 12 }}>
              {selfServeBusy ? 'OPENING…' : 'MANAGE BILLING'}
            </Button>
          </>
        ) : (
          <>
            <div style={s.planName}>EvenFlow Standard</div>
            <div style={{ color: 'var(--text-secondary)', fontSize: 13, marginTop: 4 }}>
              ${(selfServe.setupFeeCents / 100).toFixed(0)} one-time setup fee, then ${(selfServe.pricePerSeatCents / 100).toFixed(2)}/user/month —
              every active teammate counts as one seat. You currently have {selfServe.seatCount} active user{selfServe.seatCount === 1 ? '' : 's'}.
            </div>
            <div style={s.addSeatsRow}>
              <label style={s.seatLabel}>Seats to buy</label>
              <input
                style={s.seatInputSmall}
                type="number"
                min={selfServe.seatCount}
                value={seatInput}
                onChange={(e) => setSeatInput(e.target.value)}
              />
            </div>
            <div style={{ color: 'var(--text-muted)', fontSize: 12, marginTop: 4 }}>
              Producers can only be invited up to how many seats you buy — add more any time.
            </div>
            <Button variant="primary" size="sm" onClick={startCheckout} disabled={selfServeBusy} style={{ marginTop: 16 }}>
              {selfServeBusy ? 'STARTING…' : `SUBSCRIBE — $${(selfServe.setupFeeCents / 100).toFixed(0)} + $${((Number(seatInput) || 1) * selfServe.pricePerSeatCents / 100).toFixed(2)}/mo`}
            </Button>
          </>
        )}
        {selfServeError && <div style={s.error}>{selfServeError}</div>}
      </Card>

      {selfServe?.configured && (
        <>
          <SectionHeader>SALES STUDIO</SectionHeader>
          <Card style={s.card}>
            {selfServe.salesStudioPurchased ? (
              <>
                <div style={s.planName}>Sales Studio</div>
                <Badge tone="accent" style={{ marginTop: 6 }}>UNLOCKED</Badge>
              </>
            ) : (
              <>
                <div style={s.planName}>Sales Studio</div>
                <div style={{ color: 'var(--text-secondary)', fontSize: 13, marginTop: 4 }}>
                  ${(selfServe.salesStudioPriceCents / 100).toFixed(0)} one-time — unlocks Drills, Call Scoring, and Call Coaching for every producer on this agency.
                </div>
                <Button variant="primary" size="sm" onClick={startSalesStudioCheckout} disabled={salesStudioBusy} style={{ marginTop: 16 }}>
                  {salesStudioBusy ? 'STARTING…' : `UNLOCK — $${(selfServe.salesStudioPriceCents / 100).toFixed(0)}`}
                </Button>
              </>
            )}
            {salesStudioError && <div style={s.error}>{salesStudioError}</div>}
          </Card>
        </>
      )}

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
  addSeatsRow: { display: 'flex', alignItems: 'center', gap: 8, marginTop: 14, flexWrap: 'wrap' },
  seatLabel: { fontSize: 12, color: 'var(--text-muted)' },
  seatInputSmall: { width: 140, padding: '8px 10px', background: 'var(--bg-sunken)', border: '1px solid var(--border-strong)', borderRadius: 6, color: 'var(--text-primary)', fontSize: 13 },
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
