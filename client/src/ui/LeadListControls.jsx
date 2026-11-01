import { LEAD_TYPE_META } from '../lib/leadTypeMeta';

export const LEAD_PAGE_SIZE = 50;

const SORTS = [
  { key: 'priority', label: 'Priority (default)' },
  { key: 'type', label: 'Lead type' },
  { key: 'newest', label: 'Newest first' },
  { key: 'oldest', label: 'Oldest first' },
];

const selectStyle = { padding: '8px 10px', background: 'var(--bg-sunken)', border: '1px solid var(--border-strong)', borderRadius: 6, color: 'var(--text-primary)', fontSize: 11 };
const btnStyle = { padding: '6px 12px', background: 'transparent', border: '1px solid var(--border-strong)', color: 'var(--text-secondary)', borderRadius: 6, fontWeight: 700, cursor: 'pointer', fontSize: 11 };

// Lead-type filter + sort dropdowns shared by My Leads and Agency Leads.
export function LeadTypeSortControls({ leadType, sort, onLeadType, onSort }) {
  return (
    <>
      <select style={selectStyle} value={leadType} onChange={(e) => onLeadType(e.target.value)} aria-label="Filter by lead type">
        <option value="">All lead types</option>
        {Object.entries(LEAD_TYPE_META).map(([key, meta]) => <option key={key} value={key}>{meta.label}</option>)}
      </select>
      <select style={selectStyle} value={sort} onChange={(e) => onSort(e.target.value)} aria-label="Sort leads">
        {SORTS.map((o) => <option key={o.key} value={o.key}>Sort: {o.label}</option>)}
      </select>
    </>
  );
}

// "Showing 51–100 of 312" + Prev/Next.
export function LeadPager({ page, pageSize = LEAD_PAGE_SIZE, total, onPage }) {
  if (!total) return null;
  const pages = Math.max(Math.ceil(total / pageSize), 1);
  const from = (page - 1) * pageSize + 1;
  const to = Math.min(page * pageSize, total);
  return (
    <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 10, padding: '12px 0', fontSize: 12, color: 'var(--text-secondary)' }}>
      <span>Showing {from}–{to} of {total}</span>
      <span style={{ display: 'flex', gap: 8, alignItems: 'center' }}>
        <button style={btnStyle} disabled={page <= 1} onClick={() => onPage(page - 1)}>← PREV</button>
        <span>Page {page} of {pages}</span>
        <button style={btnStyle} disabled={page >= pages} onClick={() => onPage(page + 1)}>NEXT →</button>
      </span>
    </div>
  );
}
