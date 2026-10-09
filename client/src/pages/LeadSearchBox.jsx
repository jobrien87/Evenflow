import { useState } from 'react';
import { useAuth } from '../lib/AuthContext';
import { api } from '../lib/api';
import { Card, Badge, Button, SectionHeader } from '../ui';
import LeadDetailModal from './LeadDetailModal';

function statusTone(status) {
  if (status === 'SOLD') return 'accent';
  if (['LOST', 'BAD_CONTACT', 'DUPLICATE', 'DO_NOT_CONTACT'].includes(status)) return 'danger';
  if (status === 'NEW') return 'warning';
  return 'neutral';
}

// Agency-wide name/phone/email lookup for a returning prospect — see
// GET /leads/search's own comment for the deliberate scope decision
// (every allowed role, Producer included, searches the whole agency,
// not just their own leads). Pure read throughout: finding or opening a
// result never changes its assignedToId/status/archivedAt.
export default function LeadSearchBox() {
  const { user } = useAuth();
  const canOpenAny = ['AGENCY_OWNER', 'AGENCY_MANAGER', 'PLATFORM_OWNER'].includes(user?.role);
  const [q, setQ] = useState('');
  const [results, setResults] = useState([]);
  const [searched, setSearched] = useState(false);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');
  const [openLeadId, setOpenLeadId] = useState(null);
  const [expandedId, setExpandedId] = useState(null);

  async function runSearch(e) {
    if (e) e.preventDefault();
    const term = q.trim();
    if (term.length < 2) {
      setError('Enter at least 2 characters.');
      return;
    }
    setError('');
    setLoading(true);
    try {
      const data = await api.searchLeads(`?q=${encodeURIComponent(term)}&pageSize=50`);
      setResults(data.leads || []);
      setSearched(true);
    } catch (err) {
      setError(err.data?.message || 'Could not search leads. Try again.');
    } finally {
      setLoading(false);
    }
  }

  function canOpenFull(lead) {
    return canOpenAny || lead.assignedToId === user?.id;
  }

  function handleRowClick(lead) {
    if (canOpenFull(lead)) {
      setOpenLeadId(lead.id);
    } else {
      setExpandedId((id) => (id === lead.id ? null : lead.id));
    }
  }

  return (
    <Card>
      <SectionHeader>Find a Lead</SectionHeader>
      <form onSubmit={runSearch} style={s.searchRow}>
        <input
          style={s.input}
          placeholder="Search by name, phone, or email…"
          value={q}
          onChange={(e) => setQ(e.target.value)}
        />
        <Button type="submit" disabled={loading}>{loading ? 'SEARCHING…' : 'SEARCH'}</Button>
      </form>
      {error && <div style={s.error}>{error}</div>}

      {openLeadId && (
        <LeadDetailModal leadId={openLeadId} onClose={() => setOpenLeadId(null)} onChanged={() => runSearch()} />
      )}

      {searched && results.length === 0 && !error && (
        <div style={s.empty}>No leads matched &ldquo;{q}&rdquo; in this agency.</div>
      )}

      {results.length > 0 && (
        <div style={s.table}>
          {results.map((lead) => {
            const openable = canOpenFull(lead);
            const name = [lead.customer?.firstName, lead.customer?.lastName].filter(Boolean).join(' ') || 'Unnamed';
            return (
              <div key={lead.id}>
                <div style={{ ...s.row, cursor: 'pointer' }} onClick={() => handleRowClick(lead)}>
                  <div style={s.colName}>
                    {name}
                    {lead.archivedAt && <Badge tone="neutral" style={{ marginLeft: 8 }}>ARCHIVED</Badge>}
                  </div>
                  <div style={s.colContact}>{lead.customer?.phoneNormalized || '—'}</div>
                  <div style={s.colContact}>{lead.customer?.email || '—'}</div>
                  <div style={s.colStatus}><Badge tone={statusTone(lead.status)}>{lead.status}</Badge></div>
                  <div style={s.colAssigned}>{lead.assignedTo ? `${lead.assignedTo.firstName} ${lead.assignedTo.lastName}` : 'Unassigned'}</div>
                  <div style={s.colDate}>{new Date(lead.receivedAt).toLocaleDateString()}</div>
                </div>
                {!openable && expandedId === lead.id && (
                  <div style={s.expandedNote}>
                    Assigned to {lead.assignedTo ? `${lead.assignedTo.firstName} ${lead.assignedTo.lastName}` : 'no one yet'} — only they or a manager can open the full record.
                  </div>
                )}
              </div>
            );
          })}
        </div>
      )}
    </Card>
  );
}

const s = {
  searchRow: { display: 'flex', gap: 10, marginBottom: 8 },
  input: { flex: 1, padding: '10px 12px', background: 'var(--bg-sunken)', border: '1px solid var(--border-strong)', borderRadius: 6, color: 'var(--text-primary)', fontSize: 13 },
  error: { color: 'var(--danger)', fontSize: 12, marginBottom: 8 },
  empty: { color: 'var(--text-muted)', fontSize: 13, fontStyle: 'italic', padding: '8px 0' },
  table: { display: 'flex', flexDirection: 'column', marginTop: 10 },
  row: { display: 'grid', gridTemplateColumns: '1.3fr 1.1fr 1.3fr 110px 1.2fr 100px', gap: 10, padding: '10px 4px', fontSize: 13, color: 'var(--text-primary)', borderBottom: '1px solid var(--border-hairline)', alignItems: 'center' },
  colName: { fontWeight: 600, display: 'flex', alignItems: 'center' },
  colContact: { color: 'var(--text-secondary)' },
  colStatus: {},
  colAssigned: { color: 'var(--text-secondary)' },
  colDate: { color: 'var(--text-muted)', fontSize: 12 },
  expandedNote: { fontSize: 12, color: 'var(--text-muted)', padding: '0 4px 10px', fontStyle: 'italic' },
};
