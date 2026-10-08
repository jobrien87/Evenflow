// My HR — the self-service page for Producer/Telemarketer: their own HR
// profile basics (Part A), and now their own timesheets (Part B — My
// Time). My Schedule/My Time Off are added once Part C ships — never
// shown as empty/fake tabs.
import { useEffect, useState } from 'react';
import { api } from '../../lib/api';
import { Card, SectionHeader, Badge, Button, EmptyState } from '../../ui';

function minutesToHours(minutes) {
  if (minutes == null) return '—';
  return (minutes / 60).toFixed(1);
}

export default function HrMyProfilePage() {
  const [employee, setEmployee] = useState(undefined);
  const [error, setError] = useState('');
  const [timesheets, setTimesheets] = useState(null);
  const [timeError, setTimeError] = useState('');

  useEffect(() => {
    api.hrMyEmployeeProfile()
      .then((data) => setEmployee(data.employee))
      .catch((err) => setError(err.data?.message || err.message || 'Could not load your HR profile.'));
    loadTimesheets();
  }, []);

  function loadTimesheets() {
    api.hrMyTimesheets()
      .then((data) => setTimesheets(data.timesheets))
      .catch((err) => setTimeError(err.data?.message || err.message || 'Could not load your timesheets.'));
  }

  async function submit(id) {
    try {
      await api.submitHrTimesheet(id);
      loadTimesheets();
    } catch (err) {
      setTimeError(err.data?.message || err.message || 'Could not submit this timesheet.');
    }
  }

  return (
    <div style={{ padding: 24, display: 'flex', flexDirection: 'column', gap: 16 }}>
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

      <Card>
        <SectionHeader>MY TIME</SectionHeader>
        {timeError && <EmptyState title="Could not load" description={timeError} />}
        {!timeError && timesheets === null && <div style={{ color: 'var(--text-muted)', fontSize: 13 }}>Loading…</div>}
        {!timeError && timesheets && timesheets.length === 0 && (
          <EmptyState description="No timesheet has been computed for you yet — ask your HR administrator." />
        )}
        {!timeError && timesheets && timesheets.length > 0 && (
          <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
            {timesheets.map((t) => (
              <div key={t.id} style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', padding: '10px 12px', background: 'var(--bg-sunken)', borderRadius: 'var(--radius-sm)' }}>
                <div>
                  <div style={{ fontWeight: 700, fontSize: 13 }}>
                    {new Date(t.periodStart).toLocaleDateString()} – {new Date(t.periodEnd).toLocaleDateString()}
                  </div>
                  <div style={{ fontSize: 12, color: 'var(--text-muted)' }}>
                    {minutesToHours(t.regularMinutes)}h regular{t.overtimeMinutes > 0 ? ` · ${minutesToHours(t.overtimeMinutes)}h OT` : ''}
                  </div>
                </div>
                <div style={{ display: 'flex', gap: 8, alignItems: 'center' }}>
                  <Badge tone={t.status === 'APPROVED' ? 'green' : t.status === 'REJECTED' ? 'danger' : 'neutral'}>{t.status}</Badge>
                  {t.status === 'OPEN' && <Button size="sm" onClick={() => submit(t.id)}>SUBMIT</Button>}
                </div>
              </div>
            ))}
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
