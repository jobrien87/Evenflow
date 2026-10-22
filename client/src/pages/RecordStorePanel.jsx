import { useEffect, useState } from 'react';
import { api } from '../lib/api';
import { useAuth } from '../lib/AuthContext';
import { useIsMobile } from '../lib/useViewport';
import { Card, Badge, Button, StatTile, Icon, EmptyState } from '../ui';
import RecordStoreWizard from './RecordStoreWizard';
import RecordStoreCustomWizard from './RecordStoreCustomWizard';
import { RECORD_STORE_PREVIEW_MODE } from '../lib/recordStorePreview';

function customRequestStatus(r) {
  if (r.status === 'QUOTED') return { label: 'QUOTED — READY TO ACCEPT', tone: 'accent' };
  if (r.status === 'DECLINED') return { label: 'DECLINED', tone: 'danger' };
  if (r.status === 'CONVERTED') return { label: 'CONVERTED', tone: 'neutral' };
  return { label: 'PENDING REVIEW', tone: 'warning' };
}

function centsToDollars(cents) {
  if (cents === null || cents === undefined) return '—';
  return `$${(cents / 100).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
}

// Customer-facing status, never the raw internal enum (master spec §16/§29):
// LIVE / PAUSED / AWAITING DEPOSIT / SETUP REQUIRED / SYNC ISSUE.
function customerStatus(sub) {
  if (sub.boberdooSyncError) return { label: 'SYNC ISSUE', tone: 'warning' };
  if (sub.status === 'ACTIVE') return { label: 'LIVE', tone: 'accent' };
  if (sub.status === 'PAUSED' || sub.status === 'ACCOUNT_PAUSED') return { label: 'PAUSED', tone: 'neutral' };
  if (sub.status === 'PENDING_FUNDING') return { label: 'AWAITING DEPOSIT', tone: 'warning' };
  if (sub.status === 'ERROR') return { label: 'SETUP REQUIRED', tone: 'danger' };
  return { label: 'SETTING UP', tone: 'neutral' };
}

export default function RecordStorePanel() {
  const { user } = useAuth();
  const isMobile = useIsMobile();
  const [templates, setTemplates] = useState([]);
  const [subscriptions, setSubscriptions] = useState([]);
  const [agency, setAgency] = useState(null);
  const [balance, setBalance] = useState(null);
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState('');
  const [wizardTemplate, setWizardTemplate] = useState(null);
  const [customWizardOpen, setCustomWizardOpen] = useState(false);
  const [customRequests, setCustomRequests] = useState([]);
  const [fundingWizard, setFundingWizard] = useState(null); // { template, subscription } — resumes RecordStoreWizard at Fund Account
  const [acceptingRequestId, setAcceptingRequestId] = useState(null);
  const [volumeEdit, setVolumeEdit] = useState(null); // { subscription, value }
  const [fundingModal, setFundingModal] = useState(null); // { amount, busy }
  const [confirmingPauseAll, setConfirmingPauseAll] = useState(false);
  const [confirmingResumeAll, setConfirmingResumeAll] = useState(false);
  const [busyId, setBusyId] = useState(null);
  const [status, setStatus] = useState('');
  const [performanceSub, setPerformanceSub] = useState(null); // subscription whose performance modal is open
  const fundingResult = new URLSearchParams(window.location.search).get('funding');

  useEffect(() => {
    load();
    if (fundingResult === 'success') {
      // Give the webhook a moment to land, then pull a fresh balance.
      setTimeout(() => { api.recordStoreBalance().then(setBalance).catch(() => {}); }, 2000);
    }
  }, []);

  async function load() {
    setLoadError('');
    try {
      const [templatesRes, subsRes, agenciesRes, balanceRes, customRes] = await Promise.all([
        api.recordStoreTemplates(),
        api.recordStoreSubscriptions(),
        api.agencies(),
        api.recordStoreBalance().catch(() => ({ balanceCents: null, lastUpdatedAt: null })),
        api.myCustomRequests().catch(() => ({ requests: [] })),
      ]);
      setTemplates(templatesRes.templates);
      setSubscriptions(subsRes.subscriptions);
      setAgency(agenciesRes.agencies[0] || null);
      setBalance(balanceRes);
      setCustomRequests(customRes.requests);
    } catch (err) {
      setLoadError(err.data?.message || 'Could not load the Record Store. Try refreshing.');
    } finally {
      setLoading(false);
    }
  }

  async function acceptQuote(request) {
    setAcceptingRequestId(request.id);
    setStatus('');
    try {
      const customTemplate = templates.find((t) => t.isCustomBuilder);
      const acceptRes = await api.acceptCustomRequest(request.id);
      const provisionRes = await api.provisionRecordStoreOrder(acceptRes.subscription.id);
      setFundingWizard({ template: customTemplate, subscription: provisionRes.subscription });
      await load();
    } catch (err) {
      setStatus(err.data?.message || 'Could not accept this quote. Please try again.');
    } finally {
      setAcceptingRequestId(null);
    }
  }

  async function refreshBalance() {
    setStatus('Refreshing balance…');
    try {
      const res = await api.recordStoreBalance();
      setBalance(res);
      setStatus('');
    } catch (err) {
      setStatus(err.data?.message || 'Could not refresh balance.');
    }
  }

  async function togglePause(sub) {
    setBusyId(sub.id);
    try {
      const res = sub.status === 'ACTIVE' ? await api.pauseRecordStoreSubscription(sub.id) : await api.resumeRecordStoreSubscription(sub.id);
      setSubscriptions((prev) => prev.map((s) => (s.id === sub.id ? res.subscription : s)));
    } catch (err) {
      setStatus(err.data?.message || 'Could not update this program.');
    } finally {
      setBusyId(null);
    }
  }

  async function submitVolumeChange() {
    setBusyId(volumeEdit.subscription.id);
    try {
      const res = await api.changeRecordStoreVolume(volumeEdit.subscription.id, volumeEdit.value);
      setSubscriptions((prev) => prev.map((s) => (s.id === res.subscription.id ? res.subscription : s)));
      setVolumeEdit(null);
    } catch (err) {
      setStatus(err.data?.message || 'Could not change daily volume.');
    } finally {
      setBusyId(null);
    }
  }

  async function startAccountFundingCheckout() {
    const dollars = Number(fundingModal.amount);
    if (!dollars || dollars <= 0) {
      setFundingModal({ ...fundingModal, error: 'Enter a valid amount.' });
      return;
    }
    setFundingModal({ ...fundingModal, busy: true, error: '' });
    try {
      const res = await api.createRecordStoreAccountFundingCheckout(Math.round(dollars * 100));
      window.location.href = res.url;
    } catch (err) {
      setFundingModal({ ...fundingModal, busy: false, error: err.data?.message || 'Could not start your payment.' });
    }
  }

  async function pauseAll() {
    setConfirmingPauseAll(false);
    setStatus('Pausing all lead products…');
    try {
      await api.pauseRecordStoreAccount();
      await load();
      setStatus('');
    } catch (err) {
      setStatus(err.data?.message || 'Could not pause your account.');
    }
  }

  async function resumeAll() {
    setConfirmingResumeAll(false);
    setStatus('Resuming your account…');
    try {
      await api.resumeRecordStoreAccount();
      await load();
      setStatus('');
    } catch (err) {
      setStatus(err.data?.message || 'Could not resume your account.');
    }
  }

  if (loading) return <div style={s.wrap}>Loading…</div>;

  if (loadError) {
    return (
      <div style={s.wrap}>
        <div style={s.loadErrorBox}>
          {loadError}
          <Button variant="secondary" size="sm" onClick={load}>RETRY</Button>
        </div>
      </div>
    );
  }

  const ownedTemplateIds = new Set(subscriptions.map((s) => s.recordStoreTemplateId));
  const accountPaused = agency?.boberdooPartnerStatus === 1;
  const hasPrograms = subscriptions.length > 0;

  return (
    <div style={s.wrap}>
      {RECORD_STORE_PREVIEW_MODE && (
        <div style={s.previewBanner}>COMING SOON — THIS IS A PREVIEW. NOTHING BELOW IS LIVE YET.</div>
      )}

      <div style={s.hero}>
        <div>
          <h1 style={s.title}>THE RECORD STORE</h1>
          <p style={s.subtitle}>Real leads. Real time. Wholesale pricing.</p>
        </div>
        <Card style={s.balanceCard}>
          <div style={s.balanceLabel}>LEAD BALANCE</div>
          <div style={s.balanceValue}>{centsToDollars(balance?.balanceCents)}</div>
          <div style={s.balanceUpdated}>{balance?.lastUpdatedAt ? `Updated ${new Date(balance.lastUpdatedAt).toLocaleString()}` : balance?.noPartnerYet ? 'No account yet' : 'Not yet checked'}</div>
          <div style={s.balanceActions}>
            <Button variant="secondary" size="sm" onClick={refreshBalance}><Icon name="refresh" size={13} style={{ marginRight: 4 }} />REFRESH</Button>
            <Button variant="primary" size="sm" onClick={() => setFundingModal({ amount: '', busy: false, error: '' })}>ADD FUNDS</Button>
          </div>
        </Card>
      </div>

      {fundingResult === 'success' && <div style={s.status}>Payment received — crediting your lead balance now. It may take a few seconds to show above.</div>}
      {fundingResult === 'canceled' && <div style={s.status}>Checkout was canceled — no charge was made.</div>}
      {status && <div style={s.status}>{status}</div>}

      {hasPrograms && (
        <section style={s.section}>
          <div style={s.sectionHeaderRow}>
            <div style={s.sectionTitle}>MY LEAD PROGRAMS</div>
            {accountPaused ? (
              <Button variant="secondary" size="sm" onClick={() => setConfirmingResumeAll(true)}>RESUME ALL LEADS</Button>
            ) : (
              <Button variant="danger" size="sm" onClick={() => setConfirmingPauseAll(true)}>PAUSE ALL LEADS</Button>
            )}
          </div>

          {confirmingPauseAll && (
            <div style={s.confirmBox}>
              This pauses all lead products connected to your Record Store account. You can resume them at any time.
              <div style={s.confirmActions}>
                <Button variant="danger" size="sm" disabled={RECORD_STORE_PREVIEW_MODE} onClick={pauseAll}>CONFIRM PAUSE</Button>
                <Button variant="secondary" size="sm" onClick={() => setConfirmingPauseAll(false)}>CANCEL</Button>
              </div>
            </div>
          )}
          {confirmingResumeAll && (
            <div style={s.confirmBox}>
              This resumes your Record Store account. Programs you paused individually before will stay paused.
              <div style={s.confirmActions}>
                <Button variant="primary" size="sm" disabled={RECORD_STORE_PREVIEW_MODE} onClick={resumeAll}>CONFIRM RESUME</Button>
                <Button variant="secondary" size="sm" onClick={() => setConfirmingResumeAll(false)}>CANCEL</Button>
              </div>
            </div>
          )}

          <div style={s.programsGrid}>
            {subscriptions.map((sub) => {
              const cs = customerStatus(sub);
              return (
                <Card key={sub.id} style={s.programCard}>
                  <div style={s.programHeaderRow}>
                    <div style={s.programName}>{sub.productNameSnapshot}</div>
                    <Badge tone={cs.tone}>{cs.label}</Badge>
                  </div>
                  <div style={s.programStatsRow}>
                    <StatTile label="Daily Volume" value={`${sub.dailyVolume}/day`} tone="grey" />
                    <StatTile label="Price" value={centsToDollars(sub.priceSnapshotCents)} tone="grey" />
                  </div>
                  {sub.acceptedSourceLabels?.length > 0 && (
                    <div style={s.productMeta}>Sources: {sub.acceptedSourceLabels.join(', ')}</div>
                  )}
                  {sub.boberdooSyncError && <div style={s.syncError}>We couldn't update your lead program. Your current settings have not been changed. Our team has been notified.</div>}
                  {sub.errorMessage && sub.status === 'ERROR' && <div style={s.syncError}>Setup is still in progress — our team has been notified and will retry shortly.</div>}
                  <div style={s.programActions}>
                    {sub.status === 'ACTIVE' || sub.status === 'PAUSED' ? (
                      <Button variant="secondary" size="sm" disabled={busyId === sub.id || accountPaused || RECORD_STORE_PREVIEW_MODE} onClick={() => togglePause(sub)}>
                        {busyId === sub.id ? 'Working…' : sub.status === 'ACTIVE' ? 'PAUSE' : 'RESUME'}
                      </Button>
                    ) : null}
                    {(sub.status === 'ACTIVE' || sub.status === 'PAUSED') && (
                      <Button variant="secondary" size="sm" onClick={() => setVolumeEdit({ subscription: sub, value: sub.dailyVolume })}>CHANGE VOLUME</Button>
                    )}
                    {(sub.status === 'ACTIVE' || sub.status === 'PAUSED') && (
                      <Button variant="secondary" size="sm" onClick={() => setPerformanceSub(sub)}>SOURCE PERFORMANCE</Button>
                    )}
                  </div>
                </Card>
              );
            })}
          </div>
        </section>
      )}

      {performanceSub && (
        <SourcePerformanceModal subscription={performanceSub} onClose={() => setPerformanceSub(null)} onToggled={(updated) => setSubscriptions((prev) => prev.map((s) => (s.id === updated.id ? { ...s, autoOptimizeSources: updated.autoOptimizeSources } : s)))} />
      )}

      {customRequests.length > 0 && (
        <section style={s.section}>
          <div style={s.sectionTitle}>MY CUSTOM REQUESTS</div>
          <div style={s.programsGrid}>
            {customRequests.map((r) => {
              const cs = customRequestStatus(r);
              return (
                <Card key={r.id} style={s.programCard}>
                  <div style={s.programHeaderRow}>
                    <div style={s.programName}>{r.leadTypeLabel} (Custom)</div>
                    <Badge tone={cs.tone}>{cs.label}</Badge>
                  </div>
                  <div style={s.productMeta}>Sources: {(r.sourceLabels || []).join(', ') || '—'}</div>
                  <div style={s.productMeta}>Daily cap: {r.dailyLimit || '—'}/day</div>
                  {r.status === 'QUOTED' && (
                    <>
                      <div style={s.productPrice}>{centsToDollars(r.quotedPriceCents)} / lead</div>
                      {r.decisionNotes && <div style={s.helpText}>{r.decisionNotes}</div>}
                      <Button
                        variant="primary"
                        style={{ width: '100%', marginTop: 10 }}
                        disabled={acceptingRequestId === r.id || RECORD_STORE_PREVIEW_MODE}
                        onClick={() => acceptQuote(r)}
                      >
                        {acceptingRequestId === r.id ? 'Setting up…' : 'ACCEPT QUOTE & FUND'}
                      </Button>
                    </>
                  )}
                  {r.status === 'DECLINED' && r.decisionNotes && <div style={s.syncError}>{r.decisionNotes}</div>}
                </Card>
              );
            })}
          </div>
        </section>
      )}

      <section style={s.section}>
        <div style={s.sectionTitle}>{hasPrograms ? 'BROWSE MORE PRODUCTS' : 'SHOP'}</div>
        <div style={isMobile ? s.productsGridMobile : s.productsGrid}>
          {templates.map((t) => {
            const owned = ownedTemplateIds.has(t.id);
            // CUSTOM_BUILDER is always unpriced by design (per-order manual
            // quote, not a fixed catalog price) — never disabled for that
            // reason the way a not-yet-configured fixed template is.
            const unpriced = !t.isCustomBuilder && !t.wholesalePriceCents;
            if (t.isCustomBuilder) {
              return (
                <Card key={t.id} style={s.productCard}>
                  <div style={s.productHeaderRow}>
                    <Icon name="sparkle" size={22} style={{ color: 'var(--accent)' }} />
                  </div>
                  <div style={s.productName}>{t.displayName}</div>
                  <div style={s.productCategory}>CUSTOM</div>
                  <div style={s.productDescription}>{t.description}</div>
                  <div style={s.productMeta}>We quote it, you approve it — no fixed price.</div>
                  <Button variant="primary" style={{ width: '100%', marginTop: 10 }} onClick={() => setCustomWizardOpen(true)}>REQUEST A QUOTE</Button>
                </Card>
              );
            }
            return (
              <Card key={t.id} style={t.isIpr ? { ...s.productCard, ...s.productCardLive } : s.productCard}>
                <div style={s.productHeaderRow}>
                  <Icon name={t.isIpr ? 'phone' : t.productCategory === 'AUTO' ? 'car' : 'home'} size={22} style={{ color: 'var(--accent)' }} />
                  {t.slug.includes('PREFERRED') && <Badge tone="accent">PREFERRED</Badge>}
                  {t.isIpr && <Badge tone="accent">LIVE CALL</Badge>}
                </div>
                <div style={s.productName}>{t.displayName}</div>
                <div style={s.productCategory}>{t.productCategory} · {t.isIpr ? 'Live phone transfer' : 'Real-time internet lead'}</div>
                <div style={s.productDescription}>{t.description}</div>
                <div style={s.productPrice}>{unpriced ? 'Coming soon' : `${centsToDollars(t.wholesalePriceCents)} / ${t.isIpr ? 'call' : 'lead'}`}</div>
                <div style={s.productMeta}>Min volume: {t.minimumDailyVolume}/day</div>
                <Button
                  variant={owned ? 'secondary' : 'primary'}
                  style={{ width: '100%', marginTop: 10 }}
                  disabled={unpriced}
                  onClick={() => setWizardTemplate(t)}
                >
                  {unpriced ? 'NOT YET AVAILABLE' : owned ? 'BUY ANOTHER / MANAGE' : 'SELECT'}
                </Button>
              </Card>
            );
          })}
        </div>
        {templates.length === 0 && <EmptyState title="No products yet" description="Your Super Admin hasn't configured any Record Store products." />}
      </section>

      {wizardTemplate && agency && (
        <RecordStoreWizard
          template={wizardTemplate}
          agency={agency}
          user={user}
          onClose={() => setWizardTemplate(null)}
          onDone={load}
        />
      )}

      {customWizardOpen && (
        <RecordStoreCustomWizard
          onClose={() => setCustomWizardOpen(false)}
          onSubmitted={load}
        />
      )}

      {fundingWizard && agency && (
        <RecordStoreWizard
          template={fundingWizard.template}
          agency={agency}
          user={user}
          initialSubscription={fundingWizard.subscription}
          onClose={() => setFundingWizard(null)}
          onDone={load}
        />
      )}

      {fundingModal && (
        <div style={s.volumeModalBackdrop} onClick={() => (fundingModal.busy ? null : setFundingModal(null))}>
          <Card style={s.volumeModal} onClick={(e) => e.stopPropagation()}>
            <div style={s.sectionTitle}>ADD FUNDS</div>
            <div style={s.helpText}>Amount added to your lead purchasing balance — charged via card, deposited straight to your account.</div>
            <input
              style={s.input}
              type="number"
              min="1"
              step="0.01"
              placeholder="e.g. 500.00"
              value={fundingModal.amount}
              onChange={(e) => setFundingModal({ ...fundingModal, amount: e.target.value })}
              autoFocus
            />
            {fundingModal.error && <div style={s.syncError}>{fundingModal.error}</div>}
            <div style={s.confirmActions}>
              <Button variant="primary" size="sm" disabled={fundingModal.busy || RECORD_STORE_PREVIEW_MODE} onClick={startAccountFundingCheckout}>
                {fundingModal.busy ? 'Starting checkout…' : 'CONTINUE TO PAYMENT'}
              </Button>
              <Button variant="secondary" size="sm" disabled={fundingModal.busy} onClick={() => setFundingModal(null)}>CANCEL</Button>
            </div>
          </Card>
        </div>
      )}

      {volumeEdit && (
        <div style={s.volumeModalBackdrop} onClick={() => setVolumeEdit(null)}>
          <Card style={s.volumeModal} onClick={(e) => e.stopPropagation()}>
            <div style={s.sectionTitle}>CHANGE DAILY VOLUME</div>
            <div style={s.helpText}>Current: {volumeEdit.subscription.dailyVolume}/day</div>
            <input
              style={s.input}
              type="number"
              value={volumeEdit.value}
              onChange={(e) => setVolumeEdit({ ...volumeEdit, value: Number(e.target.value) })}
            />
            <div style={s.helpText}>
              Estimated daily spend: ${(((volumeEdit.subscription.priceSnapshotCents || 0) * volumeEdit.value) / 100).toFixed(2)}
            </div>
            <div style={s.confirmActions}>
              <Button variant="primary" size="sm" disabled={busyId === volumeEdit.subscription.id || RECORD_STORE_PREVIEW_MODE} onClick={submitVolumeChange}>
                {busyId === volumeEdit.subscription.id ? 'Saving…' : 'CONFIRM'}
              </Button>
              <Button variant="secondary" size="sm" onClick={() => setVolumeEdit(null)}>CANCEL</Button>
            </div>
          </Card>
        </div>
      )}
    </div>
  );
}

function centsToDisplay(cents) {
  if (cents === null || cents === undefined) return '—';
  return `$${(cents / 100).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
}

// Real per-source performance for one lead program, plus the automatic
// 30-day optimizer's own on/off switch and recent decision history — so
// "EvenFlow is optimizing your leads" is something an agency can read
// back for itself, not just a marketing line.
function SourcePerformanceModal({ subscription, onClose, onToggled }) {
  const [data, setData] = useState(null);
  const [error, setError] = useState('');
  const [toggling, setToggling] = useState(false);
  const [autoOptimize, setAutoOptimize] = useState(subscription.autoOptimizeSources);

  useEffect(() => {
    api.recordStoreSourcePerformance(subscription.id)
      .then((res) => { setData(res); setAutoOptimize(res.autoOptimizeSources); })
      .catch((err) => setError(err.data?.message || 'Could not load source performance.'));
  }, [subscription.id]);

  async function toggleAutoOptimize() {
    setToggling(true);
    try {
      const res = await api.setRecordStoreAutoOptimize(subscription.id, !autoOptimize);
      setAutoOptimize(res.subscription.autoOptimizeSources);
      onToggled(res.subscription);
    } catch {
      setError('Could not save that setting.');
    } finally {
      setToggling(false);
    }
  }

  return (
    <div style={s.volumeModalBackdrop} onClick={onClose}>
      <Card style={{ ...s.volumeModal, maxWidth: 640 }} onClick={(e) => e.stopPropagation()}>
        <div style={s.sectionTitle}>SOURCE PERFORMANCE — {subscription.productNameSnapshot}</div>
        <div style={s.helpText}>
          EvenFlow tracks every source's real quote rate, close rate, and revenue, and automatically drops any source that's underperforming once there's enough data — about every 30 days.
        </div>

        <label style={s.autoOptimizeRow}>
          <input type="checkbox" checked={!!autoOptimize} disabled={toggling} onChange={toggleAutoOptimize} />
          Automatically optimize this program's sources
        </label>

        {error && <div style={s.error}>{error}</div>}
        {!data && !error && <div style={s.helpText}>Loading…</div>}

        {data && (
          <>
            <div style={s.perfTableHeader}>
              <span>SOURCE</span><span>LEADS</span><span>QUOTE RATE</span><span>CLOSE RATE</span><span>SPEND</span><span>REVENUE</span>
            </div>
            {data.performance.perSource.length === 0 ? (
              <div style={s.helpText}>No leads delivered in the last 30 days yet.</div>
            ) : (
              data.performance.perSource.map((row) => (
                <div key={row.sourceCode} style={s.perfTableRow}>
                  <span>{row.label}{!row.hasMinimumSample && <span style={s.lowSampleTag}> (low sample)</span>}</span>
                  <span>{row.leadCount}</span>
                  <span>{row.quoteRate ?? '—'}%</span>
                  <span>{row.closeRate ?? '—'}%</span>
                  <span>{centsToDisplay(row.costCents)}</span>
                  <span>{centsToDisplay(row.revenueCents)}</span>
                </div>
              ))
            )}

            {data.history.length > 0 && (
              <>
                <div style={{ ...s.sectionTitle, fontSize: 12, marginTop: 16 }}>RECENT OPTIMIZATION HISTORY</div>
                {data.history.map((h) => (
                  <div key={h.id} style={s.historyRow}>
                    <div style={s.historyDate}>{new Date(h.createdAt).toLocaleDateString()} · {h.status.replace(/_/g, ' ')}</div>
                    <div>{h.reasoning}</div>
                  </div>
                ))}
              </>
            )}
          </>
        )}

        <div style={s.confirmActions}>
          <Button variant="secondary" size="sm" onClick={onClose}>CLOSE</Button>
        </div>
      </Card>
    </div>
  );
}

const s = {
  wrap: {},
  previewBanner: {
    background: 'var(--danger)', color: 'var(--text-primary)', padding: '10px 20px', borderRadius: 8,
    fontSize: 13, fontWeight: 700, letterSpacing: 0.5, textAlign: 'center', marginBottom: 'var(--space-6)',
  },
  loadErrorBox: { background: 'var(--danger-soft)', border: '1px solid rgba(255, 77, 94, 0.4)', color: 'var(--danger)', padding: 16, borderRadius: 8, fontSize: 13, display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 12 },
  hero: { display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start', gap: 24, marginBottom: 'var(--space-6)', flexWrap: 'wrap' },
  title: { fontFamily: 'var(--font-display)', fontSize: 'var(--text-display-lg)', fontWeight: 700, color: 'var(--text-primary)', margin: '0 0 6px', letterSpacing: 1 },
  subtitle: { color: 'var(--text-secondary)', fontSize: 14, margin: 0 },
  balanceCard: { minWidth: 220 },
  balanceLabel: { fontSize: 10, letterSpacing: 1.5, color: 'var(--text-muted)', fontWeight: 700 },
  balanceValue: { fontFamily: 'var(--font-display)', fontSize: 30, fontWeight: 700, backgroundImage: 'var(--accent-gradient)', WebkitBackgroundClip: 'text', backgroundClip: 'text', color: 'transparent', margin: '4px 0' },
  balanceUpdated: { fontSize: 10, color: 'var(--text-muted)', marginBottom: 10 },
  balanceActions: { display: 'flex', gap: 8 },
  status: { color: 'var(--accent)', marginBottom: 16, fontSize: 13 },
  section: { marginBottom: 'var(--space-8)' },
  sectionHeaderRow: { display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 14, flexWrap: 'wrap', gap: 10 },
  sectionTitle: { fontSize: 12, fontWeight: 700, letterSpacing: 1.5, color: 'var(--text-secondary)', marginBottom: 14 },
  confirmBox: { background: 'var(--danger-soft)', border: '1px solid rgba(255, 77, 94, 0.4)', borderRadius: 8, padding: 14, fontSize: 12, color: 'var(--text-secondary)', marginBottom: 14 },
  confirmActions: { display: 'flex', gap: 8, marginTop: 10 },
  programsGrid: { display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(260px, 1fr))', gap: 16 },
  programCard: {},
  programHeaderRow: { display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 12 },
  programName: { fontWeight: 700, fontSize: 14, color: 'var(--text-primary)' },
  programStatsRow: { display: 'flex', gap: 10, marginBottom: 10 },
  syncError: { color: 'var(--warning)', fontSize: 11, marginBottom: 10, lineHeight: 1.4 },
  programActions: { display: 'flex', gap: 8, flexWrap: 'wrap' },
  productsGrid: { display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(230px, 1fr))', gap: 16 },
  productsGridMobile: { display: 'flex', flexDirection: 'column', gap: 16 },
  productCard: { display: 'flex', flexDirection: 'column' },
  productCardLive: { borderColor: 'var(--accent)' },
  productHeaderRow: { display: 'flex', alignItems: 'center', gap: 8, marginBottom: 10 },
  productName: { fontFamily: 'var(--font-display)', fontSize: 16, fontWeight: 700, color: 'var(--text-primary)' },
  productCategory: { color: 'var(--text-muted)', fontSize: 10, letterSpacing: 0.5, marginTop: 2, marginBottom: 8, textTransform: 'uppercase' },
  productDescription: { color: 'var(--text-secondary)', fontSize: 12, lineHeight: 1.5, marginBottom: 12, flex: 1 },
  productPrice: { fontFamily: 'var(--font-display)', fontSize: 18, fontWeight: 700, color: 'var(--accent)' },
  productMeta: { color: 'var(--text-muted)', fontSize: 11, marginTop: 2 },
  volumeModalBackdrop: { position: 'fixed', inset: 0, background: 'rgba(6,7,9,0.6)', display: 'flex', alignItems: 'center', justifyContent: 'center', zIndex: 'var(--z-modal)', padding: 20 },
  volumeModal: { maxWidth: 360, width: '100%', display: 'flex', flexDirection: 'column', gap: 10 },
  input: { padding: '10px 12px', background: 'var(--bg-sunken)', border: '1px solid var(--border-strong)', borderRadius: 6, color: 'var(--text-primary)' },
  helpText: { color: 'var(--text-muted)', fontSize: 12 },
  error: { color: 'var(--danger)', fontSize: 12 },
  autoOptimizeRow: { display: 'flex', alignItems: 'center', gap: 8, fontSize: 12, color: 'var(--text-primary)', padding: '8px 0' },
  perfTableHeader: { display: 'grid', gridTemplateColumns: '1.5fr 0.8fr 1fr 1fr 1fr 1fr', fontSize: 10, letterSpacing: 0.5, color: 'var(--text-muted)', fontWeight: 700, padding: '6px 0', borderBottom: '1px solid var(--border-hairline)' },
  perfTableRow: { display: 'grid', gridTemplateColumns: '1.5fr 0.8fr 1fr 1fr 1fr 1fr', fontSize: 12, color: 'var(--text-primary)', padding: '6px 0', borderBottom: '1px solid var(--border-hairline)', alignItems: 'center' },
  lowSampleTag: { color: 'var(--text-muted)', fontStyle: 'italic', fontSize: 10 },
  historyRow: { fontSize: 11, color: 'var(--text-secondary)', padding: '6px 0', borderBottom: '1px solid var(--border-hairline)' },
  historyDate: { color: 'var(--text-muted)', fontSize: 10, marginBottom: 2 },
};
