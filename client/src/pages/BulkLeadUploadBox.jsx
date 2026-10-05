import { useState, useEffect, useCallback } from 'react';
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
// one real upload flow (parse → createLeadRecord per row), not two. The
// "Recent Imports" list below is read fresh from GET /leads/import-batches
// every time this component mounts — real, server-side history, not local
// upload-session state — so undo is still reachable after leaving and
// coming back to this page (or opening it on a different device), not just
// in the few seconds right after a file finishes uploading.
export default function BulkLeadUploadBox({ agencyId, onImported }) {
  const [leadCategory, setLeadCategory] = useState('');
  const [busy, setBusy] = useState(false);
  const [result, setResult] = useState(null);
  const [error, setError] = useState('');
  const [batches, setBatches] = useState([]);
  const [batchesError, setBatchesError] = useState('');
  const [undoingId, setUndoingId] = useState(null);
  const [undoError, setUndoError] = useState('');

  const loadBatches = useCallback(async () => {
    try {
      const data = await api.leadImportBatches(agencyId ? `?agencyId=${agencyId}` : '');
      setBatches(data.batches || []);
      setBatchesError('');
    } catch (err) {
      setBatchesError(err.data?.message || 'Could not load recent imports.');
    }
  }, [agencyId]);

  useEffect(() => {
    loadBatches();
  }, [loadBatches]);

  async function handleFile(file) {
    setBusy(true);
    setError('');
    setResult(null);
    try {
      const data = await api.bulkImportLeads(file, agencyId, leadCategory);
      setResult(data);
      await loadBatches();
      if (onImported) onImported();
    } catch (err) {
      setError(err.data?.message || 'Could not import that file.');
    } finally {
      setBusy(false);
    }
  }

  async function undoImport(batch) {
    const label = batch.leadCategory ? `this ${batch.leadCategory.toLowerCase()} import` : 'this import';
    if (!confirm(`Undo ${label} (${batch.createdAt ? new Date(batch.createdAt).toLocaleString() : ''})? ${batch.undoableCount} untouched lead${batch.undoableCount === 1 ? '' : 's'} will be archived. Any lead that's already been worked (assigned, noted, attempted, or dispositioned) is left alone.`)) {
      return;
    }
    setUndoingId(batch.id);
    setUndoError('');
    try {
      await api.undoLeadImport(batch.id);
      await loadBatches();
      if (onImported) onImported();
    } catch (err) {
      setUndoError(err.data?.message || 'Could not undo this import.');
    } finally {
      setUndoingId(null);
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
        </div>
      )}
      {undoError && <div style={s.error}>{undoError}</div>}
      {batchesError && <div style={s.error}>{batchesError}</div>}
      {batches.length > 0 && (
        <div style={s.history}>
          <div style={s.historyLabel}>RECENT IMPORTS</div>
          {batches.map((b) => (
            <div key={b.id} style={s.historyRow}>
              <div style={s.historyMeta}>
                <span style={s.historyCategory}>{b.leadCategory}</span> — {b.created} lead{b.created === 1 ? '' : 's'} by {b.uploadedBy ? `${b.uploadedBy.firstName} ${b.uploadedBy.lastName}` : 'someone'}, {new Date(b.createdAt).toLocaleString()}
                {b.undoneAt && <span style={s.undoneTag}> · undone</span>}
              </div>
              {!b.undoneAt && b.withinUndoWindow && b.undoableCount > 0 && (
                <button style={s.undoButton} disabled={undoingId === b.id} onClick={() => undoImport(b)}>
                  {undoingId === b.id ? 'UNDOING…' : `UNDO (${b.undoableCount})`}
                </button>
              )}
              {!b.undoneAt && b.withinUndoWindow && b.undoableCount === 0 && (
                <span style={s.undoneTag}>all leads already worked</span>
              )}
              {!b.undoneAt && !b.withinUndoWindow && (
                <span style={s.undoneTag}>undo window expired</span>
              )}
            </div>
          ))}
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
  history: { marginTop: 14, borderTop: '1px solid var(--border-hairline)', paddingTop: 10 },
  historyLabel: { fontSize: 10, fontWeight: 700, letterSpacing: '0.06em', color: 'var(--text-muted)', marginBottom: 8 },
  historyRow: { display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 10, padding: '6px 0', fontSize: 12, color: 'var(--text-secondary)' },
  historyMeta: { flex: 1 },
  historyCategory: { fontWeight: 700, color: 'var(--text-primary)' },
  undoButton: { padding: '6px 12px', background: 'transparent', border: '1px solid var(--border-strong)', color: 'var(--text-secondary)', borderRadius: 6, cursor: 'pointer', fontSize: 11, fontWeight: 700, whiteSpace: 'nowrap' },
  undoneTag: { fontSize: 11, color: 'var(--text-muted)', fontStyle: 'italic', whiteSpace: 'nowrap' },
};
