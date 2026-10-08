// My HR — the minimal Phase 1 Part A self-service page for
// Producer/Telemarketer: shows their own HR profile basics if one
// exists, or an honest "not set up yet" state otherwise. My Time/My
// Schedule/My Time Off are added once the phases that back them
// (Part B, Part C) actually ship — never shown as empty/fake tabs.
import { useEffect, useState } from 'react';
import { api } from '../../lib/api';
import { Card, SectionHeader, EmptyState } from '../../ui';

export default function HrMyProfilePage() {
  const [employee, setEmployee] = useState(undefined);
  const [error, setError] = useState('');

  useEffect(() => {
    api.hrMyEmployeeProfile()
      .then((data) => setEmployee(data.employee))
      .catch((err) => setError(err.data?.message || err.message || 'Could not load your HR profile.'));
  }, []);

  return (
    <div style={{ padding: 24 }}>
      <SectionHeader>MY HR</SectionHeader>
      <Card>
        {error && <EmptyState title="Could not load" description={error} />}
        {!error && employee === undefined && <div style={{ color: 'var(--text-muted)', fontSize: 13 }}>Loading…</div>}
        {!error && employee === null && (
          <EmptyState description="Your HR profile hasn't been set up yet. Your HR administrator will add it." />
        )}
        {!error && employee && (
          <div style={{ display: 'flex', flexDirection: 'column', gap: 10, fontSize: 13, color: 'var(--text-secondary)' }}>
            <Row label="Name" value={`${employee.user?.firstName || ''} ${employee.user?.lastName || ''}`.trim()} />
            <Row label="Employee Number" value={employee.employeeNumber || '—'} />
            <Row label="Department" value={employee.department?.name || '—'} />
            <Row label="Position" value={employee.position?.title || '—'} />
            <Row label="Manager" value={employee.manager ? `${employee.manager.firstName || ''} ${employee.manager.lastName || ''}`.trim() : '—'} />
            <Row label="Hire Date" value={employee.hireDate ? new Date(employee.hireDate).toLocaleDateString() : '—'} />
          </div>
        )}
      </Card>
    </div>
  );
}

function Row({ label, value }) {
  return (
    <div style={{ display: 'flex', justifyContent: 'space-between' }}>
      <span style={{ color: 'var(--text-muted)' }}>{label}</span>
      <span style={{ fontWeight: 600 }}>{value || '—'}</span>
    </div>
  );
}
