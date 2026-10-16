import { useEffect, useState } from 'react';
import { api } from '../lib/api';
import { Card, SectionHeader, EmptyState, Badge } from '../ui';

// Main Stage dashboard widget wrapping the already-built Appointments
// capability (GET /appointments) — surfaces exactly what that route
// exists for: appointments needing owner attention (no eligible
// assignee, a stale/out-of-order sync event, etc.).
export default function AppointmentsBox() {
  const [appointments, setAppointments] = useState(null);
  const [error, setError] = useState('');

  useEffect(() => {
    api.appointments('?syncStatus=NEEDS_ATTENTION')
      .then((data) => setAppointments(data.appointments || []))
      .catch((err) => setError(err.data?.message || 'Could not load appointments.'));
  }, []);

  return (
    <Card>
      <SectionHeader>Appointments Needing Attention</SectionHeader>
      {error && <div style={s.error}>{error}</div>}
      {!appointments && !error && <div style={s.loading}>Loading…</div>}
      {appointments && appointments.length === 0 && (
        <EmptyState title="Nothing needs attention" description="Every appointment is syncing cleanly." />
      )}
      {appointments && appointments.length > 0 && appointments.map((a) => (
        <div key={a.id} style={s.row}>
          <div>
            <div style={s.name}>{a.lead?.customer?.firstName} {a.lead?.customer?.lastName}</div>
            <div style={s.meta}>
              {new Date(a.startAt).toLocaleString()} · {a.assignedTo ? `${a.assignedTo.firstName} ${a.assignedTo.lastName}` : 'Unassigned'}
            </div>
          </div>
          <Badge tone="warning">{a.syncIssue || a.syncStatus}</Badge>
        </div>
      ))}
    </Card>
  );
}

const s = {
  error: { color: 'var(--danger)', fontSize: 12, marginBottom: 10 },
  loading: { color: 'var(--text-muted)', fontSize: 13 },
  row: { display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 10, padding: '8px 0', borderBottom: '1px solid var(--border-hairline)' },
  name: { fontSize: 13, color: 'var(--text-secondary)', fontWeight: 600 },
  meta: { fontSize: 11, color: 'var(--text-muted)' },
};
