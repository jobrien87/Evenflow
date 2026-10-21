import { useEffect, useMemo, useState } from 'react';
import { api } from '../lib/api';
import { Card, SectionHeader, EmptyState } from '../ui';
import ChatThread from './ChatThread';

// The Platform Owner's own "start a DM with anyone" page — only a Platform
// Owner may start a brand-new DM (server-enforced, routes/chat.js's DM
// branch); the other party just sees/replies to it like any other chat,
// via the notification that fires on the first message and the shared
// /messages/:userId route (DirectMessageThread.jsx), no picker of their own.
//
// GET /users has no server-side search or pagination (confirmed — it
// returns every user platform-wide for a Platform Owner caller in one
// shot), so this reuses the exact same "fetch once, filter in memory on
// each keystroke" pattern already built for the @-mention dropdown in
// ChatThread.jsx, rather than inventing a new typeahead component.
export default function DirectMessagesPanel() {
  const [users, setUsers] = useState([]);
  const [agencyNames, setAgencyNames] = useState({});
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState('');
  const [query, setQuery] = useState('');
  const [selected, setSelected] = useState(null);

  useEffect(() => {
    load();
  }, []);

  async function load() {
    setLoadError('');
    try {
      const [usersRes, agenciesRes] = await Promise.all([
        api.users(''),
        // Covers the common case — a lookup map for display only, not
        // access control, so an agency past the first 100 just shows
        // without a name rather than breaking anything.
        api.agencies('?page=1&pageSize=100'),
      ]);
      const eligible = (usersRes.users || []).filter((u) => u.role !== 'PLATFORM_OWNER' && u.status === 'ACTIVE' && u.agencyId);
      eligible.sort((a, b) => `${a.firstName} ${a.lastName}`.localeCompare(`${b.firstName} ${b.lastName}`));
      setUsers(eligible);
      setAgencyNames(Object.fromEntries((agenciesRes.agencies || []).map((a) => [a.id, a.name])));
    } catch (err) {
      setLoadError(err.data?.message || 'Could not load users. Try refreshing.');
    } finally {
      setLoading(false);
    }
  }

  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase();
    if (!q) return users;
    return users.filter((u) => {
      const name = `${u.firstName} ${u.lastName}`.toLowerCase();
      const agency = (agencyNames[u.agencyId] || '').toLowerCase();
      return name.includes(q) || agency.includes(q) || (u.email || '').toLowerCase().includes(q);
    });
  }, [users, agencyNames, query]);

  return (
    <div style={s.wrap}>
      <SectionHeader>DIRECT MESSAGES</SectionHeader>

      {loadError && (
        <div style={s.errorBox}>
          {loadError}
          <button style={s.retryButton} onClick={load}>RETRY</button>
        </div>
      )}

      <div style={s.layout}>
        <Card style={s.listCard}>
          <input
            style={s.search}
            placeholder="Search by name or agency…"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
          />

          {loading ? (
            <div style={s.muted}>Loading…</div>
          ) : filtered.length === 0 ? (
            <EmptyState title="No users found" description={query ? 'Try a different search.' : 'No agency users yet.'} />
          ) : (
            <div style={s.rows}>
              {filtered.map((u) => {
                const active = selected?.id === u.id;
                return (
                  <div key={u.id} style={active ? s.rowActive : s.row} onClick={() => setSelected(u)}>
                    <div style={s.rowName(active)}>{u.firstName} {u.lastName}</div>
                    <div style={s.rowSub(active)}>{agencyNames[u.agencyId] || 'Unknown agency'} · {u.role.replace(/_/g, ' ')}</div>
                  </div>
                );
              })}
            </div>
          )}
        </Card>

        <Card style={s.threadCard}>
          {selected ? (
            <ChatThread
              key={selected.id}
              entityType="DM"
              entityId={selected.id}
              variant="inline"
              title={`${selected.firstName} ${selected.lastName}`.toUpperCase()}
            />
          ) : (
            <EmptyState title="Pick someone" description="Select a user on the left to start or continue a direct message." />
          )}
        </Card>
      </div>
    </div>
  );
}

const s = {
  wrap: {},
  errorBox: { background: 'var(--danger-soft)', border: '1px solid rgba(255, 77, 94, 0.4)', color: 'var(--danger)', padding: 14, borderRadius: 8, fontSize: 13, display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 12, marginBottom: 16 },
  retryButton: { padding: '6px 12px', background: 'var(--accent)', border: 'none', borderRadius: 6, fontWeight: 700, cursor: 'pointer', fontSize: 11 },
  layout: { display: 'grid', gridTemplateColumns: 'minmax(220px, 300px) 1fr', gap: 16, alignItems: 'start' },
  listCard: { padding: 'var(--space-4)' },
  threadCard: { padding: 'var(--space-4)', height: 640, display: 'flex', flexDirection: 'column' },
  search: { width: '100%', padding: '8px 10px', background: 'var(--bg-sunken)', border: '1px solid var(--border-strong)', borderRadius: 6, color: 'var(--text-primary)', fontSize: 13, marginBottom: 10, boxSizing: 'border-box' },
  rows: { display: 'flex', flexDirection: 'column', gap: 2, maxHeight: 520, overflowY: 'auto' },
  row: { padding: '8px 10px', borderRadius: 6, cursor: 'pointer' },
  rowActive: { padding: '8px 10px', borderRadius: 6, cursor: 'pointer', background: 'var(--accent-gradient)' },
  rowName: (active) => ({ color: active ? 'var(--accent-on)' : 'var(--text-secondary)', fontSize: 13, fontWeight: 600 }),
  rowSub: (active) => ({ color: active ? 'var(--accent-on)' : 'var(--text-muted)', fontSize: 11, marginTop: 1, opacity: active ? 0.8 : 1 }),
  muted: { color: 'var(--text-muted)', fontSize: 13, padding: '10px 0' },
};
