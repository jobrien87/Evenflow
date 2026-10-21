import { useEffect, useRef, useState } from 'react';
import { useSearchParams } from 'react-router-dom';
import { api } from '../lib/api';
import { Card, SectionHeader, EmptyState } from '../ui';
import ChatThread from './ChatThread';

const PAGE_SIZE = 50;

// The app owners' own view of every agency's team room — reuses the exact
// same ChatThread component every other chat surface already uses
// (entityType="AGENCY"), just letting a Platform Owner pick WHICH agency's
// room to open instead of it always being their own. Server-side access
// for a Platform Owner on an AGENCY room is a real, deliberate bypass
// (routes/chat.js's platformOwnerAgencyBypass) — they don't need to
// already be a member to read or post.
export default function PlatformChatsPanel() {
  const [agencies, setAgencies] = useState([]);
  const [total, setTotal] = useState(0);
  const [page, setPage] = useState(1);
  const [search, setSearch] = useState('');
  const [searchInput, setSearchInput] = useState('');
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState('');
  const [selected, setSelected] = useState(null);
  const [searchParams] = useSearchParams();
  // A mention-alert notification deep-links here with ?highlight=<agencyId>
  // — that agency may not be on whatever page/search the list currently
  // shows, so it's resolved directly rather than requiring it to appear in
  // the paginated list first. Only ever acted on once per page load.
  const highlightId = searchParams.get('highlight');
  const handledHighlightRef = useRef(false);

  useEffect(() => {
    load();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [page, search]);

  useEffect(() => {
    if (!highlightId || handledHighlightRef.current) return;
    handledHighlightRef.current = true;
    api.agencyDetail(highlightId)
      .then((data) => setSelected(data.agency))
      .catch(() => {});
  }, [highlightId]);

  useEffect(() => {
    const timer = setTimeout(() => {
      setPage(1);
      setSearch(searchInput);
    }, 300);
    return () => clearTimeout(timer);
  }, [searchInput]);

  async function load() {
    setLoadError('');
    try {
      const params = `?page=${page}&pageSize=${PAGE_SIZE}${search ? `&search=${encodeURIComponent(search)}` : ''}`;
      const data = await api.agencies(params);
      setAgencies(data.agencies);
      setTotal(data.total ?? data.agencies.length);
    } catch (err) {
      setLoadError(err.data?.message || 'Could not load agencies. Try refreshing.');
    } finally {
      setLoading(false);
    }
  }

  const totalPages = Math.max(1, Math.ceil(total / PAGE_SIZE));

  return (
    <div style={s.wrap}>
      <SectionHeader>CHATS</SectionHeader>

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
            placeholder="Search agencies…"
            value={searchInput}
            onChange={(e) => setSearchInput(e.target.value)}
          />

          {loading ? (
            <div style={s.muted}>Loading…</div>
          ) : agencies.length === 0 ? (
            <EmptyState title="No agencies found" description={search ? 'Try a different search.' : 'No agencies yet.'} />
          ) : (
            <div style={s.rows}>
              {agencies.map((a) => (
                <div
                  key={a.id}
                  style={selected?.id === a.id ? s.rowActive : s.row}
                  onClick={() => setSelected(a)}
                >
                  {a.name}
                </div>
              ))}
            </div>
          )}

          {totalPages > 1 && (
            <div style={s.pager}>
              <button style={s.pagerButton} disabled={page <= 1} onClick={() => setPage((p) => p - 1)}>PREV</button>
              <span style={s.pagerLabel}>{page} / {totalPages}</span>
              <button style={s.pagerButton} disabled={page >= totalPages} onClick={() => setPage((p) => p + 1)}>NEXT</button>
            </div>
          )}
        </Card>

        <Card style={s.threadCard}>
          {selected ? (
            <ChatThread
              key={selected.id}
              entityType="AGENCY"
              entityId={selected.id}
              variant="inline"
              title={`${selected.name.toUpperCase()} — TEAM CHAT`}
            />
          ) : (
            <EmptyState title="Pick an agency" description="Select an agency on the left to open its team chat." />
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
  row: { padding: '10px 10px', borderRadius: 6, color: 'var(--text-secondary)', fontSize: 13, fontWeight: 600, cursor: 'pointer' },
  rowActive: { padding: '10px 10px', borderRadius: 6, color: 'var(--accent-on)', background: 'var(--accent-gradient)', fontSize: 13, fontWeight: 700, cursor: 'pointer' },
  muted: { color: 'var(--text-muted)', fontSize: 13, padding: '10px 0' },
  pager: { display: 'flex', alignItems: 'center', justifyContent: 'center', gap: 10, marginTop: 10 },
  pagerButton: { padding: '6px 12px', background: 'transparent', border: '1px solid var(--border-strong)', color: 'var(--text-secondary)', borderRadius: 6, cursor: 'pointer', fontSize: 11 },
  pagerLabel: { color: 'var(--text-muted)', fontSize: 12 },
};
