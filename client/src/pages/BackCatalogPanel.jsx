import { useState, useEffect, useCallback } from 'react';
import { api } from '../lib/api';
import { FileDropzone, SectionHeader, Card, EmptyState } from '../ui';
import { CATEGORY_OPTIONS } from '../lib/bulkUploadCategories';

// Which external system this export is coming from — purely a label on
// the created LeadImportBatch (server/src/routes/leads.js's
// POST /leads/back-catalog-import); the parsing/creation path underneath
// is identical regardless of which one is picked (see
// server/src/lib/leadBulkImport.js's own fuzzy column matching — "any
// column headers, we'll match them up automatically" already covers a
// typical CSV/XLS export from any of these).
const SOURCE_SYSTEM_OPTIONS = [
  { value: 'PERFORMOLOGY', label: 'Performology' },
  { value: 'AGENCYZOOM', label: 'AgencyZoom' },
  { value: 'RICOCHET', label: 'Ricochet' },
  { value: 'OTHER', label: 'Other system' },
];

// Historical data port-in from a legacy agency system. Deliberately
// separate from BulkLeadUploadBox.jsx's live upload flow: a ported-in
// record always lands unassigned and out of the Moshpit pool (it's
// backfill, not a fresh lead that should ping a producer), and this
// screen never asks about distribution. Shares the exact same
// parse/create/batch-tracking/undo engine under the hood (see
// POST /leads/back-catalog-import), so undo works identically to the
// live upload's "Recent Imports" list — just its own separate history.
const MODES = [
  { value: 'leads', label: 'Workable Leads' },
  { value: 'historical', label: 'Historical Data (numbers only)' },
];

export default function BackCatalogPanel() {
  // This page is only mounted for AGENCY_OWNER/AGENCY_MANAGER (App.jsx's
  // RoleGate) — the server infers their own agencyId server-side, so no
  // agencyId needs to be threaded through here (unlike BulkLeadUploadBox,
  // which is also reused from a Platform-Owner-facing surface).
  const [mode, setMode] = useState('leads');
  const [sourceSystem, setSourceSystem] = useState('');
  const [leadCategory, setLeadCategory] = useState('');
  const [busy, setBusy] = useState(false);
  const [result, setResult] = useState(null);
  const [error, setError] = useState('');
  const [batches, setBatches] = useState([]);
  const [batchesError, setBatchesError] = useState('');
  const [undoingId, setUndoingId] = useState(null);
  const [undoError, setUndoError] = useState('');

  const isHistorical = mode === 'historical';

  const loadBatches = useCallback(async (kind) => {
    try {
      const data = await api.leadImportBatches(`?kind=${kind}`);
      setBatches(data.batches || []);
      setBatchesError('');
    } catch (err) {
      setBatchesError(err.data?.message || 'Could not load import history.');
    }
  }, []);

  useEffect(() => {
    setResult(null);
    setError('');
    loadBatches(isHistorical ? 'historical_data' : 'back_catalog');
  }, [isHistorical, loadBatches]);

  async function handleFile(file) {
    setBusy(true);
    setError('');
    setResult(null);
    try {
      const data = isHistorical
        ? await api.historicalDataImport(file, undefined, sourceSystem)
        : await api.backCatalogImport(file, undefined, sourceSystem, leadCategory);
      setResult(data);
      await loadBatches(isHistorical ? 'historical_data' : 'back_catalog');
    } catch (err) {
      setError(err.data?.message || 'Could not import that file.');
    } finally {
      setBusy(false);
    }
  }

  async function undoImport(batch) {
    const label = SOURCE_SYSTEM_OPTIONS.find((o) => o.value === batch.sourceSystem)?.label || 'this import';
    const confirmMsg = isHistorical
      ? `Undo this ${label} historical data import (${batch.createdAt ? new Date(batch.createdAt).toLocaleString() : ''})? All ${batch.undoableCount} record${batch.undoableCount === 1 ? '' : 's'} will be permanently deleted.`
      : `Undo this ${label} import (${batch.createdAt ? new Date(batch.createdAt).toLocaleString() : ''})? ${batch.undoableCount} untouched lead${batch.undoableCount === 1 ? '' : 's'} will be archived. Any lead that's already been worked is left alone.`;
    if (!confirm(confirmMsg)) return;
    setUndoingId(batch.id);
    setUndoError('');
    try {
      await api.undoLeadImport(batch.id);
      await loadBatches(isHistorical ? 'historical_data' : 'back_catalog');
    } catch (err) {
      setUndoError(err.data?.message || 'Could not undo this import.');
    } finally {
      setUndoingId(null);
    }
  }

  const ready = isHistorical ? !!sourceSystem : sourceSystem && leadCategory;

  return (
    <div style={s.wrap}>
      <SectionHeader>BACK CATALOG</SectionHeader>
      <div style={s.subtitle}>
        {isHistorical
          ? 'Upload old datasets to teach the system — these never become workable leads, they just feed the real numbers'
          : 'Port historical leads and customers in from another system'}
      </div>

      <div style={s.modeToggle}>
        {MODES.map((m) => (
          <button
            key={m.value}
            type="button"
            style={{ ...s.modeButton, ...(mode === m.value ? s.modeButtonActive : {}) }}
            onClick={() => setMode(m.value)}
          >
            {m.label}
          </button>
        ))}
      </div>

      <Card style={s.card}>
        <label style={s.fieldLabel}>
          Which system is this coming from?
          <select style={s.select} value={sourceSystem} onChange={(e) => setSourceSystem(e.target.value)}>
            <option value="">Select system…</option>
            {SOURCE_SYSTEM_OPTIONS.map((o) => <option key={o.value} value={o.value}>{o.label}</option>)}
          </select>
        </label>
        {!isHistorical && (
          <label style={s.fieldLabel}>
            What kind of leads are these?
            <select style={s.select} value={leadCategory} onChange={(e) => setLeadCategory(e.target.value)}>
              <option value="">Select lead type…</option>
              {CATEGORY_OPTIONS.map((o) => <option key={o.value} value={o.value}>{o.label}</option>)}
            </select>
          </label>
        )}
        <FileDropzone
          onFile={handleFile}
          disabled={busy || !ready}
          label={busy ? 'Importing…' : !ready ? `Choose a system${isHistorical ? '' : ' and lead type'} above first` : 'Click to upload, or drag an export file here'}
          hint={isHistorical
            ? 'CSV, XLS, or XLSX — must include a date column; any other column headers are matched up automatically'
            : 'CSV, XLS, or XLSX exported from that system — any column headers, we\'ll match them up automatically'}
        />
        {error && <div style={s.error}>{error}</div>}
        {result && (
          <div style={s.result}>
            {isHistorical ? (
              <>
                Imported {result.created} of {result.totalRows} row{result.totalRows === 1 ? '' : 's'} as historical records — stored for reporting/pattern-learning only, never assigned or shown to anyone to work.
                {result.skipped > 0 ? ` ${result.skipped} row${result.skipped === 1 ? '' : 's'} skipped (usually a missing/unparseable date).` : ''}
              </>
            ) : (
              <>
                Imported {result.created} of {result.totalRows} row{result.totalRows === 1 ? '' : 's'} as historical leads (unassigned, not placed in the Moshpit).
                {result.skipped > 0 ? ` ${result.skipped} row${result.skipped === 1 ? '' : 's'} skipped.` : ''}
              </>
            )}
            {result.truncated ? ' This file had more rows than one upload can process — split it up and upload the rest separately.' : ''}
          </div>
        )}
      </Card>

      {undoError && <div style={s.error}>{undoError}</div>}
      {batchesError && <div style={s.error}>{batchesError}</div>}
      <div style={s.historyWrap}>
        <div style={s.historyLabel}>{isHistorical ? 'HISTORICAL DATA IMPORT HISTORY' : 'IMPORT HISTORY'}</div>
        {batches.length === 0 && !batchesError && (
          <EmptyState
            title={isHistorical ? 'No Historical Data imports yet' : 'No Back Catalog imports yet'}
            description={isHistorical
              ? 'Uploads tagged as historical data will show up here — their numbers feed reports but the records are never workable leads.'
              : 'Uploads from Performology, AgencyZoom, Ricochet, or another system will show up here.'}
          />
        )}
        {batches.map((b) => {
          const systemLabel = SOURCE_SYSTEM_OPTIONS.find((o) => o.value === b.sourceSystem)?.label || b.sourceSystem;
          return (
            <div key={b.id} style={s.historyRow}>
              <div style={s.historyMeta}>
                <span style={s.historySystem}>{systemLabel}</span> — {b.created} {isHistorical ? 'record' : 'lead'}{b.created === 1 ? '' : 's'} by {b.uploadedBy ? `${b.uploadedBy.firstName} ${b.uploadedBy.lastName}` : 'someone'}, {new Date(b.createdAt).toLocaleString()}
                {b.undoneAt && <span style={s.undoneTag}> · undone</span>}
              </div>
              {!b.undoneAt && b.withinUndoWindow && b.undoableCount > 0 && (
                <button style={s.undoButton} disabled={undoingId === b.id} onClick={() => undoImport(b)}>
                  {undoingId === b.id ? 'UNDOING…' : `UNDO (${b.undoableCount})`}
                </button>
              )}
              {!b.undoneAt && b.withinUndoWindow && b.undoableCount === 0 && !isHistorical && (
                <span style={s.undoneTag}>all leads already worked</span>
              )}
              {!b.undoneAt && !b.withinUndoWindow && (
                <span style={s.undoneTag}>undo window expired</span>
              )}
            </div>
          );
        })}
      </div>
    </div>
  );
}

const s = {
  wrap: { display: 'flex', flexDirection: 'column', gap: 16, padding: '0 0 24px' },
  subtitle: { fontSize: 12, color: 'var(--text-muted)', marginTop: -8 },
  modeToggle: { display: 'flex', gap: 8 },
  modeButton: { padding: '8px 14px', background: 'var(--bg-elevated)', border: '1px solid var(--border-hairline)', color: 'var(--text-secondary)', borderRadius: 6, cursor: 'pointer', fontSize: 12, fontWeight: 700 },
  modeButtonActive: { background: 'var(--accent)', borderColor: 'var(--accent)', color: 'var(--bg)' },
  card: { display: 'flex', flexDirection: 'column', gap: 12, padding: 16 },
  fieldLabel: { display: 'flex', flexDirection: 'column', gap: 4, fontSize: 11, color: 'var(--text-muted)' },
  select: { padding: '10px 12px', background: 'var(--bg-sunken)', border: '1px solid var(--border-strong)', borderRadius: 6, color: 'var(--text-primary)', fontSize: 13 },
  error: { color: 'var(--danger)', fontSize: 12 },
  result: { color: 'var(--text-secondary)', fontSize: 12 },
  historyWrap: { display: 'flex', flexDirection: 'column', gap: 8 },
  historyLabel: { fontSize: 10, fontWeight: 700, letterSpacing: '0.06em', color: 'var(--text-muted)' },
  historyRow: { display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 10, padding: '10px 12px', fontSize: 12, color: 'var(--text-secondary)', background: 'var(--bg-elevated)', border: '1px solid var(--border-hairline)', borderRadius: 6 },
  historyMeta: { flex: 1 },
  historySystem: { fontWeight: 700, color: 'var(--text-primary)' },
  undoButton: { padding: '6px 12px', background: 'transparent', border: '1px solid var(--border-strong)', color: 'var(--text-secondary)', borderRadius: 6, cursor: 'pointer', fontSize: 11, fontWeight: 700, whiteSpace: 'nowrap' },
  undoneTag: { fontSize: 11, color: 'var(--text-muted)', fontStyle: 'italic', whiteSpace: 'nowrap' },
};
