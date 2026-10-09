import { useEffect, useState } from 'react';
import { api } from '../lib/api';
import { useAuth } from '../lib/AuthContext';
import { Modal, Button, SectionHeader } from '../ui';
import { PRODUCTS, PRODUCT_META } from '../lib/productMeta';
import { CARRIER_OPTIONS, LEAD_SOURCE_OPTIONS, PRIOR_CARRIER_OPTIONS, REASON_OPTIONS, policyTypesForCarrier } from '../lib/manualSaleOptions';

const todayISO = () => new Date().toISOString().slice(0, 10);

function emptyForm(keep = {}) {
  return {
    firstName: '', lastName: '', businessName: '', customerTitle: '', customerSuffix: '',
    phone: '', email: '', zip: '', state: '',
    saleDate: todayISO(), issuedDate: '', effectiveDate: '', expirationDate: '',
    carrier: '', policyType: '', productFamily: PRODUCTS[0], policyNumber: '',
    premiumCents: '', revenueCents: '', items: '1',
    leadSource: '', priorCarrier: '', reason: '', notes: '',
    officeId: '', assignedToId: '',
    // Any field in `keep` (a "Save & Add Another" carry-forward, or a
    // disposition-nudge prefill from a real Lead) overrides the blank
    // default above.
    ...keep,
  };
}

function toCents(value) {
  if (value === '' || value === null || value === undefined) return undefined;
  const n = Number(value);
  if (Number.isNaN(n)) return undefined;
  return Math.round(n * 100);
}

function fromCents(cents) {
  if (cents === null || cents === undefined) return '';
  return (cents / 100).toFixed(2);
}

function toDateInput(value) {
  if (!value) return '';
  return new Date(value).toISOString().slice(0, 10);
}

// Builds the edit-mode form directly from a real Sale row (as returned
// by GET /sales / PATCH /sales/:id) — cents back to dollar strings, ISO
// dates back to YYYY-MM-DD, matching emptyForm's exact field shape.
function formFromSale(sale) {
  return {
    firstName: sale.firstName || '', lastName: sale.lastName || '', businessName: sale.businessName || '',
    customerTitle: sale.customerTitle || '', customerSuffix: sale.customerSuffix || '',
    phone: '', email: '', zip: sale.zip || '', state: sale.state || '',
    saleDate: toDateInput(sale.saleDate), issuedDate: toDateInput(sale.issuedDate),
    effectiveDate: toDateInput(sale.effectiveDate), expirationDate: toDateInput(sale.expirationDate),
    carrier: sale.carrier || '', policyType: sale.policyType || '', productFamily: sale.productFamily || PRODUCTS[0],
    policyNumber: sale.policyNumber || '',
    premiumCents: fromCents(sale.premiumCents), revenueCents: fromCents(sale.revenueCents), items: String(sale.items ?? 1),
    leadSource: sale.leadSource || '', priorCarrier: sale.priorCarrier || '', reason: sale.reason || '', notes: sale.notes || '',
    officeId: sale.officeId || '', assignedToId: sale.assignedToId || '',
  };
}

// Add Closed Sale — the one real production/revenue entry, standalone or
// linked back to a real Lead via `leadId` (set by the post-disposition
// "log as Closed Sale" nudge in LeadDetailModal.jsx, which also supplies
// `prefill` from that Lead's own rich sale-detail fields). Single-producer
// entry only this round (split credit/points/onboarding side effects are
// explicitly out of scope, per the spec).
//
// Pass `sale` (a real Sale row) to open this in edit mode instead of
// create mode — the form is pre-filled from it and submit PATCHes the
// existing row rather than creating a new one. Phone/email aren't part
// of the editable Sale fields (they live on the linked Customer, set only
// at creation), so those two inputs are intentionally left blank in edit
// mode rather than guessed at.
export default function AddClosedSaleModal({ onClose, onSaved, leadId, prefill, sale }) {
  const { user } = useAuth();
  const isEdit = Boolean(sale);
  const isProducer = user?.role === 'PRODUCER';
  const [producers, setProducers] = useState([]);
  const [offices, setOffices] = useState([]);
  const [form, setForm] = useState(isEdit ? formFromSale(sale) : emptyForm(prefill));
  const [clientRequestId, setClientRequestId] = useState(crypto.randomUUID());
  const [duplicates, setDuplicates] = useState(null);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState('');
  const [savedCount, setSavedCount] = useState(0);

  useEffect(() => {
    if (isProducer) return;
    // A selling AGENCY_MANAGER (e.g. one who carries her own book of
    // business) must be selectable here too, not just a plain PRODUCER —
    // same eligible-production-roles rule as Billboard/financials.js's
    // eligibleProducersWhere.
    api.users('').then((data) => setProducers(data.users.filter((u) => ['PRODUCER', 'AGENCY_MANAGER'].includes(u.role) && u.status === 'ACTIVE'))).catch(() => {});
    api.offices('').then((data) => setOffices(data.offices || [])).catch(() => {});
  }, [isProducer]);

  function setField(key, value) {
    setForm((f) => ({ ...f, [key]: value }));
  }

  function buildPayload(confirmDuplicate) {
    const premiumCents = toCents(form.premiumCents);
    const revenueCents = toCents(form.revenueCents);
    return {
      // A correction never carries a create-time idempotency key or a
      // leadId — the server already ignores leadId on PATCH (a sale can
      // never be relinked to a different lead), so it's left out here
      // rather than sent and silently dropped.
      ...(isEdit ? {} : { clientRequestId, leadId: leadId || undefined }),
      firstName: form.firstName,
      lastName: form.lastName,
      businessName: form.businessName || undefined,
      customerTitle: form.customerTitle || undefined,
      customerSuffix: form.customerSuffix || undefined,
      phone: form.phone || undefined,
      email: form.email || undefined,
      zip: form.zip || undefined,
      state: form.state || undefined,
      saleDate: form.saleDate,
      issuedDate: form.issuedDate || undefined,
      effectiveDate: form.effectiveDate || undefined,
      expirationDate: form.expirationDate || undefined,
      carrier: form.carrier,
      policyType: form.policyType,
      productFamily: form.productFamily,
      policyNumber: form.policyNumber || undefined,
      // Zero is a real, meaningful entry here — never dropped as falsy.
      premiumCents: premiumCents !== undefined ? premiumCents : undefined,
      revenueCents: revenueCents !== undefined ? revenueCents : undefined,
      items: form.items !== '' ? Number(form.items) : undefined,
      leadSource: form.leadSource || undefined,
      priorCarrier: form.priorCarrier || undefined,
      reason: form.reason || undefined,
      notes: form.notes || undefined,
      officeId: form.officeId || undefined,
      assignedToId: isProducer ? undefined : form.assignedToId || undefined,
      confirmDuplicate: confirmDuplicate || undefined,
    };
  }

  async function submit(e, { addAnother = false, confirmDuplicate = false } = {}) {
    if (e) e.preventDefault();
    setError('');
    setSaving(true);
    try {
      const res = isEdit
        ? await api.updateSale(sale.id, buildPayload(confirmDuplicate))
        : await api.createSale(buildPayload(confirmDuplicate));
      setDuplicates(null);
      setSavedCount((c) => c + 1);
      onSaved?.(res.sale);
      if (addAnother) {
        setForm(emptyForm({ saleDate: form.saleDate, officeId: form.officeId, assignedToId: form.assignedToId }));
        setClientRequestId(crypto.randomUUID());
      } else {
        onClose();
      }
    } catch (err) {
      if (err.status === 409 && err.data?.error === 'POSSIBLE_DUPLICATE') {
        setDuplicates(err.data);
      } else {
        setError(err.data?.message || 'Could not save this sale.');
      }
    } finally {
      setSaving(false);
    }
  }

  const policyTypes = form.carrier ? policyTypesForCarrier(form.carrier) : [];
  const modalTitle = isEdit ? 'EDIT CLOSED SALE' : `ADD CLOSED SALE${savedCount > 0 ? ` (${savedCount} saved)` : ''}`;

  return (
    <Modal onClose={onClose} title={modalTitle} maxWidth={720}>
      {error && <div style={s.error}>{error}</div>}
      {isEdit && sale.leadId && (
        <div style={s.linkedLeadNote}>Linked to a Lead — this connection can&rsquo;t be changed here.</div>
      )}

      {duplicates ? (
        <div>
          <div style={s.error}>
            A similar sale may already exist. Review below, then confirm to save anyway or cancel to edit your entry.
          </div>
          {duplicates.sales?.length > 0 && (
            <div style={s.dupSection}>
              <div style={s.dupTitle}>Matching sales</div>
              {duplicates.sales.map((d) => (
                <div key={d.id} style={s.dupRow}>
                  {d.firstName} {d.lastName} · {d.carrier} {d.policyType} · {d.policyNumber || 'no policy #'} · {new Date(d.saleDate).toLocaleDateString()}
                </div>
              ))}
            </div>
          )}
          {duplicates.historicalRecords?.length > 0 && (
            <div style={s.dupSection}>
              <div style={s.dupTitle}>Matching historical records</div>
              {duplicates.historicalRecords.map((d) => (
                <div key={d.id} style={s.dupRow}>
                  {d.firstName} {d.lastName} · {d.product || '—'} · {new Date(d.recordDate).toLocaleDateString()}
                </div>
              ))}
            </div>
          )}
          <div style={s.footerRow}>
            <Button variant="secondary" onClick={() => setDuplicates(null)} disabled={saving}>EDIT ENTRY</Button>
            <Button variant="danger" onClick={() => submit(null, { confirmDuplicate: true })} disabled={saving}>
              {saving ? 'SAVING…' : 'SAVE ANYWAY'}
            </Button>
          </div>
        </div>
      ) : (
        <form onSubmit={submit}>
          <SectionHeader>Customer</SectionHeader>
          <div style={s.grid2}>
            <input style={s.input} placeholder="First name" value={form.firstName} onChange={(e) => setField('firstName', e.target.value)} required />
            <input style={s.input} placeholder="Last name" value={form.lastName} onChange={(e) => setField('lastName', e.target.value)} required />
            <input style={s.input} placeholder="Business name (optional)" value={form.businessName} onChange={(e) => setField('businessName', e.target.value)} />
            <input style={s.input} placeholder="Phone" value={form.phone} onChange={(e) => setField('phone', e.target.value)} />
            <input style={s.input} type="email" placeholder="Email" value={form.email} onChange={(e) => setField('email', e.target.value)} />
            <input style={s.input} placeholder="Zip" value={form.zip} onChange={(e) => setField('zip', e.target.value)} />
            <input style={s.input} placeholder="State" value={form.state} onChange={(e) => setField('state', e.target.value)} />
          </div>

          <SectionHeader>Policy & Dates</SectionHeader>
          <div style={s.grid2}>
            <select style={s.input} value={form.productFamily} onChange={(e) => setField('productFamily', e.target.value)}>
              {PRODUCTS.map((p) => <option key={p} value={p}>{PRODUCT_META[p]?.label || p}</option>)}
            </select>
            <select style={s.input} value={form.carrier} onChange={(e) => { setField('carrier', e.target.value); setField('policyType', ''); }} required>
              <option value="">Select carrier…</option>
              {CARRIER_OPTIONS.map((c) => <option key={c} value={c}>{c}</option>)}
            </select>
            <select style={s.input} value={form.policyType} onChange={(e) => setField('policyType', e.target.value)} required disabled={!form.carrier}>
              <option value="">{form.carrier ? 'Select policy type…' : 'Pick a carrier first'}</option>
              {policyTypes.map((p) => <option key={p} value={p}>{p}</option>)}
            </select>
            <input style={s.input} placeholder="Policy number" value={form.policyNumber} onChange={(e) => setField('policyNumber', e.target.value)} />
            <label style={s.labeled}>
              <span style={s.labelText}>Sale date</span>
              <input style={s.input} type="date" value={form.saleDate} onChange={(e) => setField('saleDate', e.target.value)} required />
            </label>
            <label style={s.labeled}>
              <span style={s.labelText}>Issued date</span>
              <input style={s.input} type="date" value={form.issuedDate} onChange={(e) => setField('issuedDate', e.target.value)} />
            </label>
            <label style={s.labeled}>
              <span style={s.labelText}>Effective date</span>
              <input style={s.input} type="date" value={form.effectiveDate} onChange={(e) => setField('effectiveDate', e.target.value)} />
            </label>
            <label style={s.labeled}>
              <span style={s.labelText}>Expiration date</span>
              <input style={s.input} type="date" value={form.expirationDate} onChange={(e) => setField('expirationDate', e.target.value)} />
            </label>
            <label style={s.labeled}>
              <span style={s.labelText}>Premium ($)</span>
              <input style={s.input} type="number" step="0.01" min="0" placeholder="0.00" value={form.premiumCents} onChange={(e) => setField('premiumCents', e.target.value)} />
            </label>
            <label style={s.labeled}>
              <span style={s.labelText}>Revenue ($, kept separate from premium)</span>
              <input style={s.input} type="number" step="0.01" min="0" placeholder="0.00" value={form.revenueCents} onChange={(e) => setField('revenueCents', e.target.value)} />
            </label>
            <label style={s.labeled}>
              <span style={s.labelText}>Items</span>
              <input style={s.input} type="number" min="0" step="1" value={form.items} onChange={(e) => setField('items', e.target.value)} />
            </label>
          </div>

          <SectionHeader>Source</SectionHeader>
          <div style={s.grid2}>
            <select style={s.input} value={form.leadSource} onChange={(e) => setField('leadSource', e.target.value)}>
              <option value="">Lead source (optional)</option>
              {LEAD_SOURCE_OPTIONS.map((o) => <option key={o} value={o}>{o}</option>)}
            </select>
            <select style={s.input} value={form.priorCarrier} onChange={(e) => setField('priorCarrier', e.target.value)}>
              <option value="">Prior carrier (optional)</option>
              {PRIOR_CARRIER_OPTIONS.map((o) => <option key={o} value={o}>{o}</option>)}
            </select>
            <select style={s.input} value={form.reason} onChange={(e) => setField('reason', e.target.value)}>
              <option value="">Reason (optional)</option>
              {REASON_OPTIONS.map((o) => <option key={o} value={o}>{o}</option>)}
            </select>
          </div>

          {!isProducer && (
            <>
              <SectionHeader>Office & Producer</SectionHeader>
              <div style={s.grid2}>
                <select style={s.input} value={form.officeId} onChange={(e) => setField('officeId', e.target.value)}>
                  <option value="">No office</option>
                  {offices.map((o) => <option key={o.id} value={o.id}>{o.name}</option>)}
                </select>
                <select style={s.input} value={form.assignedToId} onChange={(e) => setField('assignedToId', e.target.value)} required>
                  <option value="">Credit which producer?</option>
                  {producers.map((p) => <option key={p.id} value={p.id}>{p.firstName} {p.lastName}</option>)}
                </select>
              </div>
            </>
          )}

          <SectionHeader>Notes</SectionHeader>
          <textarea style={s.textarea} maxLength={1000} placeholder="Notes (optional)" value={form.notes} onChange={(e) => setField('notes', e.target.value)} />

          <div style={s.footerRow}>
            <Button type="button" variant="secondary" onClick={onClose} disabled={saving}>CANCEL</Button>
            {!isEdit && (
              <Button type="button" variant="secondary" onClick={(e) => submit(e, { addAnother: true })} disabled={saving}>
                {saving ? 'SAVING…' : 'SAVE & ADD ANOTHER'}
              </Button>
            )}
            <Button type="submit" disabled={saving}>{saving ? 'SAVING…' : isEdit ? 'SAVE CHANGES' : 'SAVE'}</Button>
          </div>
        </form>
      )}
    </Modal>
  );
}

const s = {
  error: { background: 'var(--danger-soft)', border: '1px solid rgba(255, 77, 94, 0.4)', color: 'var(--danger)', padding: 12, borderRadius: 8, fontSize: 13, marginBottom: 14 },
  linkedLeadNote: { background: 'var(--bg-sunken)', border: '1px solid var(--border-strong)', color: 'var(--text-secondary)', padding: '8px 12px', borderRadius: 6, fontSize: 12, marginBottom: 14 },
  grid2: { display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 10, marginBottom: 18 },
  input: { padding: '10px 12px', background: 'var(--bg-sunken)', border: '1px solid var(--border-strong)', borderRadius: 6, color: 'var(--text-primary)', fontSize: 13, width: '100%' },
  labeled: { display: 'flex', flexDirection: 'column', gap: 4 },
  labelText: { fontSize: 11, color: 'var(--text-muted)' },
  textarea: { width: '100%', minHeight: 70, padding: '10px 12px', background: 'var(--bg-sunken)', border: '1px solid var(--border-strong)', borderRadius: 6, color: 'var(--text-primary)', fontSize: 13, marginBottom: 18, resize: 'vertical' },
  footerRow: { display: 'flex', justifyContent: 'flex-end', gap: 10, marginTop: 8 },
  dupSection: { marginBottom: 14 },
  dupTitle: { fontSize: 11, letterSpacing: 1, fontWeight: 700, color: 'var(--text-secondary)', marginBottom: 6, textTransform: 'uppercase' },
  dupRow: { fontSize: 12, color: 'var(--text-secondary)', padding: '6px 0', borderBottom: '1px solid var(--border-hairline)' },
};
