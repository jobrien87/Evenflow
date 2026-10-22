import { useEffect, useState } from 'react';
import { api } from '../lib/api';
import { Card, Badge, Button, StatTile, SectionHeader, EmptyState } from '../ui';
import { centsToDollarInput, dollarsToCents } from '../lib/format';

function centsToDollars(cents) {
  if (cents === null || cents === undefined) return '—';
  return `$${(cents / 100).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
}

const PARTNER_STATUS_LABEL = { 0: 'Not Active', 1: 'Temporarily Stopped', 2: 'Active' };

// Mirrors routes/recordStore.js's own CUSTOM_LEAD_TYPES constant — the
// only 3 lead types with a confirmed-real Boberdoo TYPE id. Used only to
// prefill the quote form; the server is the real source of truth and
// validates independently.
const CUSTOM_LEAD_TYPE_IDS = { 'Auto Insurance': '23', 'Home Insurance': '21', 'Life Insurance': '19' };

const CUSTOM_REQUEST_STATUS_TONE = { PENDING_REVIEW: 'warning', QUOTED: 'accent', DECLINED: 'danger', CONVERTED: 'neutral' };

export default function RecordStoreAdminPanel() {
  const [agencies, setAgencies] = useState([]);
  const [templates, setTemplates] = useState([]);
  const [customRequests, setCustomRequests] = useState([]);
  const [sourceOptimizations, setSourceOptimizations] = useState([]);
  const [platformSettings, setPlatformSettings] = useState(null);
  const [settingsForm, setSettingsForm] = useState(null);
  const [savingSettings, setSavingSettings] = useState(false);
  const [settingsError, setSettingsError] = useState('');
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState('');
  const [expandedId, setExpandedId] = useState(null);
  const [editingTemplate, setEditingTemplate] = useState(null);
  const [quotingRequest, setQuotingRequest] = useState(null);
  const [decliningRequest, setDecliningRequest] = useState(null);
  const [linkForm, setLinkForm] = useState(null); // { agencyId, partnerId }
  const [importForm, setImportForm] = useState(null); // { agencyId, filterSetId }
  const [status, setStatus] = useState('');
  const [busyId, setBusyId] = useState(null);

  useEffect(() => {
    load();
  }, []);

  async function load() {
    setLoadError('');
    try {
      const [customersRes, templatesRes, customRequestsRes, settingsRes, optimizationsRes] = await Promise.all([
        api.adminRecordStoreCustomers(),
        api.adminRecordStoreTemplates(),
        api.adminCustomRequests(),
        api.recordStorePlatformSettings(),
        api.adminRecordStoreSourceOptimizations(),
      ]);
      setAgencies(customersRes.agencies);
      setTemplates(templatesRes.templates);
      setCustomRequests(customRequestsRes.requests);
      setPlatformSettings(settingsRes.settings);
      setSourceOptimizations(optimizationsRes.runs);
      if (!settingsForm) {
        setSettingsForm({
          lowBalanceThreshold: centsToDollarInput(settingsRes.settings.lowBalanceThresholdCents),
          topUpTarget: centsToDollarInput(settingsRes.settings.topUpTargetCents),
        });
      }
    } catch (err) {
      setLoadError(err.data?.message || 'Could not load Record Store admin data.');
    } finally {
      setLoading(false);
    }
  }

  async function saveSettings(e) {
    e.preventDefault();
    setSettingsError('');
    setSavingSettings(true);
    try {
      const res = await api.updateRecordStorePlatformSettings({
        lowBalanceThresholdCents: dollarsToCents(settingsForm.lowBalanceThreshold),
        topUpTargetCents: dollarsToCents(settingsForm.topUpTarget),
      });
      setPlatformSettings(res.settings);
    } catch (err) {
      setSettingsError(err.data?.message || 'Could not save these settings.');
    } finally {
      setSavingSettings(false);
    }
  }

  async function submitQuote(patch) {
    setBusyId(quotingRequest.id);
    try {
      await api.quoteCustomRequest(quotingRequest.id, patch);
      setQuotingRequest(null);
      await load();
    } catch (err) {
      setStatus(err.data?.message || 'Could not save that quote.');
    } finally {
      setBusyId(null);
    }
  }

  async function submitDecline(decisionNotes) {
    setBusyId(decliningRequest.id);
    try {
      await api.declineCustomRequest(decliningRequest.id, decisionNotes);
      setDecliningRequest(null);
      await load();
    } catch (err) {
      setStatus(err.data?.message || 'Could not decline that request.');
    } finally {
      setBusyId(null);
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

  async function submitImport() {
    setBusyId(importForm.agencyId);
    try {
      await api.importExistingFilterSet(importForm.agencyId, importForm.filterSetId);
      setImportForm(null);
      await load();
    } catch (err) {
      setStatus(err.data?.message || 'Could not import that filter set.');
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
        <SectionHeader>LOW-BALANCE GATE</SectionHeader>
        <Card>
          <div style={s.subLine}>
            Once an agency has funded their account once, adding a lead type they don't already hold never requires a fresh deposit — unless their real Record Store balance has dropped below the threshold below, in which case they must top up past the target before the order is allowed.
          </div>
          {settingsForm && (
            <form onSubmit={saveSettings} style={{ ...s.form, marginTop: 12 }}>
              <div style={s.row3}>
                <label style={s.fieldLabel}>Low-balance threshold ($)<input style={s.input} type="number" step="0.01" min="0" value={settingsForm.lowBalanceThreshold} onChange={(e) => setSettingsForm({ ...settingsForm, lowBalanceThreshold: e.target.value })} /></label>
                <label style={s.fieldLabel}>Required top-up target ($)<input style={s.input} type="number" step="0.01" min="0" value={settingsForm.topUpTarget} onChange={(e) => setSettingsForm({ ...settingsForm, topUpTarget: e.target.value })} /></label>
              </div>
              {settingsError && <div style={s.error}>{settingsError}</div>}
              <div style={{ display: 'flex', gap: 8, marginTop: 4 }}>
                <Button variant="primary" type="submit" disabled={savingSettings}>{savingSettings ? 'Saving…' : 'SAVE'}</Button>
                {platformSettings?.updatedAt && <span style={s.subLine}>Last updated {new Date(platformSettings.updatedAt).toLocaleString()}</span>}
              </div>
            </form>
          )}
        </Card>
      </section>

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
                      <div style={s.debugRow}>Record Store Partner ID: {a.boberdooPartnerId || 'none yet'}</div>
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
                            <input style={s.input} placeholder="Existing Record Store Partner ID" value={linkForm.partnerId} onChange={(e) => setLinkForm({ ...linkForm, partnerId: e.target.value })} />
                            <Button variant="primary" size="sm" disabled={busyId === a.id} onClick={submitLink}>LINK</Button>
                            <Button variant="secondary" size="sm" onClick={() => setLinkForm(null)}>CANCEL</Button>
                          </div>
                        ) : (
                          <Button variant="secondary" size="sm" onClick={() => setLinkForm({ agencyId: a.id, partnerId: '' })}>LINK EXISTING RECORD STORE PARTNER</Button>
                        )
                      )}
                      {a.boberdooPartnerId && (
                        importForm?.agencyId === a.id ? (
                          <div style={s.linkRow}>
                            <input style={s.input} placeholder="Existing Filter Set ID" value={importForm.filterSetId} onChange={(e) => setImportForm({ ...importForm, filterSetId: e.target.value })} />
                            <Button variant="primary" size="sm" disabled={busyId === a.id} onClick={submitImport}>IMPORT</Button>
                            <Button variant="secondary" size="sm" onClick={() => setImportForm(null)}>CANCEL</Button>
                          </div>
                        ) : (
                          <Button variant="secondary" size="sm" onClick={() => setImportForm({ agencyId: a.id, filterSetId: '' })}>IMPORT EXISTING FILTER SET</Button>
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
        <SectionHeader>CUSTOM REQUESTS</SectionHeader>
        {customRequests.length === 0 ? (
          <EmptyState title="No custom requests yet" description="Build Your Own submissions from agencies show up here for a quote." />
        ) : (
          <Card style={s.tableCard}>
            <div style={s.customHeaderRow}>
              <span style={s.colAgency}>AGENCY / LEAD TYPE</span>
              <span style={s.col}>SOURCES</span>
              <span style={s.col}>DAILY CAP</span>
              <span style={s.col}>STATUS</span>
              <span style={s.colActions}>ACTIONS</span>
            </div>
            {customRequests.map((r) => (
              <div key={r.id} style={s.customRow}>
                <span style={s.colAgency}>{r.agency?.name || '—'}<div style={s.subLine}>{r.leadTypeLabel}</div></span>
                <span style={s.col}>{(r.sourceLabels || []).join(', ') || '—'}</span>
                <span style={s.col}>{r.dailyLimit || '—'}/day</span>
                <span style={s.col}><Badge tone={CUSTOM_REQUEST_STATUS_TONE[r.status]}>{r.status.replace('_', ' ')}</Badge></span>
                <span style={s.colActions}>
                  {r.status === 'PENDING_REVIEW' && (
                    <>
                      <Button variant="primary" size="sm" onClick={() => setQuotingRequest(r)}>QUOTE</Button>
                      <Button variant="ghost" size="sm" onClick={() => setDecliningRequest(r)}>DECLINE</Button>
                    </>
                  )}
                  {r.status === 'QUOTED' && <span style={s.subLine}>{centsToDollars(r.quotedPriceCents)}/lead — awaiting customer</span>}
                </span>
              </div>
            ))}
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
            <span style={s.col}>LEAD TYPE ID</span>
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

      <section style={s.section}>
        <SectionHeader>SOURCE OPTIMIZATION</SectionHeader>
        {sourceOptimizations.length === 0 ? (
          <EmptyState title="No optimization runs yet" description="Every 30-day lead-source check EvenFlow makes — applied, failed, or no change needed — shows up here across every agency." />
        ) : (
          <Card style={s.tableCard}>
            <div style={s.optimizationHeaderRow}>
              <span style={s.colAgency}>AGENCY / PROGRAM</span>
              <span style={s.col}>WINDOW</span>
              <span style={s.col}>STATUS</span>
              <span style={s.col}>DROPPED</span>
              <span style={s.colWide}>REASONING</span>
            </div>
            {sourceOptimizations.map((r) => (
              <div key={r.id} style={s.optimizationRow}>
                <span style={s.colAgency}>{r.subscription?.agency?.name || '—'}<div style={s.subLine}>{r.subscription?.productNameSnapshot}</div></span>
                <span style={s.col}>{new Date(r.windowStart).toLocaleDateString()} – {new Date(r.windowEnd).toLocaleDateString()}</span>
                <span style={s.col}>
                  <Badge tone={r.status === 'APPLIED' ? 'accent' : r.status === 'FAILED' ? 'danger' : 'neutral'}>{r.status.replace(/_/g, ' ')}</Badge>
                </span>
                <span style={s.col}>{(r.droppedSourceLabels || []).join(', ') || '—'}</span>
                <span style={s.colWide}>{r.reasoning}{r.errorMessage && <div style={s.subLine}>{r.errorMessage}</div>}</span>
              </div>
            ))}
          </Card>
        )}
      </section>

      {editingTemplate && (
        <TemplateEditModal template={editingTemplate} onClose={() => setEditingTemplate(null)} onSave={saveTemplate} busy={busyId === editingTemplate.id} />
      )}

      {quotingRequest && (
        <QuoteRequestModal request={quotingRequest} onClose={() => setQuotingRequest(null)} onSave={submitQuote} busy={busyId === quotingRequest.id} />
      )}

      {decliningRequest && (
        <DeclineRequestModal request={decliningRequest} onClose={() => setDecliningRequest(null)} onSave={submitDecline} busy={busyId === decliningRequest.id} />
      )}
    </div>
  );
}

function QuoteRequestModal({ request, onClose, onSave, busy }) {
  const [priceDollars, setPriceDollars] = useState('');
  const [boberdooTypeId, setBoberdooTypeId] = useState(CUSTOM_LEAD_TYPE_IDS[request.leadTypeLabel] || '');
  const [decisionNotes, setDecisionNotes] = useState('');
  const [err, setErr] = useState('');

  function submit(e) {
    e.preventDefault();
    const cents = dollarsToCents(priceDollars);
    if (!cents || cents <= 0) {
      setErr('Enter a price greater than zero.');
      return;
    }
    if (!boberdooTypeId.trim()) {
      setErr('Enter the real lead-exchange TYPE id for this lead type before quoting.');
      return;
    }
    onSave({ quotedPriceCents: cents, boberdooTypeId: boberdooTypeId.trim(), decisionNotes: decisionNotes.trim() || undefined });
  }

  return (
    <div style={s.modalBackdrop} onClick={onClose}>
      <Card style={s.modal} onClick={(e) => e.stopPropagation()}>
        <SectionHeader>QUOTE — {request.agency?.name} ({request.leadTypeLabel})</SectionHeader>
        <form onSubmit={submit} style={s.form}>
          <div style={s.subLine}>Sources: {(request.sourceLabels || []).join(', ') || '—'}</div>
          <div style={s.subLine}>Daily cap: {request.dailyLimit || '—'}/day{request.weeklyLimit ? ` · Weekly: ${request.weeklyLimit}` : ''}{request.monthlyLimit ? ` · Monthly: ${request.monthlyLimit}` : ''}</div>
          {request.notes && <div style={s.subLine}>Notes: {request.notes}</div>}
          <label style={s.fieldLabel}>Price ($ per lead)<input style={s.input} type="number" step="0.01" min="0" value={priceDollars} onChange={(e) => setPriceDollars(e.target.value)} autoFocus /></label>
          <label style={s.fieldLabel}>Lead Type ID<input style={s.input} value={boberdooTypeId} onChange={(e) => setBoberdooTypeId(e.target.value)} placeholder="e.g. 23" /></label>
          <label style={s.fieldLabel}>Note to the agency (optional)<textarea style={{ ...s.input, minHeight: 60 }} value={decisionNotes} onChange={(e) => setDecisionNotes(e.target.value)} /></label>
          {err && <div style={s.error}>{err}</div>}
          <div style={{ display: 'flex', gap: 8, marginTop: 10 }}>
            <Button variant="primary" type="submit" disabled={busy}>{busy ? 'Saving…' : 'SEND QUOTE'}</Button>
            <Button variant="secondary" type="button" onClick={onClose}>CANCEL</Button>
          </div>
        </form>
      </Card>
    </div>
  );
}

function DeclineRequestModal({ request, onClose, onSave, busy }) {
  const [decisionNotes, setDecisionNotes] = useState('');
  const [err, setErr] = useState('');

  function submit(e) {
    e.preventDefault();
    if (!decisionNotes.trim()) {
      setErr('Enter a reason — the agency will see this.');
      return;
    }
    onSave(decisionNotes.trim());
  }

  return (
    <div style={s.modalBackdrop} onClick={onClose}>
      <Card style={s.modal} onClick={(e) => e.stopPropagation()}>
        <SectionHeader>DECLINE — {request.agency?.name} ({request.leadTypeLabel})</SectionHeader>
        <form onSubmit={submit} style={s.form}>
          <label style={s.fieldLabel}>Reason (the agency will see this)<textarea style={{ ...s.input, minHeight: 60 }} value={decisionNotes} onChange={(e) => setDecisionNotes(e.target.value)} autoFocus /></label>
          {err && <div style={s.error}>{err}</div>}
          <div style={{ display: 'flex', gap: 8, marginTop: 10 }}>
            <Button variant="danger" type="submit" disabled={busy}>{busy ? 'Saving…' : 'CONFIRM DECLINE'}</Button>
            <Button variant="secondary" type="button" onClick={onClose}>CANCEL</Button>
          </div>
        </form>
      </Card>
    </div>
  );
}

function TemplateEditModal({ template, onClose, onSave, busy }) {
  const [form, setForm] = useState({
    wholesalePrice: centsToDollarInput(template.wholesalePriceCents),
    minimumDailyVolume: template.minimumDailyVolume,
    maximumDailyVolume: template.maximumDailyVolume,
    defaultDailyVolume: template.defaultDailyVolume,
    minimumDeposit: centsToDollarInput(template.minimumDepositCents),
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
      wholesalePriceCents: dollarsToCents(form.wholesalePrice),
      minimumDailyVolume: Number(form.minimumDailyVolume),
      maximumDailyVolume: Number(form.maximumDailyVolume),
      defaultDailyVolume: Number(form.defaultDailyVolume),
      minimumDepositCents: dollarsToCents(form.minimumDeposit),
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
          <label style={s.fieldLabel}>Wholesale price ($ per lead/call)<input style={s.input} type="number" step="0.01" min="0" value={form.wholesalePrice} onChange={(e) => setForm({ ...form, wholesalePrice: e.target.value })} /></label>
          <div style={s.row3}>
            <label style={s.fieldLabel}>Min volume<input style={s.input} type="number" value={form.minimumDailyVolume} onChange={(e) => setForm({ ...form, minimumDailyVolume: e.target.value })} /></label>
            <label style={s.fieldLabel}>Default volume<input style={s.input} type="number" value={form.defaultDailyVolume} onChange={(e) => setForm({ ...form, defaultDailyVolume: e.target.value })} /></label>
            <label style={s.fieldLabel}>Max volume<input style={s.input} type="number" value={form.maximumDailyVolume} onChange={(e) => setForm({ ...form, maximumDailyVolume: e.target.value })} /></label>
          </div>
          <label style={s.fieldLabel}>Minimum deposit ($)<input style={s.input} type="number" step="0.01" min="0" value={form.minimumDeposit} onChange={(e) => setForm({ ...form, minimumDeposit: e.target.value })} /></label>
          <label style={s.fieldLabel}>Lead_Type ID (lead exchange)<input style={s.input} value={form.boberdooTypeId} onChange={(e) => setForm({ ...form, boberdooTypeId: e.target.value })} placeholder="e.g. 21" /></label>
          <label style={s.fieldLabel}>Lead exchange template reference (label only)<input style={s.input} value={form.boberdooTemplateReference} onChange={(e) => setForm({ ...form, boberdooTemplateReference: e.target.value })} /></label>
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
  customHeaderRow: { display: 'grid', gridTemplateColumns: '2fr 1.5fr 1fr 1fr 1.5fr', padding: '10px 16px', fontSize: 10, letterSpacing: 1, color: 'var(--text-muted)', fontWeight: 700, borderBottom: '1px solid var(--border-hairline)' },
  customRow: { display: 'grid', gridTemplateColumns: '2fr 1.5fr 1fr 1fr 1.5fr', padding: '10px 16px', fontSize: 12, color: 'var(--text-primary)', borderBottom: '1px solid var(--border-hairline)', alignItems: 'center' },
  optimizationHeaderRow: { display: 'grid', gridTemplateColumns: '1.5fr 1.2fr 1fr 1.2fr 3fr', padding: '10px 16px', fontSize: 10, letterSpacing: 1, color: 'var(--text-muted)', fontWeight: 700, borderBottom: '1px solid var(--border-hairline)' },
  optimizationRow: { display: 'grid', gridTemplateColumns: '1.5fr 1.2fr 1fr 1.2fr 3fr', padding: '10px 16px', fontSize: 12, color: 'var(--text-primary)', borderBottom: '1px solid var(--border-hairline)', alignItems: 'center', gap: 8 },
  colWide: { color: 'var(--text-secondary)', fontSize: 11, lineHeight: 1.4 },
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
