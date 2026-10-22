import { useEffect, useState } from 'react';
import { api } from '../lib/api';
import { Card, Badge, Button, SectionHeader, EmptyState } from '../ui';

// What ED actually reads from (lib/productUpdates.js) — ED's daily
// briefing leads with the most recent relevant one, and ED can mention
// one in normal chat when it's relevant. Every row is live the instant
// it's created; there's no draft/publish state — editing or deleting a
// row is how a mistake gets corrected.
const ROLE_OPTIONS = ['PRODUCER', 'TELEMARKETER', 'AGENCY_OWNER', 'AGENCY_MANAGER', 'PLATFORM_OWNER'];

function audienceLabel(roles) {
  if (!roles || roles.length === 0) return 'Everyone';
  return roles.join(', ');
}

export default function ProductUpdatesAdminPanel() {
  const [updates, setUpdates] = useState([]);
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState('');
  const [status, setStatus] = useState('');
  const [form, setForm] = useState({ title: '', body: '', audienceRoles: [] });
  const [editingId, setEditingId] = useState(null);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    load();
  }, []);

  async function load() {
    setLoadError('');
    try {
      const res = await api.productUpdates();
      setUpdates(res.updates);
    } catch (err) {
      setLoadError(err.data?.message || 'Could not load product updates.');
    } finally {
      setLoading(false);
    }
  }

  function toggleRole(role) {
    setForm((f) => ({
      ...f,
      audienceRoles: f.audienceRoles.includes(role) ? f.audienceRoles.filter((r) => r !== role) : [...f.audienceRoles, role],
    }));
  }

  function startEdit(update) {
    setEditingId(update.id);
    setForm({ title: update.title, body: update.body, audienceRoles: update.audienceRoles || [] });
    setStatus('');
  }

  function cancelEdit() {
    setEditingId(null);
    setForm({ title: '', body: '', audienceRoles: [] });
  }

  async function submit(e) {
    e.preventDefault();
    if (!form.title.trim() || !form.body.trim()) {
      setStatus('Title and body are both required.');
      return;
    }
    setBusy(true);
    setStatus('');
    try {
      if (editingId) {
        await api.updateProductUpdate(editingId, form);
      } else {
        await api.createProductUpdate(form);
      }
      cancelEdit();
      await load();
    } catch (err) {
      setStatus(err.data?.message || 'Could not save that update.');
    } finally {
      setBusy(false);
    }
  }

  async function remove(id) {
    setBusy(true);
    try {
      await api.deleteProductUpdate(id);
      await load();
    } catch (err) {
      setStatus(err.data?.message || 'Could not delete that update.');
    } finally {
      setBusy(false);
    }
  }

  if (loading) return <div>Loading…</div>;
  if (loadError) {
    return (
      <div style={s.loadErrorBox}>{loadError}<Button variant="secondary" size="sm" onClick={load}>RETRY</Button></div>
    );
  }

  return (
    <div>
      <SectionHeader>ED'S "WHAT'S NEW" FEED</SectionHeader>
      <div style={s.helpText}>
        ED leads with the most recent relevant one of these in a person's daily briefing, and can mention one in normal chat when it's relevant — real news, never invented. Everyone sees an update unless you scope its audience.
      </div>

      <Card style={{ marginBottom: 24 }}>
        <form onSubmit={submit} style={s.form}>
          <div style={s.sectionTitle}>{editingId ? 'EDIT UPDATE' : 'PUBLISH A NEW UPDATE'}</div>
          <label style={s.fieldLabel}>Title<input style={s.input} value={form.title} onChange={(e) => setForm({ ...form, title: e.target.value })} placeholder="The Record Store just opened up!" /></label>
          <label style={s.fieldLabel}>Body<textarea style={{ ...s.input, minHeight: 80 }} value={form.body} onChange={(e) => setForm({ ...form, body: e.target.value })} placeholder="What it is, and why it matters to them." /></label>
          <div style={s.fieldLabel}>
            Audience (leave all unchecked for everyone)
            <div style={s.roleRow}>
              {ROLE_OPTIONS.map((role) => (
                <label key={role} style={s.roleChip}>
                  <input type="checkbox" checked={form.audienceRoles.includes(role)} onChange={() => toggleRole(role)} />
                  {role}
                </label>
              ))}
            </div>
          </div>
          {status && <div style={s.error}>{status}</div>}
          <div style={{ display: 'flex', gap: 8 }}>
            <Button variant="primary" type="submit" disabled={busy}>{busy ? 'Saving…' : editingId ? 'SAVE CHANGES' : 'PUBLISH'}</Button>
            {editingId && <Button variant="secondary" type="button" onClick={cancelEdit}>CANCEL</Button>}
          </div>
        </form>
      </Card>

      {updates.length === 0 ? (
        <EmptyState title="No updates published yet" description="Publish one above and ED will start mentioning it." />
      ) : (
        <Card style={s.tableCard}>
          {updates.map((u) => (
            <div key={u.id} style={s.row}>
              <div style={{ flex: 1 }}>
                <div style={s.rowTitle}>{u.title}</div>
                <div style={s.rowBody}>{u.body}</div>
                <div style={s.rowMeta}>
                  <Badge tone="neutral">{audienceLabel(u.audienceRoles)}</Badge>
                  <span style={s.subLine}>{new Date(u.publishedAt).toLocaleString()}</span>
                </div>
              </div>
              <div style={{ display: 'flex', gap: 6 }}>
                <Button variant="ghost" size="sm" onClick={() => startEdit(u)}>EDIT</Button>
                <Button variant="ghost" size="sm" disabled={busy} onClick={() => remove(u.id)}>DELETE</Button>
              </div>
            </div>
          ))}
        </Card>
      )}
    </div>
  );
}

const s = {
  loadErrorBox: { background: 'var(--danger-soft)', border: '1px solid rgba(255, 77, 94, 0.4)', color: 'var(--danger)', padding: 16, borderRadius: 8, fontSize: 13, display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 12 },
  helpText: { color: 'var(--text-muted)', fontSize: 12, lineHeight: 1.5, marginBottom: 16, maxWidth: 680 },
  form: { display: 'flex', flexDirection: 'column', gap: 10 },
  sectionTitle: { fontSize: 12, fontWeight: 700, letterSpacing: 1.5, color: 'var(--text-secondary)' },
  fieldLabel: { display: 'flex', flexDirection: 'column', gap: 4, fontSize: 11, color: 'var(--text-muted)' },
  input: { padding: '10px 12px', background: 'var(--bg-sunken)', border: '1px solid var(--border-strong)', borderRadius: 6, color: 'var(--text-primary)' },
  roleRow: { display: 'flex', flexWrap: 'wrap', gap: 10, marginTop: 4 },
  roleChip: { display: 'flex', alignItems: 'center', gap: 4, fontSize: 11, color: 'var(--text-primary)', cursor: 'pointer' },
  error: { color: 'var(--danger)', fontSize: 12 },
  tableCard: { padding: 0, overflow: 'hidden' },
  row: { display: 'flex', justifyContent: 'space-between', gap: 12, padding: '14px 16px', borderBottom: '1px solid var(--border-hairline)' },
  rowTitle: { fontWeight: 700, fontSize: 13, color: 'var(--text-primary)', marginBottom: 4 },
  rowBody: { fontSize: 12, color: 'var(--text-secondary)', lineHeight: 1.4, marginBottom: 6 },
  rowMeta: { display: 'flex', alignItems: 'center', gap: 10 },
  subLine: { color: 'var(--text-muted)', fontSize: 10 },
};
