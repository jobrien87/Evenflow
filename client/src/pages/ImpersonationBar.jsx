import { useState } from 'react';
import { api } from '../lib/api';
import { useAuth } from '../lib/AuthContext';

export default function ImpersonationBar() {
  // isImpersonating/viewingAs live on AuthContext (shared with whatever
  // triggered the view-as in the first place, e.g. AgenciesPanel's own
  // "Log in as" button) rather than a private fetch owned by this
  // component — refreshUser() keeps both in sync, from any trigger point.
  const { user, refreshUser, impersonation: status } = useAuth();
  const [showSearch, setShowSearch] = useState(false);
  const [query, setQuery] = useState('');
  const [results, setResults] = useState([]);

  async function search(q) {
    setQuery(q);
    if (q.length < 2) { setResults([]); return; }
    const data = await api.searchUsersForImpersonation(q);
    setResults(data.users);
  }

  async function viewAs(targetUserId) {
    await api.startImpersonation(targetUserId);
    await refreshUser();
    setShowSearch(false);
    setQuery('');
    setResults([]);
  }

  async function exit() {
    await api.endImpersonation();
    await refreshUser();
  }

  if (!status) return null;

  if (status.isImpersonating) {
    return (
      <div style={s.banner}>
        YOU ARE VIEWING EVENFLOW AS <strong>{status.viewingAs.firstName} {status.viewingAs.lastName}</strong> ({status.viewingAs.role.replace(/_/g, ' ')})
        <button style={s.exitButton} onClick={exit}>EXIT VIEW</button>
      </div>
    );
  }

  if (user?.role !== 'PLATFORM_OWNER') return null;

  return (
    <div style={s.viewAsBar}>
      <div style={s.viewAsWrap}>
        <button style={s.viewAsToggle} onClick={() => setShowSearch(!showSearch)}>VIEW AS…</button>
        {showSearch && (
          <div style={s.searchPanel}>
            <input style={s.searchInput} placeholder="Search name or email…" value={query} onChange={(e) => search(e.target.value)} autoFocus />
            {results.map((u) => (
              <div key={u.id} style={s.resultRow} onClick={() => viewAs(u.id)}>
                {u.firstName} {u.lastName} <span style={s.resultRole}>{u.role.replace(/_/g, ' ')}</span>
              </div>
            ))}
          </div>
        )}
      </div>
    </div>
  );
}

const s = {
  banner: {
    background: 'var(--danger)', color: 'var(--text-primary)', padding: '8px 20px', fontSize: 13, fontWeight: 700,
    display: 'flex', alignItems: 'center', gap: 12, justifyContent: 'center',
  },
  exitButton: { padding: '4px 12px', background: 'rgba(0,0,0,0.3)', color: 'var(--text-primary)', border: 'none', borderRadius: 4, cursor: 'pointer', fontSize: 11, fontWeight: 700 },
  viewAsBar: { display: 'flex', justifyContent: 'flex-end', padding: '6px 20px 0', background: 'var(--bg)' },
  viewAsWrap: { position: 'relative' },
  viewAsToggle: { background: 'transparent', border: '1px solid var(--border-strong)', color: 'var(--text-secondary)', padding: '6px 12px', borderRadius: 6, cursor: 'pointer', fontSize: 11 },
  searchPanel: { position: 'absolute', top: '100%', right: 0, marginTop: 6, width: 260, background: 'var(--bg-elevated)', border: '1px solid var(--border-strong)', borderRadius: 8, padding: 10, zIndex: 'var(--z-drawer)' },
  searchInput: { width: '100%', padding: '8px 10px', background: 'var(--bg-sunken)', border: '1px solid var(--border-strong)', borderRadius: 6, color: 'var(--text-primary)', fontSize: 12, boxSizing: 'border-box' },
  resultRow: { padding: '8px 6px', color: 'var(--text-secondary)', fontSize: 13, cursor: 'pointer', borderBottom: '1px solid var(--border-hairline)' },
  resultRole: { color: 'var(--text-muted)', fontSize: 11 },
};
