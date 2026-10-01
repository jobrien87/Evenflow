import { useEffect, useState } from 'react';
import { api } from '../lib/api';
import { Card, Badge, Button, StatTile, SectionHeader, EmptyState } from '../ui';

function centsToDollars(cents) {
  if (cents === null || cents === undefined) return '—';
  return `$${(cents / 100).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
}

const PARTNER_STATUS_LABEL = { 0: 'Not Active', 1: 'Temporarily Stopped', 2: 'Active' };

export default function RecordStoreAdminPanel() {
  const [agencies, setAgencies] = useState([]);
  const [templates, setTemplates] = useState([]);
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState('');
  const [expandedId, setExpandedId] = useState(null);
  const [editingTemplate, setEditingTemplate] = useState(null);
  const [linkForm, setLinkForm] = useState(null); // { agencyId, partnerId }
  const [status, setStatus] = useState('');
  const [busyId, setBusyId] = useState(null);

  useEffect(() => {
    load();
  }, []);

  async function load() {
    setLoadError('');
    try {
      const [customersRes, templatesRes] = await Promise.all([
        api.adminRecordStoreCustomers(),
        api.adminRecordStoreTemplates(),
      ]);
      setAgencies(customersRes.agencies);
      setTemplates(templatesRes.templates);
    } catch (err) {
      setLoadError(err.data?.message || 'Could not load Record Store admin data.');
    } finally {
      setLoading(false);
    }
  }

  async function syncAgency(agencyId) {
    setBusyId(agencyId);
    try {
      await api.syncRecordStoreAgency(agencyId);
      await load();
    } catch (err) {
      setStatus(err.data?.message || 'Sync failed.');
    } finally {
      setBusyId(null);
    }
  }

  async function pauseAgencyAccount(agencyId) {
    setBusyId(agencyId);
    try {
      await api.adminPauseRecordStoreAccount(agencyId);
      await load();
    } catch (err) {
      setStatus(err.data?.message || 'Could not pause this account.');
    } finally {
      setBusyId(null);
    }
  }

  async function resumeAgencyAccount(agencyId) {
    setBusyId(agencyId);
    try {
      await api.adminResumeRecordStoreAccount(agencyId);
      await load();
    } catch (err) {
      setStatus(err.data?.message || 'Could not resume this account.');
    } finally {
      setBusyId(null);
    }
  }

  async function retrySubscription(subscriptionId) {
    setBusyId(subscriptionId);
    try {
      await api.retryRecordStoreProvisioning(subscriptionId);
      await load();
    } catch (err) {
      setStatus(err.data?.message || 'Retry failed.');
    } finally {
      setBusyId(null);
    }
  }

  async function submitLink() {
    setBusyId(linkForm.agencyId);
    try {
      await api.linkBoberdooPartner(linkForm.agencyId, linkForm.partnerId);
      setLinkForm(null);
      await load();
    } catch (err) {
      setStatus(err.data?.message || 'Could not link that Partner ID.');
    } finally {
      setBusyId(null);
    }
  }

  async function saveTemplate(patch) {
    setBusyId(editingTemplate.id);
    try {
      const res = await api.updateRecordStoreTemplate(editingTemplate.id, patch);
      setTemplates((prev) => prev.map((t) => (t.id === res.template.id ? res.template : t)));
      setEditingTemplate(null);
    } catch (err) {
      setStatus(err.data?.message || 'Could not save that template.');
    } finally {
      setBusyId(null);
    }
  }

  if (loading) return <div>Loading…</div>;
  if (loadError) {
    return (
      <div>
        <div style={s.loadErrorBox}>{loadError}<Button variant="secondary" size="sm" onClick={load}>RETRY</Button></div>
      </div>
    );
  }

  const allSubs = agencies.flatMap((a) => a.recordStoreSubscriptions);
  const metrics = {
    totalAgencies: agencies.length,
    activeBuyers: agencies.filter((a) => a.recordStoreSubscriptions.some((s) => s.status === 'ACTIVE')).length,
    pausedBuyers: agencies.filter((a) => a.boberdooPartnerStatus === 1).length,
    pendingFunding: allSubs.filter((s) => s.status === 'PENDING_FUNDING').length,
    errors: allSubs.filter((s) => s.status === 'ERROR').length,
    activeFilterSets: allSubs.filter((s) => s.status === 'ACTIVE').length,
    volumeRequested: allSubs.reduce((sum, s) => sum + (s.dailyVolume || 0), 0),
    syncErrors: agencies.filter((a) => a.boberdooSyncStatus === 'ERROR').length,
  };

  return (
    <div>
      <SectionHeader>RECORD STORE CONTROL CENTER</SectionHeader>

      <div style={s.statsRow}>
        <StatTile label="Record Store Agencies" value={metrics.totalAgencies} />
        <StatTile label="Active Buyers" value={metrics.activeBuyers} tone="lime" />
        <StatTile label="Paused Buyers" value={metrics.pausedBuyers} />
        <StatTile label="Pending Funding" value={metrics.pendingFunding} tone={metrics.pendingFunding > 0 ? 'danger' : 'grey'} />
        <StatTile label="Errors" value={metrics.errors} tone={metrics.errors > 0 ? 'danger' : 'grey'} />
        <StatTile label="Active Filter Sets" value={metrics.activeFilterSets} />
        <StatTile label="Volume Requested/day" value={metrics.volumeRequested} />
        <StatTile label="Sync Errors" value={metrics.syncErrors} tone={metrics.syncErrors > 0 ? 'danger' : 'grey'} />
      </div>

      {status && <div style={s.status}>{status}<Button variant="ghost" size="sm" onClick={() => setStatus('')} style={{ marginLeft: 10 }}>DISMISS</Button></div>}

      <section style={s.section}>
        <SectionHeader>CUSTOMERS</SectionHeader>
        {agencies.length === 0 ? (
          <EmptyState title="No Record Store customers yet" description="Agencies that buy a product will show up here." />
        ) : (
          <Card style={s.tableCard}>
            <div style={s.tableHeaderRow}>
              <span style={s.colAgency}>AGENCY / OWNER</span>
              <span style={s.col}>PARTNER</span>
              <span style={s.col}>PRODUCTS</span>
              <span style={s.col}>VOLUME</span>
              <span style={s.col}>BALANCE</span>
              <span style={s.col}>STATUS</span>
              <span style={s.colActions}>ACTIONS</span>
            </div>
            {agencies.map((a) => {
              const owner = a.users[0];
              const totalVolume = a.recordStoreSubscriptions.reduce((sum, s) => sum + (s.dailyVolume || 0), 0);
              const hasErrors = a.recordStoreSubscriptions.some((s) => s.status === 'ERROR');
              return (
                <div key={a.id}>
                  <div style={s.tableRow}>
                    <span style={s.colAgency}>
                      <div style={s.agencyName}>{a.name}</div>
                      <div style={s.ownerLine}>{owner ? `${owner.firstName} ${owner.lastName} · ${owner.email}` : '—'}</div>
                    </span>
                    <span style={s.col}>{a.boberdooPartnerId || '—'}<div style={s.subLine}>{PARTNER_STATUS_LABEL[a.boberdooPartnerStatus] ?? '—'}</div></span>
                    <span style={s.col}>{a.recordStoreSubscriptions.length}</span>
                    <span style={s.col}>{totalVolume}/day</span>
                    <span style={s.col}>{centsToDollars(a.recordStoreBalanceCents)}</span>
                    <span style={s.col}>
                      {a.boberdooSyncStatus === 'ERROR' && <Badge tone="danger">SYNC ERROR</Badge>}
                      {hasErrors && <Badge tone="danger" style={{ marginLeft: 4 }}>PROVISIONING ERROR</Badge>}
                      {!hasErrors && a.boberdooSyncStatus !== 'ERROR' && <Badge tone="accent">OK</Badge>}
                    </span>
                    <span style={s.colActions}>
                      <Button variant="ghost" size="sm" onClick={() => setExpandedId(expandedId === a.id ? null : a.id)}>VIEW</Button>
                      <Button variant="ghost" size="sm" disabled={busyId === a.id} onClick={() => syncAgency(a.id)}>SYNC</Button>
                      {a.boberdooPartnerStatus === 1 ? (
                        <Button variant="ghost" size="sm" disabled={busyId === a.id} onClick={() => resumeAgencyAccount(a.id)}>RESUME</Button>
                      ) : (
                        <Button variant="ghost" size="sm" disabled={busyId === a.id} onClick={() => pauseAgencyAccount(a.id)}>PAUSE</Button>
                      )}
                    </span>
                  </div>
                  {expandedId === a.id && (
                    <div style={s.expandedBox}>
                      <div style={s.debugTitle}>ADVANCED / DEBUG VIEW</div>
                      <div style={s.debugRow}>Boberdoo Partner ID: {a.boberdooPartnerId || 'none yet'}</div>
                      <div style={s.debugRow}>Sync error: {a.boberdooSyncError || 'none'}</div>
                      <div style={s.debugRow}>Last sync: {a.boberdooLastSyncAt ? new Date(a.boberdooLastSyncAt).toLocaleString() : 'never'}</div>
                      {a.recordStoreSubscriptions.map((sub) => (
                        <div key={sub.id} style={s.subRow}>
                          <span>{sub.productNameSnapshot} — {sub.status} — Filter Set: {sub.boberdooFilterSetId || 'none yet'}</span>
                          {sub.status === 'ERROR' && (
                            <Button variant="secondary" size="sm" disabled={busyId === sub.id} onClick={() => retrySubscription(sub.id)}>RETRY PROVISIONING</Button>
                          )}
                        </div>
                      ))}
                      {!a.boberdooPartnerId && (
                        linkForm?.agencyId === a.id ? (
                          <div style={s.linkRow}>
                            <input style={s.input} placeholder="Existing Boberdoo Partner ID" value={linkForm.partnerId} onChange={(e) => setLinkForm({ ...linkForm, partnerId: e.target.value })} />
                            <Button variant="primary" size="sm" disabled={busyId === a.id} onClick={submitLink}>LINK</Button>
                            <Button variant="secondary" size="sm" onClick={() => setLinkForm(null)}>CANCEL</Button>
                          </div>
                        ) : (
                          <Button variant="secondary" size="sm" onClick={() => setLinkForm({ agencyId: a.id, partnerId: '' })}>LINK EXISTING BOBERDOO PARTNER</Button>
                        )
                      )}
                    </div>
                  )}
                </div>
              );
            })}
          </Card>
        )}
      </section>

      <section style={s.section}>
        <SectionHeader>PRODUCT TEMPLATES</SectionHeader>
        <Card style={s.tableCard}>
          <div style={s.templateHeaderRow}>
            <span style={s.colAgency}>PRODUCT</span>
            <span style={s.col}>PRICE</span>
            <span style={s.col}>VOLUME RANGE</span>
            <span style={s.col}>DEPOSIT</span>
            <span style={s.col}>BOBERDOO TYPE</span>
            <span style={s.col}>ACTIVE</span>
            <span style={s.colActions}>ACTIONS</span>
          </div>
          {templates.map((t) => (
            <div key={t.id} style={s.tableRow}>
              <span style={s.colAgency}>{t.displayName}<div style={s.subLine}>{t.slug}</div></span>
              <span style={s.col}>{centsToDollars(t.wholesalePriceCents)}</span>
              <span style={s.col}>{t.minimumDailyVolume}–{t.maximumDailyVolume}</span>
              <span style={s.col}>{centsToDollars(t.minimumDepositCents)}</span>
              <span style={s.col}>{t.boberdooTypeId || 'not set'}</span>
              <span style={s.col}><Badge tone={t.active ? 'accent' : 'neutral'}>{t.active ? 'ACTIVE' : 'DISABLED'}</Badge></span>
              <span style={s.colActions}>
                <Button variant="ghost" size="sm" onClick={() => setEditingTemplate(t)}>EDIT CONFIG</Button>
              </span>
            </div>
          ))}
        </Card>
      </section>

      {editingTemplate && (
        <TemplateEditModal template={editingTemplate} onClose={() => setEditingTemplate(null)} onSave={saveTemplate} busy={busyId === editingTemplate.id} />
      )}
    </div>
  );
}

function TemplateEditModal({ template, onClose, onSave, busy }) {
  const [form, setForm] = useState({
    wholesalePriceCents: template.wholesalePriceCents ?? '',
    minimumDailyVolume: template.minimumDailyVolume,
    maximumDailyVolume: template.maximumDailyVolume,
    defaultDailyVolume: template.defaultDailyVolume,
    minimumDepositCents: template.minimumDepositCents,
    boberdooTypeId: template.boberdooTypeId || '',
    boberdooTemplateReference: template.boberdooTemplateReference || '',
    active: template.active,
    configurationJson: JSON.stringify(template.configurationJson || {}, null, 2),
  });
  const [err, setErr] = useState('');

  function submit(e) {
    e.preventDefault();
    let configurationJson;
    try {
      configurationJson = form.configurationJson.trim() ? JSON.parse(form.configurationJson) : {};
    } catch {
      setErr('Configuration JSON is not valid JSON.');
      return;
    }
    onSave({
      wholesalePriceCents: form.wholesalePriceCents === '' ? null : Number(form.wholesalePriceCents),
      minimumDailyVolume: Number(form.minimumDailyVolume),
      maximumDailyVolume: Number(form.maximumDailyVolume),
      defaultDailyVolume: Number(form.defaultDailyVolume),
      minimumDepositCents: Number(form.minimumDepositCents),
      boberdooTypeId: form.boberdooTypeId || null,
      boberdooTemplateReference: form.boberdooTemplateReference || null,
      active: form.active,
      configurationJson,
    });
  }

  return (
    <div style={s.modalBackdrop} onClick={onClose}>
      <Card style={s.modal} onClick={(e) => e.stopPropagation()}>
        <SectionHeader>EDIT — {template.displayName.toUpperCase()}</SectionHeader>
        <form onSubmit={submit} style={s.form}>
          <label style={s.fieldLabel}>Wholesale price (cents per lead/call)<input style={s.input} type="number" value={form.wholesalePriceCents} onChange={(e) => setForm({ ...form, wholesalePriceCents: e.target.value })} /></label>
          <div style={s.row3}>
            <label style={s.fieldLabel}>Min volume<input style={s.input} type="number" value={form.minimumDailyVolume} onChange={(e) => setForm({ ...form, minimumDailyVolume: e.target.value })} /></label>
            <label style={s.fieldLabel}>Default volume<input style={s.input} type="number" value={form.defaultDailyVolume} onChange={(e) => setForm({ ...form, defaultDailyVolume: e.target.value })} /></label>
            <label style={s.fieldLabel}>Max volume<input style={s.input} type="number" value={form.maximumDailyVolume} onChange={(e) => setForm({ ...form, maximumDailyVolume: e.target.value })} /></label>
          </div>
          <label style={s.fieldLabel}>Minimum deposit (cents)<input style={s.input} type="number" value={form.minimumDepositCents} onChange={(e) => setForm({ ...form, minimumDepositCents: e.target.value })} /></label>
          <label style={s.fieldLabel}>Boberdoo Lead_Type ID<input style={s.input} value={form.boberdooTypeId} onChange={(e) => setForm({ ...form, boberdooTypeId: e.target.value })} placeholder="e.g. 21" /></label>
          <label style={s.fieldLabel}>Boberdoo template reference (label only)<input style={s.input} value={form.boberdooTemplateReference} onChange={(e) => setForm({ ...form, boberdooTemplateReference: e.target.value })} /></label>
          <label style={s.fieldLabel}>
            Configuration JSON (raw insertUpdateFilterSet / iprInsertFilterSet fields — e.g. {"{"}"volumeField": "leads_per_week"{"}"})
            <textarea style={{ ...s.input, minHeight: 100, fontFamily: 'monospace', fontSize: 11 }} value={form.configurationJson} onChange={(e) => setForm({ ...form, configurationJson: e.target.value })} />
          </label>
          <label style={{ ...s.fieldLabel, flexDirection: 'row', alignItems: 'center', gap: 8 }}>
            <input type="checkbox" checked={form.active} onChange={(e) => setForm({ ...form, active: e.target.checked })} /> Active / customer-visible
          </label>
          {err && <div style={s.error}>{err}</div>}
          <div style={{ display: 'flex', gap: 8, marginTop: 10 }}>
            <Button variant="primary" type="submit" disabled={busy}>{busy ? 'Saving…' : 'SAVE'}</Button>
            <Button variant="secondary" type="button" onClick={onClose}>CANCEL</Button>
          </div>
        </form>
      </Card>
    </div>
  );
}

const s = {
  loadErrorBox: { background: 'var(--danger-soft)', border: '1px solid rgba(255, 77, 94, 0.4)', color: 'var(--danger)', padding: 16, borderRadius: 8, fontSize: 13, display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 12 },
  statsRow: { display: 'flex', gap: 20, flexWrap: 'wrap', marginBottom: 'var(--space-6)' },
  status: { color: 'var(--accent)', marginBottom: 16, fontSize: 13 },
  section: { marginBottom: 'var(--space-8)' },
  tableCard: { padding: 0, overflow: 'hidden' },
  tableHeaderRow: { display: 'grid', gridTemplateColumns: '2fr 1.2fr 0.8fr 0.8fr 1fr 1.2fr 2fr', padding: '10px 16px', fontSize: 10, letterSpacing: 1, color: 'var(--text-muted)', fontWeight: 700, borderBottom: '1px solid var(--border-hairline)' },
  templateHeaderRow: { display: 'grid', gridTemplateColumns: '2fr 1fr 1.2fr 1fr 1fr 0.8fr 1fr', padding: '10px 16px', fontSize: 10, letterSpacing: 1, color: 'var(--text-muted)', fontWeight: 700, borderBottom: '1px solid var(--border-hairline)' },
  tableRow: { display: 'grid', gridTemplateColumns: '2fr 1.2fr 0.8fr 0.8fr 1fr 1.2fr 2fr', padding: '10px 16px', fontSize: 12, color: 'var(--text-primary)', borderBottom: '1px solid var(--border-hairline)', alignItems: 'center' },
  colAgency: { fontWeight: 600 },
  col: { color: 'var(--text-secondary)' },
  colActions: { display: 'flex', gap: 4, flexWrap: 'wrap' },
  agencyName: { fontWeight: 700 },
  ownerLine: { color: 'var(--text-muted)', fontSize: 10, marginTop: 2 },
  subLine: { color: 'var(--text-muted)', fontSize: 10 },
  expandedBox: { padding: '12px 16px', background: 'var(--bg-sunken)', borderBottom: '1px solid var(--border-hairline)', fontSize: 11, color: 'var(--text-secondary)', display: 'flex', flexDirection: 'column', gap: 6 },
  debugTitle: { fontSize: 10, letterSpacing: 1, color: 'var(--text-muted)', fontWeight: 700, marginBottom: 4 },
  debugRow: { fontFamily: 'monospace' },
  subRow: { display: 'flex', justifyContent: 'space-between', alignItems: 'center', gap: 10, flexWrap: 'wrap' },
  linkRow: { display: 'flex', gap: 8, marginTop: 6 },
  modalBackdrop: { position: 'fixed', inset: 0, background: 'rgba(6,7,9,0.6)', display: 'flex', alignItems: 'center', justifyContent: 'center', zIndex: 'var(--z-modal)', padding: 20, overflowY: 'auto' },
  modal: { maxWidth: 520, width: '100%', maxHeight: '85vh', overflowY: 'auto' },
  form: { display: 'flex', flexDirection: 'column', gap: 10 },
  fieldLabel: { display: 'flex', flexDirection: 'column', gap: 4, fontSize: 11, color: 'var(--text-muted)' },
  row3: { display: 'grid', gridTemplateColumns: '1fr 1fr 1fr', gap: 8 },
  input: { padding: '10px 12px', background: 'var(--bg-sunken)', border: '1px solid var(--border-strong)', borderRadius: 6, color: 'var(--text-primary)' },
  error: { color: 'var(--danger)', fontSize: 12 },
};
