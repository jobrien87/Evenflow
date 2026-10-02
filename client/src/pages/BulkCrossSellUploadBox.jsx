import { useState } from 'react';
import { api } from '../lib/api';
import { FileDropzone } from '../ui';

// Keep in sync with server/src/routes/opportunities.js's CROSS_SELL_PRODUCTS.
const PRODUCT_OPTIONS = ['Auto', 'Home', 'Life'];

// Self-service upload of an externally-sourced cross-sell report (e.g. an
// AMS "Auto, no Home" book-of-business export) — turns each row into a
// real Customer + CROSS_SELL Opportunity via the server's exact existing
// cross-sell-detection code path, one real upload flow, not a second one.
export default function BulkCrossSellUploadBox({ agencyId, onImported }) {
  const [havesProduct, setHavesProduct] = useState('');
  const [needsProduct, setNeedsProduct] = useState('');
  const [busy, setBusy] = useState(false);
  const [result, setResult] = useState(null);
  const [error, setError] = useState('');

  const ready = havesProduct && needsProduct && havesProduct !== needsProduct;

  async function handleFile(file) {
    setBusy(true);
    setError('');
    setResult(null);
    try {
      const data = await api.bulkImportCrossSell(file, agencyId, havesProduct, needsProduct);
      setResult(data);
      if (onImported) onImported();
    } catch (err) {
      setError(err.data?.message || 'Could not import that file.');
    } finally {
      setBusy(false);
    }
  }

  return (
    <div style={s.wrap}>
      <div style={s.fieldRow}>
        <label style={s.fieldLabel}>
          This list already has…
          <select style={s.select} value={havesProduct} onChange={(e) => setHavesProduct(e.target.value)}>
            <option value="">Select product…</option>
            {PRODUCT_OPTIONS.map((p) => <option key={p} value={p}>{p}</option>)}
          </select>
        </label>
        <label style={s.fieldLabel}>
          …and should be cross-sold
          <select style={s.select} value={needsProduct} onChange={(e) => setNeedsProduct(e.target.value)}>
            <option value="">Select product…</option>
            {PRODUCT_OPTIONS.filter((p) => p !== havesProduct).map((p) => <option key={p} value={p}>{p}</option>)}
          </select>
        </label>
      </div>
      <FileDropzone
        onFile={handleFile}
        disabled={busy || !ready}
        label={busy ? 'Importing…' : !ready ? 'Pick both products above first' : 'Click to upload, or drag your cross-sell report here'}
        hint="CSV, XLS, or XLSX — any column headers, we'll match them up automatically"
      />
      {error && <div style={s.error}>{error}</div>}
      {result && (
        <div style={s.result}>
          {result.customersCreated} new customer{result.customersCreated === 1 ? '' : 's'} added, {result.customersMatched} already on file.
          {' '}{result.opportunitiesCreated} cross-sell opportunit{result.opportunitiesCreated === 1 ? 'y' : 'ies'} created.
          {result.skipped > 0 ? ` ${result.skipped} row${result.skipped === 1 ? '' : 's'} skipped (missing name or contact info).` : ''}
          {result.truncated ? ' This file had more rows than one upload can process — split it up and upload the rest separately.' : ''}
        </div>
      )}
    </div>
  );
}

const s = {
  wrap: { marginTop: 12, marginBottom: 12 },
  fieldRow: { display: 'flex', gap: 12, marginBottom: 10, flexWrap: 'wrap' },
  fieldLabel: { display: 'flex', flexDirection: 'column', gap: 4, fontSize: 11, color: 'var(--text-muted)', flex: 1, minWidth: 180 },
  select: { padding: '10px 12px', background: 'var(--bg-sunken)', border: '1px solid var(--border-strong)', borderRadius: 6, color: 'var(--text-primary)', fontSize: 13 },
  error: { color: 'var(--danger)', fontSize: 12, marginTop: 8 },
  result: { color: 'var(--text-secondary)', fontSize: 12, marginTop: 8 },
};
