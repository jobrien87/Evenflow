import { useState } from 'react';
import { api } from '../lib/api';
import { Modal, Button, Badge, Icon } from '../ui';

const US_STATE_RE = /^[A-Za-z]{2}$/;

function centsToDollars(cents) {
  return ((cents || 0) / 100).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
}

// Multi-step purchase wizard — entered already knowing which template was
// picked from the storefront card (that's "Step 1: Choose Lead Product"),
// so this covers Agency Information through Fund Account. Step count
// varies by product: the Delivery step only appears for Live Call (IPR)
// templates, matching the master spec's "exact step count can change
// slightly based on product."
export default function RecordStoreWizard({ template, agency, user, onClose, onDone }) {
  const isIpr = template.isIpr;
  const steps = isIpr ? ['Agency Info', 'Delivery', 'Volume', 'Review', 'Fund Account'] : ['Agency Info', 'Volume', 'Review', 'Fund Account'];
  const [stepIndex, setStepIndex] = useState(0);
  const [agencyForm, setAgencyForm] = useState({
    address: agency.address || '', city: agency.city || '', state: agency.state || '', zip: agency.zip || '',
  });
  const [ringToPhone, setRingToPhone] = useState('');
  const [maxConcurrentCalls, setMaxConcurrentCalls] = useState(1);
  const [dailyVolume, setDailyVolume] = useState(template.defaultDailyVolume);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [subscription, setSubscription] = useState(null);
  const [paymentPageUrl, setPaymentPageUrl] = useState(null);
  const [fundingSatisfied, setFundingSatisfied] = useState(false);

  const stepName = steps[stepIndex];

  async function goNext() {
    setError('');
    if (stepName === 'Agency Info') {
      if (!agencyForm.address || !agencyForm.city || !agencyForm.zip || !US_STATE_RE.test(agencyForm.state)) {
        setError('Please fill in a complete address with a valid 2-letter state.');
        return;
      }
      const changed = agencyForm.address !== (agency.address || '') || agencyForm.city !== (agency.city || '')
        || agencyForm.state !== (agency.state || '') || agencyForm.zip !== (agency.zip || '');
      if (changed) {
        setBusy(true);
        try {
          await api.updateAgency(agency.id, { ...agencyForm, state: agencyForm.state.toUpperCase() });
        } catch (err) {
          setBusy(false);
          setError(err.data?.message || 'Could not save your agency address.');
          return;
        }
        setBusy(false);
      }
      setStepIndex((i) => i + 1);
      return;
    }
    if (stepName === 'Delivery') {
      if (!ringToPhone || ringToPhone.replace(/\D/g, '').length < 10) {
        setError('Enter a valid destination phone number for live transfers.');
        return;
      }
      setStepIndex((i) => i + 1);
      return;
    }
    if (stepName === 'Volume') {
      setStepIndex((i) => i + 1);
      return;
    }
    if (stepName === 'Review') {
      setBusy(true);
      try {
        const orderRes = await api.createRecordStoreOrder({
          templateSlug: template.slug,
          dailyVolume,
          ...(isIpr ? { ringToPhone, maxConcurrentCalls } : {}),
        });
        const provisionRes = await api.provisionRecordStoreOrder(orderRes.subscription.id);
        setSubscription(provisionRes.subscription);
        setPaymentPageUrl(provisionRes.paymentPageUrl);
        setStepIndex((i) => i + 1);
      } catch (err) {
        setError(err.data?.message || 'Could not start your lead program. Please try again.');
      } finally {
        setBusy(false);
      }
      return;
    }
  }

  function goBack() {
    setError('');
    setStepIndex((i) => Math.max(0, i - 1));
  }

  async function confirmPayment() {
    setBusy(true);
    setError('');
    try {
      const res = await api.confirmRecordStoreFunding(subscription.id);
      setSubscription(res.subscription);
      setFundingSatisfied(!!res.satisfied);
      if (!res.satisfied) {
        setError("We don't see your deposit yet. If you just paid, this can take a minute — try again shortly.");
      }
    } catch (err) {
      setError(err.data?.message || 'Could not check your payment status.');
    } finally {
      setBusy(false);
    }
  }

  const estimatedDailySpend = ((template.wholesalePriceCents || 0) * dailyVolume) / 100;

  return (
    <Modal title={`SET UP — ${template.displayName.toUpperCase()}`} onClose={fundingSatisfied ? () => { onDone(); onClose(); } : onClose} maxWidth={620}>
      <div style={s.stepper}>
        {steps.map((name, i) => (
          <div key={name} style={s.stepperItem}>
            <div style={i < stepIndex || (i === stepIndex && fundingSatisfied) ? { ...s.stepDot, ...s.stepDotDone } : i === stepIndex ? { ...s.stepDot, ...s.stepDotActive } : s.stepDot}>
              {i < stepIndex || (i === stepIndex && fundingSatisfied) ? '✓' : i + 1}
            </div>
            <span style={i === stepIndex ? s.stepLabelActive : s.stepLabel}>{name}</span>
          </div>
        ))}
      </div>

      {stepName === 'Agency Info' && (
        <div style={s.form}>
          <div style={s.helpText}>We already know you — just confirm the company address Boberdoo needs to set up your buyer account.</div>
          <label style={s.fieldLabel}>Company name<input style={s.input} value={agency.name} disabled /></label>
          <label style={s.fieldLabel}>Contact<input style={s.input} value={`${user.firstName} ${user.lastName} · ${user.email}`} disabled /></label>
          <label style={s.fieldLabel}>Street address<input style={s.input} value={agencyForm.address} onChange={(e) => setAgencyForm({ ...agencyForm, address: e.target.value })} /></label>
          <div style={s.row3}>
            <label style={s.fieldLabel}>City<input style={s.input} value={agencyForm.city} onChange={(e) => setAgencyForm({ ...agencyForm, city: e.target.value })} /></label>
            <label style={s.fieldLabel}>State<input style={{ ...s.input, textTransform: 'uppercase' }} maxLength={2} value={agencyForm.state} onChange={(e) => setAgencyForm({ ...agencyForm, state: e.target.value })} /></label>
            <label style={s.fieldLabel}>Zip<input style={s.input} value={agencyForm.zip} onChange={(e) => setAgencyForm({ ...agencyForm, zip: e.target.value })} /></label>
          </div>
        </div>
      )}

      {stepName === 'Delivery' && (
        <div style={s.form}>
          <div style={s.helpText}>Live Call Setup routes real-time phone transfers straight to your team. Where should calls ring?</div>
          <label style={s.fieldLabel}>Destination phone (ring-to)<input style={s.input} placeholder="(555) 123-4567" value={ringToPhone} onChange={(e) => setRingToPhone(e.target.value)} /></label>
          <label style={s.fieldLabel}>Max concurrent calls<input style={s.input} type="number" min={1} max={10} value={maxConcurrentCalls} onChange={(e) => setMaxConcurrentCalls(Number(e.target.value))} /></label>
        </div>
      )}

      {stepName === 'Volume' && (
        <div style={s.form}>
          <div style={s.helpText}>How many {isIpr ? 'live calls' : 'leads'} per day?</div>
          <div style={s.volumeRow}>
            <button type="button" style={s.volumeButton} onClick={() => setDailyVolume((v) => Math.max(template.minimumDailyVolume, v - 1))}>−</button>
            <div style={s.volumeValue}>{dailyVolume} / day</div>
            <button type="button" style={s.volumeButton} onClick={() => setDailyVolume((v) => Math.min(template.maximumDailyVolume, v + 1))}>+</button>
          </div>
          <div style={s.volumeRange}>Range: {template.minimumDailyVolume}–{template.maximumDailyVolume} / day</div>
          <div style={s.estimate}>Estimated daily spend: <strong>${estimatedDailySpend.toFixed(2)}</strong></div>
        </div>
      )}

      {stepName === 'Review' && (
        <div style={s.form}>
          <div style={s.reviewCard}>
            <div style={s.reviewTitle}>{template.displayName}{isIpr && <Badge tone="accent" style={{ marginLeft: 8 }}>LIVE CALL</Badge>}</div>
            <div style={s.reviewRow}><span>Daily Volume</span><strong>{dailyVolume} / day</strong></div>
            <div style={s.reviewRow}><span>Wholesale Price</span><strong>${centsToDollars(template.wholesalePriceCents)} / {isIpr ? 'call' : 'lead'}</strong></div>
            <div style={s.reviewRow}><span>Estimated Maximum Daily Spend</span><strong>${estimatedDailySpend.toFixed(2)}</strong></div>
            <div style={s.reviewRow}><span>Initial Account Deposit</span><strong>${centsToDollars(template.minimumDepositCents)}</strong></div>
          </div>
          <div style={s.helpText}>
            The ${centsToDollars(template.minimumDepositCents)} deposit is not a fee — it's added to your lead purchasing balance and used toward future leads. Actual lead volume can vary with real-time availability.
          </div>
        </div>
      )}

      {stepName === 'Fund Account' && (
        <div style={s.form}>
          {!fundingSatisfied ? (
            <>
              <div style={s.fundCard}>
                <div style={s.fundTitle}>FUND YOUR LEAD ACCOUNT</div>
                <div style={s.fundAmount}>${centsToDollars(template.minimumDepositCents)}</div>
                <div style={s.helpText}>Your deposit becomes your lead purchasing balance.</div>
                {paymentPageUrl ? (
                  <Button variant="primary" style={{ width: '100%', marginTop: 12 }} onClick={() => window.open(paymentPageUrl, '_blank', 'noopener')}>
                    FUND ACCOUNT — ${centsToDollars(template.minimumDepositCents)}
                  </Button>
                ) : (
                  <div style={s.notConfigured}>Payment isn't configured in this environment yet — your Super Admin needs to set the Boberdoo payment page URL before this can be completed.</div>
                )}
              </div>
              <Button variant="secondary" disabled={busy} onClick={confirmPayment}>{busy ? 'Checking…' : "I'VE COMPLETED PAYMENT"}</Button>
            </>
          ) : (
            <div style={s.successBox}>
              <Icon name="sparkle" size={28} style={{ color: 'var(--accent)' }} />
              <div style={s.successTitle}>{template.displayName} is live!</div>
              <div style={s.helpText}>Your lead program is active at {dailyVolume}/day.</div>
            </div>
          )}
        </div>
      )}

      {error && <div style={s.error}>{error}</div>}

      <div style={s.footer}>
        {stepIndex > 0 && stepName !== 'Fund Account' && <Button variant="secondary" onClick={goBack} disabled={busy}>BACK</Button>}
        <div style={{ flex: 1 }} />
        {stepName !== 'Fund Account' ? (
          <Button variant="primary" onClick={goNext} disabled={busy}>
            {busy ? 'Working…' : stepName === 'Review' ? 'START MY LEAD PROGRAM' : 'CONTINUE'}
          </Button>
        ) : fundingSatisfied ? (
          <Button variant="primary" onClick={() => { onDone(); onClose(); }}>DONE</Button>
        ) : null}
      </div>
    </Modal>
  );
}

const s = {
  stepper: { display: 'flex', gap: 4, marginBottom: 20, flexWrap: 'wrap' },
  stepperItem: { display: 'flex', alignItems: 'center', gap: 6 },
  stepDot: { width: 22, height: 22, borderRadius: '50%', display: 'flex', alignItems: 'center', justifyContent: 'center', fontSize: 10, fontWeight: 700, background: 'var(--bg-sunken)', border: '1px solid var(--border-strong)', color: 'var(--text-muted)' },
  stepDotActive: { background: 'var(--accent-gradient)', color: 'var(--accent-on)', border: 'none' },
  stepDotDone: { background: 'var(--surface-tint-lime)', border: '1px solid var(--accent)', color: 'var(--accent)' },
  stepLabel: { fontSize: 10, color: 'var(--text-muted)', marginRight: 10 },
  stepLabelActive: { fontSize: 10, color: 'var(--text-primary)', fontWeight: 700, marginRight: 10 },
  form: { display: 'flex', flexDirection: 'column', gap: 10 },
  helpText: { color: 'var(--text-muted)', fontSize: 12, lineHeight: 1.5, marginBottom: 4 },
  fieldLabel: { display: 'flex', flexDirection: 'column', gap: 4, fontSize: 11, color: 'var(--text-muted)' },
  input: { padding: '10px 12px', background: 'var(--bg-sunken)', border: '1px solid var(--border-strong)', borderRadius: 6, color: 'var(--text-primary)' },
  row3: { display: 'grid', gridTemplateColumns: '2fr 1fr 1fr', gap: 8 },
  volumeRow: { display: 'flex', alignItems: 'center', justifyContent: 'center', gap: 20, marginTop: 8 },
  volumeButton: { width: 40, height: 40, borderRadius: 8, background: 'var(--bg-sunken)', border: '1px solid var(--border-strong)', color: 'var(--text-primary)', fontSize: 20, cursor: 'pointer' },
  volumeValue: { fontFamily: 'var(--font-display)', fontSize: 22, fontWeight: 700, color: 'var(--text-primary)', minWidth: 140, textAlign: 'center' },
  volumeRange: { textAlign: 'center', color: 'var(--text-muted)', fontSize: 11 },
  estimate: { textAlign: 'center', color: 'var(--text-secondary)', fontSize: 13, marginTop: 8 },
  reviewCard: { background: 'var(--bg-sunken)', border: '1px solid var(--border-hairline)', borderRadius: 8, padding: 16, display: 'flex', flexDirection: 'column', gap: 8 },
  reviewTitle: { fontWeight: 700, fontSize: 15, color: 'var(--text-primary)', marginBottom: 6, display: 'flex', alignItems: 'center' },
  reviewRow: { display: 'flex', justifyContent: 'space-between', fontSize: 13, color: 'var(--text-secondary)' },
  fundCard: { background: 'var(--surface-tint-lime)', border: '1px solid var(--surface-tint-lime-border)', borderRadius: 8, padding: 20, textAlign: 'center' },
  fundTitle: { fontSize: 11, letterSpacing: 1.5, color: 'var(--text-muted)', fontWeight: 700 },
  fundAmount: { fontFamily: 'var(--font-display)', fontSize: 32, fontWeight: 700, color: 'var(--accent)', margin: '6px 0' },
  notConfigured: { color: 'var(--warning)', fontSize: 12, marginTop: 12, textAlign: 'left' },
  successBox: { textAlign: 'center', padding: '20px 0', display: 'flex', flexDirection: 'column', alignItems: 'center', gap: 8 },
  successTitle: { fontFamily: 'var(--font-display)', fontSize: 18, fontWeight: 700, color: 'var(--text-primary)' },
  error: { color: 'var(--danger)', fontSize: 12, marginTop: 10 },
  footer: { display: 'flex', alignItems: 'center', marginTop: 20, gap: 10 },
};
