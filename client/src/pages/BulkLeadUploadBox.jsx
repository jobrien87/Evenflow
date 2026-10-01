import { useState } from 'react';
import { api } from '../lib/api';
import { FileDropzone } from '../ui';

// Keep in sync with server/src/lib/leadType.js's BULK_UPLOAD_CATEGORIES —
// what kind of list this is. Winback/Cross-Sell set the real leadType;
// the product options set Lead.product for the whole batch (taking
// precedence over whatever a CSV's own "product" column said, since the
// person uploading is explicitly declaring what this list is).
const CATEGORY_OPTIONS = [
  { value: 'WINBACK', label: 'Winbacks' },
  { value: 'CROSS_SELL', label: 'Cross-Sell' },
  { value: 'REFERRAL', label: 'Referral' },
  { value: 'INTERNET', label: 'Internet' },
  { value: 'WALK_IN', label: 'Walk In' },
  { value: 'AUTO', label: 'Auto' },
  { value: 'HOME', label: 'Home' },
  { value: 'COMMERCIAL', label: 'Commercial' },
  { value: 'LIFE', label: 'Life' },
  { value: 'HEALTH', label: 'Health' },
  { value: 'UNKNOWN', label: 'Unknown' },
];

// Reused by AgencyOwnerDashboard's LEADS section and AgencySettingsModal —
// one real upload flow (parse → createLeadRecord per row), not two.
export default function BulkLeadUploadBox({ agencyId, onImported }) {
  const [leadCategory, setLeadCategory] = useState('');
  const [busy, setBusy] = useState(false);
  const [result, setResult] = useState(null);
  const [error, setError] = useState('');
  const [undoBusy, setUndoBusy] = useState(false);
  const [undoResult, setUndoResult] = useState(null);

  async function handleFile(file) {
    setBusy(true);
    setError('');
    setResult(null);
    setUndoResult(null);
    try {
      const data = await api.bulkImportLeads(file, agencyId, leadCategory);
      setResult(data);
      if (onImported) onImported();
    } catch (err) {
      setError(err.data?.message || 'Could not import that file.');
    } finally {
      setBusy(false);
    }
  }

  async function undoImport() {
    if (!result?.batchId) return;
    setUndoBusy(true);
    try {
      const data = await api.undoLeadImport(result.batchId);
      setUndoResult(data);
      if (onImported) onImported();
    } catch (err) {
      setUndoResult({ error: err.data?.message || 'Could not undo this import.' });
    } finally {
      setUndoBusy(false);
    }
  }

  return (
    <div style={s.wrap}>
      <label style={s.fieldLabel}>
        What kind of leads are these?
        <select style={s.select} value={leadCategory} onChange={(e) => setLeadCategory(e.target.value)}>
          <option value="">Select lead type…</option>
          {CATEGORY_OPTIONS.map((o) => <option key={o.value} value={o.value}>{o.label}</option>)}
        </select>
      </label>
      <FileDropzone
        onFile={handleFile}
        disabled={busy || !leadCategory}
        label={busy ? 'Importing…' : !leadCategory ? 'Choose a lead type above first' : 'Click to upload, or drag a lead-list file here'}
        hint="CSV, XLS, or XLSX — any column headers, we'll match them up automatically"
      />
      {error && <div style={s.error}>{error}</div>}
      {result && (
        <div style={s.result}>
          Imported {result.created} of {result.totalRows} row{result.totalRows === 1 ? '' : 's'}.
          {result.skipped > 0 ? ` ${result.skipped} row${result.skipped === 1 ? '' : 's'} skipped.` : ''}
          {result.truncated ? ' This file had more rows than one upload can process — split it up and upload the rest separately.' : ''}
          {result.created > 0 && !undoResult && (
            <div style={{ marginTop: 8 }}>
              <button style={s.undoButton} disabled={undoBusy} onClick={undoImport}>
                {undoBusy ? 'UNDOING…' : 'UNDO THIS IMPORT'}
              </button>
            </div>
          )}
          {undoResult && !undoResult.error && (
            <div style={s.undoNote}>
              Undone — archived {undoResult.archived} lead{undoResult.archived === 1 ? '' : 's'}.
              {undoResult.kept > 0 ? ` ${undoResult.kept} left as-is (already worked).` : ''}
            </div>
          )}
          {undoResult?.error && <div style={s.error}>{undoResult.error}</div>}
        </div>
      )}
    </div>
  );
}

const s = {
  wrap: { marginTop: 12, marginBottom: 12 },
  fieldLabel: { display: 'flex', flexDirection: 'column', gap: 4, fontSize: 11, color: 'var(--text-muted)', marginBottom: 10 },
  select: { padding: '10px 12px', background: 'var(--bg-sunken)', border: '1px solid var(--border-strong)', borderRadius: 6, color: 'var(--text-primary)', fontSize: 13 },
  error: { color: 'var(--danger)', fontSize: 12, marginTop: 8 },
  result: { color: 'var(--text-secondary)', fontSize: 12, marginTop: 8 },
  undoButton: { padding: '6px 12px', background: 'transparent', border: '1px solid var(--border-strong)', color: 'var(--text-secondary)', borderRadius: 6, cursor: 'pointer', fontSize: 11, fontWeight: 700 },
  undoNote: { color: 'var(--accent)', fontSize: 12, marginTop: 6 },
};
