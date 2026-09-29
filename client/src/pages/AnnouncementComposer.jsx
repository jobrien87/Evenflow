import { useState } from 'react';
import { api } from '../lib/api';
import { Modal, Button } from '../ui';

// Shared compose form for both Agency Owner/Manager and Platform Owner —
// only the `targets` list differs per role (each role's real allowed
// target set, resolved server-side in routes/announcements.js). A target
// carries an optional `picker`:
//   { field, placeholder, options }        — a static <select> (e.g. a
//     small already-loaded agency/producer list)
//   { field, placeholder, search: true, roleFilter } — a live cross-
//     platform user search (reuses the same search-users endpoint the
//     Platform Owner's "VIEW AS" bar already uses), filtered to the
//     roles that target is actually for
// Either way the chosen id is written to `payload[picker.field]`.
export default function AnnouncementComposer({ open, onClose, targets }) {
  const [title, setTitle] = useState('');
  const [body, setBody] = useState('');
  const [target, setTarget] = useState(targets[0]?.value || '');
  const [pickedId, setPickedId] = useState('');
  const [pickedLabel, setPickedLabel] = useState('');
  const [query, setQuery] = useState('');
  const [results, setResults] = useState([]);
  const [busy, setBusy] = useState(false);
  const [status, setStatus] = useState('');

  if (!open) return null;

  const activeTarget = targets.find((t) => t.value === target);
  const picker = activeTarget?.picker;

  function selectTarget(value) {
    setTarget(value);
    setPickedId('');
    setPickedLabel('');
    setQuery('');
    setResults([]);
  }

  async function search(q) {
    setQuery(q);
    setPickedId('');
    if (q.length < 2) { setResults([]); return; }
    const data = await api.searchUsersForImpersonation(q);
    setResults(data.users.filter((u) => !picker.roleFilter || picker.roleFilter.includes(u.role)));
  }

  async function submit(e) {
    e.preventDefault();
    if (!title.trim() || !body.trim()) return;
    if (picker && !pickedId) {
      setStatus(`Pick ${picker.placeholder.toLowerCase()}.`);
      return;
    }
    setBusy(true);
    setStatus('');
    try {
      const payload = { title: title.trim(), body: body.trim(), target };
      if (picker) payload[picker.field] = pickedId;
      const res = await api.createAnnouncement(payload);
      setStatus(`Sent to ${res.recipientCount} ${res.recipientCount === 1 ? 'person' : 'people'}.`);
      setTitle('');
      setBody('');
      setPickedId('');
      setPickedLabel('');
      setQuery('');
      setResults([]);
      setTimeout(() => { onClose(); setStatus(''); }, 1200);
    } catch (err) {
      setStatus(err.data?.message || 'Could not send the announcement.');
    } finally {
      setBusy(false);
    }
  }

  return (
    <Modal title="NEW ANNOUNCEMENT" onClose={onClose} maxWidth={480}>
      <form onSubmit={submit} style={s.form}>
        <input style={s.input} placeholder="Title" value={title} onChange={(e) => setTitle(e.target.value)} required />
        <textarea style={{ ...s.input, minHeight: 90 }} placeholder="Message" value={body} onChange={(e) => setBody(e.target.value)} required />

        <select style={s.input} value={target} onChange={(e) => selectTarget(e.target.value)}>
          {targets.map((t) => <option key={t.value} value={t.value}>{t.label}</option>)}
        </select>

        {picker?.options && (
          <select style={s.input} value={pickedId} onChange={(e) => setPickedId(e.target.value)}>
            <option value="">{picker.placeholder}</option>
            {picker.options.map((o) => <option key={o.id} value={o.id}>{o.label}</option>)}
          </select>
        )}

        {picker?.search && (
          <div style={s.searchWrap}>
            {pickedId ? (
              <div style={s.pickedRow}>
                <span>{pickedLabel}</span>
                <button type="button" style={s.clearButton} onClick={() => { setPickedId(''); setPickedLabel(''); }}>CHANGE</button>
              </div>
            ) : (
              <>
                <input style={s.input} placeholder={picker.placeholder} value={query} onChange={(e) => search(e.target.value)} />
                {results.map((u) => (
                  <div key={u.id} style={s.resultRow} onClick={() => { setPickedId(u.id); setPickedLabel(`${u.firstName} ${u.lastName} (${u.role.replace(/_/g, ' ')})`); }}>
                    {u.firstName} {u.lastName} <span style={s.resultRole}>{u.role.replace(/_/g, ' ')}</span>
                  </div>
                ))}
              </>
            )}
          </div>
        )}

        {status && <div style={s.status}>{status}</div>}
        <Button variant="primary" type="submit" disabled={busy}>{busy ? 'SENDING…' : 'SEND ANNOUNCEMENT'}</Button>
      </form>
    </Modal>
  );
}

const s = {
  form: { display: 'flex', flexDirection: 'column', gap: 10 },
  input: { padding: '10px 12px', background: 'var(--bg-sunken)', border: '1px solid var(--border-strong)', borderRadius: 6, color: 'var(--text-primary)', fontSize: 13, fontFamily: 'inherit' },
  status: { color: 'var(--text-secondary)', fontSize: 12 },
  searchWrap: { display: 'flex', flexDirection: 'column', gap: 4 },
  resultRow: { padding: '8px 10px', background: 'var(--bg-sunken)', border: '1px solid var(--border-hairline)', borderRadius: 6, color: 'var(--text-secondary)', fontSize: 13, cursor: 'pointer' },
  resultRole: { color: 'var(--text-muted)', fontSize: 11 },
  pickedRow: { display: 'flex', justifyContent: 'space-between', alignItems: 'center', padding: '10px 12px', background: 'var(--bg-sunken)', border: '1px solid var(--border-strong)', borderRadius: 6, color: 'var(--text-primary)', fontSize: 13 },
  clearButton: { background: 'transparent', border: 'none', color: 'var(--accent)', fontSize: 11, fontWeight: 700, cursor: 'pointer' },
};
