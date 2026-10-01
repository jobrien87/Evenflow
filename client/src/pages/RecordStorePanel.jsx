import { useEffect, useState } from 'react';
import { api } from '../lib/api';
import { useAuth } from '../lib/AuthContext';
import { useIsMobile } from '../lib/useViewport';
import { Card, Badge, Button, StatTile, Icon, EmptyState } from '../ui';
import RecordStoreWizard from './RecordStoreWizard';

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
  const [volumeEdit, setVolumeEdit] = useState(null); // { subscription, value }
  const [confirmingPauseAll, setConfirmingPauseAll] = useState(false);
  const [confirmingResumeAll, setConfirmingResumeAll] = useState(false);
  const [busyId, setBusyId] = useState(null);
  const [status, setStatus] = useState('');

  useEffect(() => {
    load();
  }, []);

  async function load() {
    setLoadError('');
    try {
      const [templatesRes, subsRes, agenciesRes, balanceRes] = await Promise.all([
        api.recordStoreTemplates(),
        api.recordStoreSubscriptions(),
        api.agencies(),
        api.recordStoreBalance().catch(() => ({ balanceCents: null, lastUpdatedAt: null })),
      ]);
      setTemplates(templatesRes.templates);
      setSubscriptions(subsRes.subscriptions);
      setAgency(agenciesRes.agencies[0] || null);
      setBalance(balanceRes);
    } catch (err) {
      setLoadError(err.data?.message || 'Could not load the Record Store. Try refreshing.');
    } finally {
      setLoading(false);
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
            {balance?.paymentPageUrl && <Button variant="primary" size="sm" onClick={() => window.open(balance.paymentPageUrl, '_blank', 'noopener')}>ADD FUNDS</Button>}
          </div>
        </Card>
      </div>

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
                <Button variant="danger" size="sm" onClick={pauseAll}>CONFIRM PAUSE</Button>
                <Button variant="secondary" size="sm" onClick={() => setConfirmingPauseAll(false)}>CANCEL</Button>
              </div>
            </div>
          )}
          {confirmingResumeAll && (
            <div style={s.confirmBox}>
              This resumes your Record Store account. Programs you paused individually before will stay paused.
              <div style={s.confirmActions}>
                <Button variant="primary" size="sm" onClick={resumeAll}>CONFIRM RESUME</Button>
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
                  {sub.boberdooSyncError && <div style={s.syncError}>We couldn't update your lead program. Your current settings have not been changed. Our team has been notified.</div>}
                  {sub.errorMessage && sub.status === 'ERROR' && <div style={s.syncError}>Setup is still in progress — our team has been notified and will retry shortly.</div>}
                  <div style={s.programActions}>
                    {sub.status === 'ACTIVE' || sub.status === 'PAUSED' ? (
                      <Button variant="secondary" size="sm" disabled={busyId === sub.id || accountPaused} onClick={() => togglePause(sub)}>
                        {busyId === sub.id ? 'Working…' : sub.status === 'ACTIVE' ? 'PAUSE' : 'RESUME'}
                      </Button>
                    ) : null}
                    {(sub.status === 'ACTIVE' || sub.status === 'PAUSED') && (
                      <Button variant="secondary" size="sm" onClick={() => setVolumeEdit({ subscription: sub, value: sub.dailyVolume })}>CHANGE VOLUME</Button>
                    )}
                  </div>
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
            const unpriced = !t.wholesalePriceCents;
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
              <Button variant="primary" size="sm" disabled={busyId === volumeEdit.subscription.id} onClick={submitVolumeChange}>
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

const s = {
  wrap: {},
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
};
