import { useState } from 'react';
import Button from './Button';
import Icon from './Icon';

// A small standard "EXPORT CSV" action — onExport does the actual work
// (build rows, call downloadCsv), this just standardizes the busy state
// and icon/label across every page that needs one.
export default function ExportButton({ onExport, label = 'EXPORT CSV', size = 'sm', variant = 'secondary' }) {
  const [busy, setBusy] = useState(false);

  async function handleClick() {
    setBusy(true);
    try {
      await onExport();
    } finally {
      setBusy(false);
    }
  }

  return (
    <Button variant={variant} size={size} onClick={handleClick} disabled={busy}>
      <Icon name="download" size={13} style={{ marginRight: 6, verticalAlign: -2 }} />
      {busy ? 'EXPORTING…' : label}
    </Button>
  );
}
