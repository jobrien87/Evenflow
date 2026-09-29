import { useState } from 'react';
import { api } from '../lib/api';
import { FileDropzone } from '../ui';

// Reused by AgencyOwnerDashboard's LEADS section and AgencySettingsModal —
// one real upload flow (parse → createLeadRecord per row), not two.
export default function BulkLeadUploadBox({ agencyId, onImported }) {
  const [busy, setBusy] = useState(false);
  const [result, setResult] = useState(null);
  const [error, setError] = useState('');

  async function handleFile(file) {
    setBusy(true);
    setError('');
    setResult(null);
    try {
      const data = await api.bulkImportLeads(file, agencyId);
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
      <FileDropzone
        onFile={handleFile}
        disabled={busy}
        label={busy ? 'Importing…' : 'Click to upload, or drag a lead-list file here'}
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
    </div>
  );
}

const s = {
  wrap: { marginTop: 12, marginBottom: 12 },
  error: { color: 'var(--danger)', fontSize: 12, marginTop: 8 },
  result: { color: 'var(--text-secondary)', fontSize: 12, marginTop: 8 },
};
