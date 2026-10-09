// Backstage HR — Phase 1 Part A admin dashboard: Overview, Employees,
// Departments, Settings (Legal Employers + HR Role Grants). Reached by
// Agency Owner/Manager at /agency/hr, and by Platform Owner for a
// specific agency at /platform/agencies/:agencyId/hr (agencyId passed in
// as a prop there, appended as a query param on every call — every
// other role is locked server-side to their own agency regardless of
// what's passed).
import { useEffect, useState } from 'react';
import { api } from '../../lib/api';
import { useAuth } from '../../lib/AuthContext';
import { Card, SectionHeader, Badge, Button, StatTile, EmptyState, Modal } from '../../ui';

const TABS = [
  { key: 'overview', label: 'OVERVIEW' },
  { key: 'employees', label: 'EMPLOYEES' },
  { key: 'departments', label: 'DEPARTMENTS' },
  { key: 'attendance', label: 'ATTENDANCE' },
  { key: 'timesheets', label: 'TIMESHEETS' },
  { key: 'schedule', label: 'SCHEDULE' },
  { key: 'leavePolicies', label: 'LEAVE POLICIES' },
  { key: 'leaveCalendar', label: 'LEAVE CALENDAR' },
  { key: 'settings', label: 'SETTINGS' },
];

const SWAP_STATUS_TONE = { PENDING: 'neutral', APPROVED: 'green', DENIED: 'danger', CANCELLED: 'neutral' };

function addDays(date, n) {
  const d = new Date(date);
  d.setUTCDate(d.getUTCDate() + n);
  return d;
}
function toDateInput(d) {
  return d.toISOString().slice(0, 10);
}
function startOfWeek(date) {
  const d = new Date(Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), date.getUTCDate()));
  const weekday = d.getUTCDay();
  const mondayOffset = weekday === 0 ? -6 : 1 - weekday;
  return addDays(d, mondayOffset);
}
// Always renders in the shift's own work time zone — never the
// viewer's browser-local zone. An Agency Owner reviewing a schedule
// isn't necessarily in the same time zone as the employee being
// scheduled, so "09:00 AM" here must mean 9am for that employee, not
// 9am wherever the browser happens to be. Caught by a real-browser
// pass: without an explicit timeZone, a shift resolved for 9am Eastern
// rendered as "01:00 PM" in a UTC-zoned browser.
function formatShiftTime(isoString, timeZone) {
  return new Date(isoString).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', timeZone: timeZone || 'America/New_York' });
}

const CLOCK_STATE_TONE = { CLOCKED_IN: 'green', ON_BREAK: 'lime', ON_LUNCH: 'lime', CLOCKED_OUT: 'neutral' };
const CLOCK_STATE_LABEL = { CLOCKED_IN: 'Clocked In', ON_BREAK: 'On Break', ON_LUNCH: 'On Lunch', CLOCKED_OUT: 'Clocked Out' };

function minutesToHours(minutes) {
  if (minutes == null) return '—';
  return (minutes / 60).toFixed(1);
}

const ONBOARDING_STATUSES = ['NOT_STARTED', 'IN_PROGRESS', 'COMPLETE'];
const OFFBOARDING_STATUSES = ['NOT_STARTED', 'IN_PROGRESS', 'COMPLETE'];

function fullName(u) {
  if (!u) return '—';
  return `${u.firstName || ''} ${u.lastName || ''}`.trim() || u.email;
}

export default function HrDashboardPage({ agencyId: agencyIdProp }) {
  const { user } = useAuth();
  const agencyId = agencyIdProp || '';
  const [tab, setTab] = useState('overview');
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState('');

  const [overview, setOverview] = useState(null);
  const [access, setAccess] = useState(null);
  const [employees, setEmployees] = useState([]);
  const [departments, setDepartments] = useState([]);
  const [positions, setPositions] = useState([]);
  const [legalEmployers, setLegalEmployers] = useState([]);
  const [roleGrants, setRoleGrants] = useState([]);
  const [agencyUsers, setAgencyUsers] = useState([]);
  const [noGrant, setNoGrant] = useState(false);

  useEffect(() => {
    load();
  }, [agencyId]);

  async function load() {
    setLoading(true);
    setLoadError('');
    setNoGrant(false);
    try {
      const [ov, emp, dept, pos, le, grants, users] = await Promise.all([
        api.hrOverview(agencyId),
        api.hrEmployees(agencyId ? `?agencyId=${agencyId}` : ''),
        api.hrDepartments(agencyId),
        api.hrPositions(agencyId),
        api.hrLegalEmployers(agencyId),
        api.hrRoleGrants(agencyId),
        api.users(agencyId ? `?agencyId=${agencyId}` : ''),
      ]);
      setOverview(ov.overview);
      setAccess(ov.access || null);
      setEmployees(emp.employees || []);
      setDepartments(dept.departments || []);
      setPositions(pos.positions || []);
      setLegalEmployers(le.legalEmployers || []);
      setRoleGrants(grants.grants || []);
      setAgencyUsers(users.users || []);
    } catch (err) {
      // A Manager with no HrRoleGrant yet hits this 403 by design — HR
      // access for a Manager is something the Agency Owner delegates
      // (see Settings > HR Role Grants), not an error to retry past.
      // Part C's own SCHEDULE/LEAVE CALENDAR tabs allow a plain manager
      // to act/view without a grant at the API level (see scheduling.js's
      // requireHrAdminOrManager and leave.js's open GET /leave/calendar),
      // but this page still fronts every tab behind one combined load —
      // reaching Backstage HR at all for a Manager requires at least an
      // HR_AUDITOR grant from the Agency Owner, by this app's own
      // deliberate design (see the commit that introduced `access`/
      // `noGrant`). A dedicated manager-facing schedule view outside this
      // gated dashboard would be a reasonable future follow-up, not
      // something this round changes.
      if (err.status === 403 && user?.role === 'AGENCY_MANAGER') {
        setNoGrant(true);
      } else {
        setLoadError(err.data?.message || err.message || 'Could not load Backstage HR.');
      }
    } finally {
      setLoading(false);
    }
  }

  if (loading) return <div style={{ padding: 24, color: 'var(--text-muted)' }}>Loading Backstage HR…</div>;
  if (noGrant) {
    return (
      <div style={{ padding: 24 }}>
        <EmptyState
          title="No Backstage HR access yet"
          description="Your Agency Owner hasn't granted you HR access. Ask them to grant you HR Admin (full access) or HR Auditor (read-only) from Backstage HR → Settings → HR Role Grants."
        />
      </div>
    );
  }
  if (loadError) {
    return (
      <div style={{ padding: 24 }}>
        <EmptyState title="Could not load Backstage HR" description={loadError} action={<Button size="sm" onClick={load}>RETRY</Button>} />
      </div>
    );
  }

  return (
    <div style={{ padding: 24, display: 'flex', flexDirection: 'column', gap: 20 }}>
      <SectionHeader
        right={
          <div style={{ display: 'flex', gap: 8 }}>
            {TABS.map((t) => (
              <Button key={t.key} size="sm" variant={tab === t.key ? 'primary' : 'secondary'} onClick={() => setTab(t.key)}>
                {t.label}
              </Button>
            ))}
          </div>
        }
      >
        BACKSTAGE HR
      </SectionHeader>

      {tab === 'overview' && <OverviewTab overview={overview} />}
      {tab === 'employees' && (
        <EmployeesTab
          employees={employees}
          departments={departments}
          positions={positions}
          legalEmployers={legalEmployers}
          agencyUsers={agencyUsers}
          agencyId={agencyId}
          currentUserId={user?.id}
          canWrite={!!access?.canWrite}
          onChange={load}
        />
      )}
      {tab === 'departments' && (
        <DepartmentsTab departments={departments} agencyUsers={agencyUsers} agencyId={agencyId} canWrite={!!access?.canWrite} onChange={load} />
      )}
      {tab === 'attendance' && <AttendanceTab canWrite={!!access?.canWrite} />}
      {tab === 'timesheets' && <TimesheetsTab employees={employees} agencyId={agencyId} canWrite={!!access?.canWrite} />}
      {tab === 'schedule' && <ScheduleTab employees={employees} departments={departments} agencyId={agencyId} canWrite={!!access?.canWrite} />}
      {tab === 'leavePolicies' && <LeavePoliciesTab employees={employees} agencyId={agencyId} canWrite={!!access?.canWrite} />}
      {tab === 'leaveCalendar' && <LeaveCalendarTab agencyId={agencyId} />}
      {tab === 'settings' && (
        <SettingsTab
          legalEmployers={legalEmployers}
          roleGrants={roleGrants}
          agencyUsers={agencyUsers}
          agencyId={agencyId}
          canWrite={!!access?.canWrite}
          canManageGrants={!!access?.canManageGrants}
          onChange={load}
        />
      )}
    </div>
  );
}

function OverviewTab({ overview }) {
  if (!overview) return <EmptyState description="No overview data yet." />;
  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 16 }}>
      <div style={{ display: 'flex', gap: 12, flexWrap: 'wrap' }}>
        <StatTile label="Active Employees" value={overview.activeEmployeeCount} tone="lime" />
        <StatTile label="Departments" value={overview.totalDepartments} tone="grey" />
        <StatTile label="Pending Onboarding" value={overview.pendingOnboardingCount} tone="green" />
        <StatTile label="Pending Offboarding" value={overview.pendingOffboardingCount} tone="grey" />
      </div>
      <Card>
        <SectionHeader>BY DEPARTMENT</SectionHeader>
        {overview.byDepartment.length === 0 ? (
          <EmptyState description="No active employee profiles yet." />
        ) : (
          <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
            {overview.byDepartment.map((d) => (
              <div key={d.departmentId || 'unassigned'} style={{ display: 'flex', justifyContent: 'space-between', fontSize: 13, color: 'var(--text-secondary)' }}>
                <span>{d.departmentName}</span>
                <span style={{ fontWeight: 700 }}>{d.count}</span>
              </div>
            ))}
          </div>
        )}
      </Card>
    </div>
  );
}

function EmployeesTab({ employees, departments, positions, legalEmployers, agencyUsers, agencyId, currentUserId, canWrite, onChange }) {
  const [search, setSearch] = useState('');
  const [expandedId, setExpandedId] = useState('');
  const [showCreate, setShowCreate] = useState(false);

  const filtered = employees.filter((e) => {
    if (!search.trim()) return true;
    const q = search.trim().toLowerCase();
    return fullName(e.user).toLowerCase().includes(q) || (e.user?.email || '').toLowerCase().includes(q);
  });

  const usersWithoutProfile = agencyUsers.filter((u) => !employees.some((e) => e.userId === u.id));

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 16 }}>
      <Card>
        <SectionHeader right={canWrite ? <Button size="sm" onClick={() => setShowCreate(true)}>+ ADD EMPLOYEE PROFILE</Button> : <Badge tone="neutral">READ-ONLY</Badge>}>EMPLOYEES</SectionHeader>
        <input
          placeholder="Search by name or email…"
          value={search}
          onChange={(e) => setSearch(e.target.value)}
          style={{ width: '100%', padding: '8px 12px', marginBottom: 12, background: 'var(--bg-sunken)', border: '1px solid var(--border-hairline)', borderRadius: 'var(--radius-sm)', color: 'var(--text-primary)' }}
        />
        {filtered.length === 0 ? (
          <EmptyState description="No HR employee profiles found." />
        ) : (
          <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
            {filtered.map((e) => (
              <div key={e.id}>
                <div
                  onClick={() => setExpandedId(expandedId === e.id ? '' : e.id)}
                  style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', padding: '10px 12px', background: 'var(--bg-sunken)', borderRadius: 'var(--radius-sm)', cursor: 'pointer' }}
                >
                  <div>
                    <div style={{ fontWeight: 700, fontSize: 13 }}>{fullName(e.user)}</div>
                    <div style={{ fontSize: 12, color: 'var(--text-muted)' }}>{e.department?.name || 'No department'} · {e.position?.title || 'No position'}</div>
                  </div>
                  <Badge tone={e.onboardingStatus === 'COMPLETE' ? 'green' : 'neutral'}>{e.onboardingStatus}</Badge>
                </div>
                {expandedId === e.id && (
                  <EmployeeDetail
                    employee={e}
                    departments={departments}
                    positions={positions}
                    legalEmployers={legalEmployers}
                    agencyUsers={agencyUsers}
                    canWrite={canWrite}
                    onChange={onChange}
                  />
                )}
              </div>
            ))}
          </div>
        )}
      </Card>

      {showCreate && canWrite && (
        <CreateEmployeeModal
          onClose={() => setShowCreate(false)}
          usersWithoutProfile={usersWithoutProfile}
          departments={departments}
          positions={positions}
          legalEmployers={legalEmployers}
          agencyId={agencyId}
          onCreated={() => {
            setShowCreate(false);
            onChange();
          }}
        />
      )}
    </div>
  );
}

function CreateEmployeeModal({ onClose, usersWithoutProfile, departments, positions, legalEmployers, agencyId, onCreated }) {
  const [userId, setUserId] = useState('');
  const [departmentId, setDepartmentId] = useState('');
  const [positionId, setPositionId] = useState('');
  const [legalEmployerId, setLegalEmployerId] = useState('');
  const [employeeNumber, setEmployeeNumber] = useState('');
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);

  async function submit() {
    if (!userId) { setError('Pick a user.'); return; }
    setBusy(true);
    setError('');
    try {
      await api.createHrEmployee({
        userId,
        agencyId: agencyId || undefined,
        departmentId: departmentId || undefined,
        positionId: positionId || undefined,
        legalEmployerId: legalEmployerId || undefined,
        employeeNumber: employeeNumber.trim() || undefined,
      });
      onCreated();
    } catch (err) {
      setError(err.data?.message || err.message || 'Could not create employee profile.');
    } finally {
      setBusy(false);
    }
  }

  return (
    <Modal title="Add Employee Profile" onClose={onClose}>
      <div style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
        <label style={{ fontSize: 12, color: 'var(--text-secondary)' }}>User</label>
        <select value={userId} onChange={(e) => setUserId(e.target.value)} style={selectStyle}>
          <option value="">Select a user with no HR profile yet…</option>
          {usersWithoutProfile.map((u) => (
            <option key={u.id} value={u.id}>{fullName(u)} ({u.role})</option>
          ))}
        </select>
        <label style={{ fontSize: 12, color: 'var(--text-secondary)' }}>Employee Number</label>
        <input value={employeeNumber} onChange={(e) => setEmployeeNumber(e.target.value)} style={inputStyle} placeholder="Optional" />
        <label style={{ fontSize: 12, color: 'var(--text-secondary)' }}>Department</label>
        <select value={departmentId} onChange={(e) => setDepartmentId(e.target.value)} style={selectStyle}>
          <option value="">None</option>
          {departments.map((d) => <option key={d.id} value={d.id}>{d.name}</option>)}
        </select>
        <label style={{ fontSize: 12, color: 'var(--text-secondary)' }}>Position</label>
        <select value={positionId} onChange={(e) => setPositionId(e.target.value)} style={selectStyle}>
          <option value="">None</option>
          {positions.map((p) => <option key={p.id} value={p.id}>{p.title}</option>)}
        </select>
        <label style={{ fontSize: 12, color: 'var(--text-secondary)' }}>Legal Employer</label>
        <select value={legalEmployerId} onChange={(e) => setLegalEmployerId(e.target.value)} style={selectStyle}>
          <option value="">None</option>
          {legalEmployers.map((le) => <option key={le.id} value={le.id}>{le.legalName}</option>)}
        </select>
        {error && <div style={{ color: 'var(--danger)', fontSize: 12 }}>{error}</div>}
        <Button onClick={submit} disabled={busy}>{busy ? 'CREATING…' : 'CREATE PROFILE'}</Button>
      </div>
    </Modal>
  );
}

function EmployeeDetail({ employee, departments, positions, legalEmployers, agencyUsers, canWrite, onChange }) {
  const [departmentId, setDepartmentId] = useState(employee.departmentId || '');
  const [positionId, setPositionId] = useState(employee.positionId || '');
  const [managerId, setManagerId] = useState(employee.managerId || '');
  const [onboardingStatus, setOnboardingStatus] = useState(employee.onboardingStatus);
  const [offboardingStatus, setOffboardingStatus] = useState(employee.offboardingStatus);
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const [history, setHistory] = useState(employee.employmentHistory || null);

  useEffect(() => {
    if (history === null) {
      api.hrEmployeeDetail(employee.id).then((data) => setHistory(data.employee?.employmentHistory || [])).catch(() => setHistory([]));
    }
  }, [employee.id]);

  async function save() {
    setBusy(true);
    setError('');
    try {
      await api.updateHrEmployee(employee.id, {
        version: employee.version,
        departmentId: departmentId || null,
        positionId: positionId || null,
        managerId: managerId || null,
        onboardingStatus,
        offboardingStatus,
      });
      onChange();
    } catch (err) {
      setError(err.data?.message || err.message || 'Could not save.');
    } finally {
      setBusy(false);
    }
  }

  return (
    <div style={{ padding: 16, background: 'var(--bg-elevated)', borderRadius: 'var(--radius-sm)', marginTop: 6, display: 'flex', flexDirection: 'column', gap: 10 }}>
      {canWrite ? (
        <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 10 }}>
          <div>
            <label style={labelStyle}>Department</label>
            <select value={departmentId} onChange={(e) => setDepartmentId(e.target.value)} style={selectStyle}>
              <option value="">None</option>
              {departments.map((d) => <option key={d.id} value={d.id}>{d.name}</option>)}
            </select>
          </div>
          <div>
            <label style={labelStyle}>Position</label>
            <select value={positionId} onChange={(e) => setPositionId(e.target.value)} style={selectStyle}>
              <option value="">None</option>
              {positions.map((p) => <option key={p.id} value={p.id}>{p.title}</option>)}
            </select>
          </div>
          <div>
            <label style={labelStyle}>Manager</label>
            <select value={managerId} onChange={(e) => setManagerId(e.target.value)} style={selectStyle}>
              <option value="">None</option>
              {agencyUsers.filter((u) => u.id !== employee.userId).map((u) => <option key={u.id} value={u.id}>{fullName(u)}</option>)}
            </select>
          </div>
          <div>
            <label style={labelStyle}>Onboarding</label>
            <select value={onboardingStatus} onChange={(e) => setOnboardingStatus(e.target.value)} style={selectStyle}>
              {ONBOARDING_STATUSES.map((s) => <option key={s} value={s}>{s}</option>)}
            </select>
          </div>
          <div>
            <label style={labelStyle}>Offboarding</label>
            <select value={offboardingStatus} onChange={(e) => setOffboardingStatus(e.target.value)} style={selectStyle}>
              {OFFBOARDING_STATUSES.map((s) => <option key={s} value={s}>{s}</option>)}
            </select>
          </div>
        </div>
      ) : (
        <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 10, fontSize: 13, color: 'var(--text-secondary)' }}>
          <div><span style={labelStyle}>Department</span>{departments.find((d) => d.id === departmentId)?.name || '—'}</div>
          <div><span style={labelStyle}>Position</span>{positions.find((p) => p.id === positionId)?.title || '—'}</div>
          <div><span style={labelStyle}>Manager</span>{fullName(agencyUsers.find((u) => u.id === managerId)) || '—'}</div>
          <div><span style={labelStyle}>Onboarding</span>{onboardingStatus}</div>
          <div><span style={labelStyle}>Offboarding</span>{offboardingStatus}</div>
        </div>
      )}
      {error && <div style={{ color: 'var(--danger)', fontSize: 12 }}>{error}</div>}
      {canWrite && <Button size="sm" onClick={save} disabled={busy}>{busy ? 'SAVING…' : 'SAVE CHANGES'}</Button>}

      <div style={{ marginTop: 8 }}>
        <div style={{ fontSize: 11, fontWeight: 700, color: 'var(--text-muted)', letterSpacing: 0.5, marginBottom: 6 }}>EMPLOYMENT HISTORY</div>
        {!history || history.length === 0 ? (
          <div style={{ fontSize: 12, color: 'var(--text-muted)', fontStyle: 'italic' }}>No history events yet.</div>
        ) : (
          <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
            {history.map((h) => (
              <div key={h.id} style={{ fontSize: 12, color: 'var(--text-secondary)' }}>
                {new Date(h.effectiveFrom).toLocaleDateString()} — {h.changeType} by {fullName(h.recordedBy)}
              </div>
            ))}
          </div>
        )}
      </div>
    </div>
  );
}

function DepartmentsTab({ departments, agencyUsers, agencyId, canWrite, onChange }) {
  const [showCreate, setShowCreate] = useState(false);
  const [name, setName] = useState('');
  const [parentDepartmentId, setParentDepartmentId] = useState('');
  const [managerId, setManagerId] = useState('');
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);

  async function createDepartment() {
    if (!name.trim()) { setError('Name is required.'); return; }
    setBusy(true);
    setError('');
    try {
      await api.createHrDepartment({
        name: name.trim(),
        agencyId: agencyId || undefined,
        parentDepartmentId: parentDepartmentId || undefined,
        managerId: managerId || undefined,
      });
      setName(''); setParentDepartmentId(''); setManagerId(''); setShowCreate(false);
      onChange();
    } catch (err) {
      setError(err.data?.message || err.message || 'Could not create department.');
    } finally {
      setBusy(false);
    }
  }

  async function toggleActive(dept) {
    try {
      await api.updateHrDepartment(dept.id, { isActive: !dept.isActive });
      onChange();
    } catch {
      // surfaced via the list simply not updating; acceptable for this round
    }
  }

  return (
    <Card>
      <SectionHeader right={canWrite ? <Button size="sm" onClick={() => setShowCreate((v) => !v)}>{showCreate ? 'CANCEL' : '+ ADD DEPARTMENT'}</Button> : <Badge tone="neutral">READ-ONLY</Badge>}>DEPARTMENTS</SectionHeader>
      {showCreate && canWrite && (
        <div style={{ display: 'flex', gap: 8, marginBottom: 14, flexWrap: 'wrap' }}>
          <input placeholder="Department name" value={name} onChange={(e) => setName(e.target.value)} style={{ ...inputStyle, flex: 1, minWidth: 160 }} />
          <select value={parentDepartmentId} onChange={(e) => setParentDepartmentId(e.target.value)} style={selectStyle}>
            <option value="">No parent</option>
            {departments.map((d) => <option key={d.id} value={d.id}>{d.name}</option>)}
          </select>
          <select value={managerId} onChange={(e) => setManagerId(e.target.value)} style={selectStyle}>
            <option value="">No manager</option>
            {agencyUsers.map((u) => <option key={u.id} value={u.id}>{fullName(u)}</option>)}
          </select>
          <Button size="sm" onClick={createDepartment} disabled={busy}>{busy ? 'ADDING…' : 'ADD'}</Button>
        </div>
      )}
      {error && <div style={{ color: 'var(--danger)', fontSize: 12, marginBottom: 10 }}>{error}</div>}
      {departments.length === 0 ? (
        <EmptyState description="No departments yet." />
      ) : (
        <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
          {departments.map((d) => (
            <div key={d.id} style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', padding: '10px 12px', background: 'var(--bg-sunken)', borderRadius: 'var(--radius-sm)' }}>
              <div>
                <div style={{ fontWeight: 700, fontSize: 13 }}>{d.name}{!d.isActive && <Badge tone="neutral" style={{ marginLeft: 8 }}>INACTIVE</Badge>}</div>
                <div style={{ fontSize: 12, color: 'var(--text-muted)' }}>
                  {d.parentDepartment ? `Under ${d.parentDepartment.name}` : 'Top-level'} · Manager: {d.manager ? fullName(d.manager) : 'None'}
                </div>
              </div>
              {canWrite && <Button size="sm" variant="secondary" onClick={() => toggleActive(d)}>{d.isActive ? 'DEACTIVATE' : 'REACTIVATE'}</Button>}
            </div>
          ))}
        </div>
      )}
    </Card>
  );
}

function SettingsTab({ legalEmployers, roleGrants, agencyUsers, agencyId, canWrite, canManageGrants, onChange }) {
  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 16 }}>
      <LegalEmployersCard legalEmployers={legalEmployers} agencyId={agencyId} canWrite={canWrite} onChange={onChange} />
      <RoleGrantsCard roleGrants={roleGrants} agencyUsers={agencyUsers} agencyId={agencyId} canManageGrants={canManageGrants} onChange={onChange} />
      <SchedulingSettingsCard canWrite={canWrite} />
    </div>
  );
}

function SchedulingSettingsCard({ canWrite }) {
  const [thresholdHours, setThresholdHours] = useState('');
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const [saved, setSaved] = useState(false);

  useEffect(() => {
    api.hrSchedulingSettings()
      .then((data) => setThresholdHours(String((data.settings?.weeklyOvertimeThresholdMinutes || 2400) / 60)))
      .catch((err) => setError(err.data?.message || err.message || 'Could not load scheduling settings.'));
  }, []);

  async function save() {
    setBusy(true);
    setError('');
    setSaved(false);
    try {
      await api.updateHrSchedulingSettings({ weeklyOvertimeThresholdMinutes: Math.round(Number(thresholdHours) * 60) });
      setSaved(true);
    } catch (err) {
      setError(err.data?.message || err.message || 'Could not save this setting.');
    } finally {
      setBusy(false);
    }
  }

  return (
    <Card>
      <SectionHeader>SCHEDULING</SectionHeader>
      <div style={{ fontSize: 12, color: 'var(--text-muted)', marginBottom: 12 }}>
        A plain weekly-hours heads-up used only to flag a shift that pushes someone over this threshold — not a jurisdiction-aware payroll overtime calculation.
      </div>
      {canWrite ? (
        <div style={{ display: 'flex', gap: 8, alignItems: 'center' }}>
          <label style={labelStyle}>Weekly Overtime Threshold (hours)</label>
          <input type="number" min="0" step="1" value={thresholdHours} onChange={(e) => setThresholdHours(e.target.value)} style={{ ...inputStyle, width: 90 }} />
          <Button size="sm" onClick={save} disabled={busy}>{busy ? 'SAVING…' : 'SAVE'}</Button>
          {saved && <span style={{ color: 'var(--success, #4caf50)', fontSize: 12 }}>Saved.</span>}
        </div>
      ) : (
        <div style={{ fontSize: 13, color: 'var(--text-secondary)' }}>Weekly Overtime Threshold: {thresholdHours || '—'} hours</div>
      )}
      {error && <div style={{ color: 'var(--danger)', fontSize: 12, marginTop: 8 }}>{error}</div>}
    </Card>
  );
}

function LegalEmployersCard({ legalEmployers, agencyId, canWrite, onChange }) {
  const [legalName, setLegalName] = useState('');
  const [jurisdictionCountry, setJurisdictionCountry] = useState('US');
  const [jurisdictionRegion, setJurisdictionRegion] = useState('');
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);

  async function create() {
    if (!legalName.trim()) { setError('Legal name is required.'); return; }
    setBusy(true);
    setError('');
    try {
      await api.createHrLegalEmployer({
        legalName: legalName.trim(),
        agencyId: agencyId || undefined,
        jurisdictionCountry,
        jurisdictionRegion: jurisdictionRegion.trim() || undefined,
      });
      setLegalName(''); setJurisdictionRegion('');
      onChange();
    } catch (err) {
      setError(err.data?.message || err.message || 'Could not create legal employer.');
    } finally {
      setBusy(false);
    }
  }

  return (
    <Card>
      <SectionHeader>LEGAL EMPLOYERS</SectionHeader>
      {canWrite && (
        <div style={{ display: 'flex', gap: 8, marginBottom: 14, flexWrap: 'wrap' }}>
          <input placeholder="Legal name" value={legalName} onChange={(e) => setLegalName(e.target.value)} style={{ ...inputStyle, flex: 1, minWidth: 160 }} />
          <input placeholder="Country (US)" value={jurisdictionCountry} onChange={(e) => setJurisdictionCountry(e.target.value.toUpperCase())} style={{ ...inputStyle, width: 90 }} maxLength={2} />
          <input placeholder="Region (optional)" value={jurisdictionRegion} onChange={(e) => setJurisdictionRegion(e.target.value)} style={{ ...inputStyle, width: 120 }} />
          <Button size="sm" onClick={create} disabled={busy}>{busy ? 'ADDING…' : 'ADD'}</Button>
        </div>
      )}
      {error && <div style={{ color: 'var(--danger)', fontSize: 12, marginBottom: 10 }}>{error}</div>}
      {legalEmployers.length === 0 ? (
        <EmptyState description="No legal employers configured yet." />
      ) : (
        <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
          {legalEmployers.map((le) => (
            <div key={le.id} style={{ fontSize: 13, color: 'var(--text-secondary)' }}>
              {le.legalName} — {le.jurisdictionCountry}{le.jurisdictionRegion ? `/${le.jurisdictionRegion}` : ''}
            </div>
          ))}
        </div>
      )}
    </Card>
  );
}

function RoleGrantsCard({ roleGrants, agencyUsers, agencyId, canManageGrants, onChange }) {
  const [userId, setUserId] = useState('');
  const [hrRole, setHrRole] = useState('HR_ADMIN');
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);

  async function grant() {
    if (!userId) { setError('Pick a user.'); return; }
    setBusy(true);
    setError('');
    try {
      await api.createHrRoleGrant({ userId, hrRole, agencyId: agencyId || undefined });
      setUserId('');
      onChange();
    } catch (err) {
      setError(err.data?.message || err.message || 'Could not grant HR role. Only an Agency Owner or Platform Owner can grant HR authority.');
    } finally {
      setBusy(false);
    }
  }

  async function revoke(grantId) {
    try {
      await api.revokeHrRoleGrant(grantId);
      onChange();
    } catch (err) {
      setError(err.data?.message || err.message || 'Could not revoke grant.');
    }
  }

  return (
    <Card>
      <SectionHeader>HR ROLE GRANTS</SectionHeader>
      <div style={{ fontSize: 12, color: 'var(--text-muted)', marginBottom: 12 }}>
        Delegates HR_ADMIN (full HR access) or HR_AUDITOR (read-only) to a teammate. Only an Agency Owner or Platform Owner can grant this.
      </div>
      {canManageGrants && (
        <div style={{ display: 'flex', gap: 8, marginBottom: 14, flexWrap: 'wrap' }}>
          <select value={userId} onChange={(e) => setUserId(e.target.value)} style={{ ...selectStyle, flex: 1, minWidth: 160 }}>
            <option value="">Select a user…</option>
            {agencyUsers.map((u) => <option key={u.id} value={u.id}>{fullName(u)}</option>)}
          </select>
          <select value={hrRole} onChange={(e) => setHrRole(e.target.value)} style={selectStyle}>
            <option value="HR_ADMIN">HR_ADMIN</option>
            <option value="HR_AUDITOR">HR_AUDITOR</option>
          </select>
          <Button size="sm" onClick={grant} disabled={busy}>{busy ? 'GRANTING…' : 'GRANT'}</Button>
        </div>
      )}
      {error && <div style={{ color: 'var(--danger)', fontSize: 12, marginBottom: 10 }}>{error}</div>}
      {roleGrants.length === 0 ? (
        <EmptyState description="No HR role grants yet." />
      ) : (
        <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
          {roleGrants.map((g) => (
            <div key={g.id} style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', padding: '8px 12px', background: 'var(--bg-sunken)', borderRadius: 'var(--radius-sm)' }}>
              <div style={{ fontSize: 13 }}>{fullName(g.user)} — <Badge tone="lime">{g.hrRole}</Badge></div>
              {canManageGrants && <Button size="sm" variant="danger" onClick={() => revoke(g.id)}>REVOKE</Button>}
            </div>
          ))}
        </div>
      )}
    </Card>
  );
}

function AttendanceTab({ canWrite }) {
  const [live, setLive] = useState(null);
  const [exceptions, setExceptions] = useState([]);
  const [error, setError] = useState('');
  const [reviewingId, setReviewingId] = useState('');
  const [reviewNote, setReviewNote] = useState('');

  useEffect(() => {
    load();
  }, []);

  async function load() {
    setError('');
    try {
      const [liveRes, exRes] = await Promise.all([
        api.hrAttendanceLive(),
        api.hrAttendanceExceptions('?status=OPEN'),
      ]);
      setLive(liveRes.live);
      setExceptions(exRes.exceptions);
    } catch (err) {
      setError(err.data?.message || err.message || 'Could not load attendance.');
    }
  }

  async function review(id, status) {
    try {
      await api.reviewHrAttendanceException(id, { status, reviewNote: reviewNote.trim() || undefined });
      setReviewingId('');
      setReviewNote('');
      load();
    } catch (err) {
      setError(err.data?.message || err.message || 'Could not review this exception.');
    }
  }

  if (error) return <EmptyState title="Could not load attendance" description={error} action={<Button size="sm" onClick={load}>RETRY</Button>} />;
  if (!live) return <div style={{ color: 'var(--text-muted)', fontSize: 13 }}>Loading…</div>;

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 16 }}>
      <Card>
        <SectionHeader>LIVE STATUS</SectionHeader>
        {live.length === 0 ? (
          <EmptyState description="No HR employee profiles yet." />
        ) : (
          <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
            {live.map((row) => (
              <div key={row.employeeProfileId} style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', padding: '8px 12px', background: 'var(--bg-sunken)', borderRadius: 'var(--radius-sm)' }}>
                <div>
                  <div style={{ fontWeight: 700, fontSize: 13 }}>{row.firstName} {row.lastName}</div>
                  <div style={{ fontSize: 12, color: 'var(--text-muted)' }}>{row.department?.name || 'No department'} · {row.position?.title || 'No position'}</div>
                </div>
                <Badge tone={CLOCK_STATE_TONE[row.state] || 'neutral'}>{CLOCK_STATE_LABEL[row.state] || row.state}</Badge>
              </div>
            ))}
          </div>
        )}
      </Card>

      <Card>
        <SectionHeader>ATTENDANCE EXCEPTIONS — OPEN</SectionHeader>
        <div style={{ fontSize: 12, color: 'var(--text-muted)', marginBottom: 12 }}>
          A detected pattern (e.g. a forgotten clock-out) — never auto-resolved. Review each one and mark it excused or unexcused.
        </div>
        {exceptions.length === 0 ? (
          <EmptyState description="No open attendance exceptions." />
        ) : (
          <div style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
            {exceptions.map((ex) => (
              <div key={ex.id} style={{ padding: '10px 12px', background: 'var(--bg-sunken)', borderRadius: 'var(--radius-sm)' }}>
                <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
                  <div style={{ fontSize: 13, fontWeight: 700 }}>{fullName(ex.employeeProfile?.user)} — {ex.exceptionType.replace(/_/g, ' ')}</div>
                  <div style={{ fontSize: 11, color: 'var(--text-muted)' }}>{new Date(ex.detectedAt).toLocaleString()}</div>
                </div>
                {!canWrite ? null : reviewingId === ex.id ? (
                  <div style={{ marginTop: 8, display: 'flex', flexDirection: 'column', gap: 8 }}>
                    <input placeholder="Review note (optional)" value={reviewNote} onChange={(e) => setReviewNote(e.target.value)} style={inputStyle} />
                    <div style={{ display: 'flex', gap: 8 }}>
                      <Button size="sm" onClick={() => review(ex.id, 'RESOLVED_EXCUSED')}>EXCUSE</Button>
                      <Button size="sm" variant="danger" onClick={() => review(ex.id, 'RESOLVED_UNEXCUSED')}>UNEXCUSED</Button>
                      <Button size="sm" variant="secondary" onClick={() => { setReviewingId(''); setReviewNote(''); }}>CANCEL</Button>
                    </div>
                  </div>
                ) : (
                  <Button size="sm" variant="secondary" style={{ marginTop: 8 }} onClick={() => setReviewingId(ex.id)}>REVIEW</Button>
                )}
              </div>
            ))}
          </div>
        )}
      </Card>
    </div>
  );
}

function TimesheetsTab({ employees, agencyId, canWrite }) {
  const [timesheets, setTimesheets] = useState([]);
  const [error, setError] = useState('');
  const [employeeProfileId, setEmployeeProfileId] = useState('');
  const [periodStart, setPeriodStart] = useState('');
  const [periodEnd, setPeriodEnd] = useState('');
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    load();
  }, []);

  async function load() {
    setError('');
    try {
      const data = await api.hrTimesheets(agencyId ? `?agencyId=${agencyId}` : '');
      setTimesheets(data.timesheets);
    } catch (err) {
      setError(err.data?.message || err.message || 'Could not load timesheets.');
    }
  }

  async function compute() {
    if (!employeeProfileId || !periodStart || !periodEnd) { setError('Pick an employee and a period.'); return; }
    setBusy(true);
    setError('');
    try {
      await api.computeHrTimesheet({ employeeProfileId, periodStart, periodEnd, agencyId: agencyId || undefined });
      load();
    } catch (err) {
      setError(err.data?.message || err.message || 'Could not compute this timesheet.');
    } finally {
      setBusy(false);
    }
  }

  async function decide(id, action) {
    try {
      if (action === 'approve') await api.approveHrTimesheet(id);
      else await api.rejectHrTimesheet(id);
      load();
    } catch (err) {
      setError(err.data?.message || err.message || `Could not ${action} this timesheet.`);
    }
  }

  return (
    <Card>
      <SectionHeader>TIMESHEETS</SectionHeader>
      {canWrite && (
        <div style={{ display: 'flex', gap: 8, marginBottom: 14, flexWrap: 'wrap', alignItems: 'center' }}>
          <select value={employeeProfileId} onChange={(e) => setEmployeeProfileId(e.target.value)} style={inputStyle}>
            <option value="">Select employee…</option>
            {employees.map((e) => <option key={e.id} value={e.id}>{fullName(e.user)}</option>)}
          </select>
          <input type="date" value={periodStart} onChange={(e) => setPeriodStart(e.target.value)} style={inputStyle} />
          <span style={{ color: 'var(--text-muted)', fontSize: 12 }}>to</span>
          <input type="date" value={periodEnd} onChange={(e) => setPeriodEnd(e.target.value)} style={inputStyle} />
          <Button size="sm" onClick={compute} disabled={busy}>{busy ? 'COMPUTING…' : 'COMPUTE'}</Button>
        </div>
      )}
      {error && <div style={{ color: 'var(--danger)', fontSize: 12, marginBottom: 10 }}>{error}</div>}
      {timesheets.length === 0 ? (
        <EmptyState description="No timesheets computed yet." />
      ) : (
        <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
          {timesheets.map((t) => (
            <div key={t.id} style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', padding: '10px 12px', background: 'var(--bg-sunken)', borderRadius: 'var(--radius-sm)' }}>
              <div>
                <div style={{ fontWeight: 700, fontSize: 13 }}>{fullName(t.employeeProfile?.user)}</div>
                <div style={{ fontSize: 12, color: 'var(--text-muted)' }}>
                  {new Date(t.periodStart).toLocaleDateString()} – {new Date(t.periodEnd).toLocaleDateString()} · {minutesToHours(t.regularMinutes)}h regular
                  {t.overtimeMinutes > 0 ? ` · ${minutesToHours(t.overtimeMinutes)}h OT` : ''}
                </div>
              </div>
              <div style={{ display: 'flex', gap: 8, alignItems: 'center' }}>
                <Badge tone={t.status === 'APPROVED' ? 'green' : t.status === 'REJECTED' ? 'danger' : 'neutral'}>{t.status}</Badge>
                {canWrite && t.status === 'SUBMITTED' && (
                  <>
                    <Button size="sm" onClick={() => decide(t.id, 'approve')}>APPROVE</Button>
                    <Button size="sm" variant="danger" onClick={() => decide(t.id, 'reject')}>REJECT</Button>
                  </>
                )}
              </div>
            </div>
          ))}
        </div>
      )}
    </Card>
  );
}

function ScheduleTab({ employees, departments, agencyId, canWrite }) {
  const [weekStart, setWeekStart] = useState(() => startOfWeek(new Date()));
  const [shifts, setShifts] = useState([]);
  const [templates, setTemplates] = useState([]);
  const [swapRequests, setSwapRequests] = useState([]);
  const [error, setError] = useState('');
  const [showCreate, setShowCreate] = useState(false);
  const [showTemplateCreate, setShowTemplateCreate] = useState(false);

  useEffect(() => {
    load();
  }, [weekStart, agencyId]);

  async function load() {
    setError('');
    try {
      const weekEnd = addDays(weekStart, 6);
      const [shiftsRes, templatesRes, swapRes] = await Promise.all([
        api.hrSchedule(`?start=${toDateInput(weekStart)}&end=${toDateInput(weekEnd)}${agencyId ? `&agencyId=${agencyId}` : ''}`),
        api.hrShiftTemplates(agencyId),
        api.hrSwapRequests(`?status=PENDING${agencyId ? `&agencyId=${agencyId}` : ''}`),
      ]);
      setShifts(shiftsRes.shifts || []);
      setTemplates(templatesRes.shiftTemplates || []);
      setSwapRequests(swapRes.swapRequests || []);
    } catch (err) {
      setError(err.data?.message || err.message || 'Could not load the schedule.');
    }
  }

  async function decideSwap(id, action) {
    try {
      if (action === 'approve') await api.approveHrSwapRequest(id, {});
      else await api.denyHrSwapRequest(id);
      load();
    } catch (err) {
      setError(err.data?.message || err.message || `Could not ${action} this swap request.`);
    }
  }

  async function cancelShift(id) {
    try {
      await api.cancelHrShift(id);
      load();
    } catch (err) {
      setError(err.data?.message || err.message || 'Could not cancel this shift.');
    }
  }

  const days = Array.from({ length: 7 }, (_, i) => addDays(weekStart, i));
  const shiftsByDay = days.map((d) => ({
    date: d,
    shifts: shifts.filter((s) => s.workDate.slice(0, 10) === toDateInput(d)),
  }));

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 16 }}>
      <Card>
        <SectionHeader
          right={
            <div style={{ display: 'flex', gap: 8 }}>
              <Button size="sm" variant="secondary" onClick={() => setWeekStart(addDays(weekStart, -7))}>&larr; PREV WEEK</Button>
              <Button size="sm" variant="secondary" onClick={() => setWeekStart(startOfWeek(new Date()))}>THIS WEEK</Button>
              <Button size="sm" variant="secondary" onClick={() => setWeekStart(addDays(weekStart, 7))}>NEXT WEEK &rarr;</Button>
              {canWrite && <Button size="sm" variant="secondary" onClick={() => setShowTemplateCreate(true)}>+ SHIFT TEMPLATE</Button>}
              {canWrite && <Button size="sm" onClick={() => setShowCreate(true)}>+ ADD SHIFT</Button>}
            </div>
          }
        >
          SCHEDULE — {weekStart.toLocaleDateString()} – {addDays(weekStart, 6).toLocaleDateString()}
        </SectionHeader>
        {error && <div style={{ color: 'var(--danger)', fontSize: 12, marginBottom: 10 }}>{error}</div>}
        <div style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
          {shiftsByDay.map(({ date, shifts: dayShifts }) => (
            <div key={toDateInput(date)}>
              <div style={{ fontSize: 11, fontWeight: 700, color: 'var(--text-muted)', letterSpacing: 0.5, marginBottom: 4 }}>
                {date.toLocaleDateString(undefined, { weekday: 'long', month: 'short', day: 'numeric' })}
              </div>
              {dayShifts.length === 0 ? (
                <div style={{ fontSize: 12, color: 'var(--text-muted)', fontStyle: 'italic', padding: '4px 12px' }}>No shifts scheduled.</div>
              ) : (
                <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
                  {dayShifts.map((s) => (
                    <div key={s.id} style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', padding: '8px 12px', background: 'var(--bg-sunken)', borderRadius: 'var(--radius-sm)' }}>
                      <div>
                        <div style={{ fontWeight: 700, fontSize: 13 }}>{fullName(s.employeeProfile?.user)}</div>
                        <div style={{ fontSize: 12, color: 'var(--text-muted)' }}>
                          {formatShiftTime(s.startAt, s.employeeProfile?.workTimeZone)} – {formatShiftTime(s.endAt, s.employeeProfile?.workTimeZone)}
                          {s.shiftTemplate ? ` · ${s.shiftTemplate.name}` : ''}
                        </div>
                      </div>
                      <div style={{ display: 'flex', gap: 8, alignItems: 'center' }}>
                        <Badge tone={s.status === 'COVERED' ? 'lime' : s.status === 'SWAPPED' ? 'neutral' : 'green'}>{s.status}</Badge>
                        {canWrite && <Button size="sm" variant="danger" onClick={() => cancelShift(s.id)}>CANCEL</Button>}
                      </div>
                    </div>
                  ))}
                </div>
              )}
            </div>
          ))}
        </div>
      </Card>

      <Card>
        <SectionHeader>PENDING SWAP REQUESTS</SectionHeader>
        {swapRequests.length === 0 ? (
          <EmptyState description="No pending swap requests." />
        ) : (
          <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
            {swapRequests.map((sr) => (
              <div key={sr.id} style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', padding: '10px 12px', background: 'var(--bg-sunken)', borderRadius: 'var(--radius-sm)' }}>
                <div>
                  <div style={{ fontWeight: 700, fontSize: 13 }}>{fullName(sr.shiftAssignment?.employeeProfile?.user)} — {new Date(sr.shiftAssignment?.workDate).toLocaleDateString()}</div>
                  <div style={{ fontSize: 12, color: 'var(--text-muted)' }}>{sr.reason || 'No reason given'}</div>
                </div>
                <div style={{ display: 'flex', gap: 8 }}>
                  <Badge tone={SWAP_STATUS_TONE[sr.status]}>{sr.status}</Badge>
                  {canWrite && <Button size="sm" onClick={() => decideSwap(sr.id, 'approve')}>APPROVE</Button>}
                  {canWrite && <Button size="sm" variant="danger" onClick={() => decideSwap(sr.id, 'deny')}>DENY</Button>}
                </div>
              </div>
            ))}
          </div>
        )}
      </Card>

      {showCreate && canWrite && (
        <CreateShiftModal
          employees={employees}
          templates={templates}
          agencyId={agencyId}
          onClose={() => setShowCreate(false)}
          onCreated={() => { setShowCreate(false); load(); }}
        />
      )}
      {showTemplateCreate && canWrite && (
        <CreateShiftTemplateModal
          departments={departments}
          agencyId={agencyId}
          onClose={() => setShowTemplateCreate(false)}
          onCreated={() => { setShowTemplateCreate(false); load(); }}
        />
      )}
    </div>
  );
}

function CreateShiftModal({ employees, templates, agencyId, onClose, onCreated }) {
  const [employeeProfileId, setEmployeeProfileId] = useState('');
  const [shiftTemplateId, setShiftTemplateId] = useState('');
  const [startTime, setStartTime] = useState('09:00');
  const [endTime, setEndTime] = useState('17:00');
  const [workDate, setWorkDate] = useState(toDateInput(new Date()));
  const [useTemplate, setUseTemplate] = useState(true);
  const [error, setError] = useState('');
  const [warnings, setWarnings] = useState([]);
  const [busy, setBusy] = useState(false);

  async function submit() {
    if (!employeeProfileId || !workDate) { setError('Pick an employee and a date.'); return; }
    setBusy(true);
    setError('');
    try {
      const payload = { employeeProfileId, workDate, agencyId: agencyId || undefined };
      if (useTemplate && shiftTemplateId) payload.shiftTemplateId = shiftTemplateId;
      else { payload.startTime = startTime; payload.endTime = endTime; }
      const res = await api.createHrShift(payload);
      if (res.warnings?.length) setWarnings(res.warnings);
      else onCreated();
      if (res.warnings?.length) setTimeout(onCreated, 1200);
    } catch (err) {
      setError(err.data?.message || err.message || 'Could not create this shift.');
    } finally {
      setBusy(false);
    }
  }

  return (
    <Modal title="Add Shift" onClose={onClose}>
      <div style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
        <label style={labelStyle}>Employee</label>
        <select value={employeeProfileId} onChange={(e) => setEmployeeProfileId(e.target.value)} style={selectStyle}>
          <option value="">Select employee…</option>
          {employees.map((e) => <option key={e.id} value={e.id}>{fullName(e.user)}</option>)}
        </select>
        <label style={labelStyle}>Date</label>
        <input type="date" value={workDate} onChange={(e) => setWorkDate(e.target.value)} style={inputStyle} />
        <label style={{ display: 'flex', alignItems: 'center', gap: 6, fontSize: 12, color: 'var(--text-secondary)' }}>
          <input type="checkbox" checked={useTemplate} onChange={(e) => setUseTemplate(e.target.checked)} /> Use a shift template
        </label>
        {useTemplate ? (
          <select value={shiftTemplateId} onChange={(e) => setShiftTemplateId(e.target.value)} style={selectStyle}>
            <option value="">Select template…</option>
            {templates.map((t) => <option key={t.id} value={t.id}>{t.name} ({t.startTime}–{t.endTime})</option>)}
          </select>
        ) : (
          <div style={{ display: 'flex', gap: 8 }}>
            <input type="time" value={startTime} onChange={(e) => setStartTime(e.target.value)} style={inputStyle} />
            <input type="time" value={endTime} onChange={(e) => setEndTime(e.target.value)} style={inputStyle} />
          </div>
        )}
        {error && <div style={{ color: 'var(--danger)', fontSize: 12 }}>{error}</div>}
        {warnings.length > 0 && (
          <div style={{ color: 'var(--warning, #c99a2f)', fontSize: 12 }}>
            {warnings.includes('SHIFT_OVERLAPS_APPROVED_LEAVE') && <div>Heads up: this shift overlaps an approved leave request for this employee.</div>}
            {warnings.includes('WEEKLY_OVERTIME_THRESHOLD_EXCEEDED') && <div>Heads up: this puts the employee over the weekly scheduling threshold.</div>}
            <div style={{ color: 'var(--text-muted)', marginTop: 4 }}>The shift was still created — closing…</div>
          </div>
        )}
        <Button onClick={submit} disabled={busy}>{busy ? 'ADDING…' : 'ADD SHIFT'}</Button>
      </div>
    </Modal>
  );
}

function CreateShiftTemplateModal({ departments, agencyId, onClose, onCreated }) {
  const [name, setName] = useState('');
  const [startTime, setStartTime] = useState('09:00');
  const [endTime, setEndTime] = useState('17:00');
  const [departmentId, setDepartmentId] = useState('');
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);

  async function submit() {
    if (!name.trim()) { setError('Name is required.'); return; }
    setBusy(true);
    setError('');
    try {
      await api.createHrShiftTemplate({ name: name.trim(), startTime, endTime, departmentId: departmentId || undefined, agencyId: agencyId || undefined });
      onCreated();
    } catch (err) {
      setError(err.data?.message || err.message || 'Could not create this shift template.');
    } finally {
      setBusy(false);
    }
  }

  return (
    <Modal title="Add Shift Template" onClose={onClose}>
      <div style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
        <label style={labelStyle}>Name</label>
        <input value={name} onChange={(e) => setName(e.target.value)} style={inputStyle} placeholder="e.g. Day Shift" />
        <div style={{ display: 'flex', gap: 8 }}>
          <input type="time" value={startTime} onChange={(e) => setStartTime(e.target.value)} style={inputStyle} />
          <input type="time" value={endTime} onChange={(e) => setEndTime(e.target.value)} style={inputStyle} />
        </div>
        <label style={labelStyle}>Department (optional)</label>
        <select value={departmentId} onChange={(e) => setDepartmentId(e.target.value)} style={selectStyle}>
          <option value="">None</option>
          {departments.map((d) => <option key={d.id} value={d.id}>{d.name}</option>)}
        </select>
        {error && <div style={{ color: 'var(--danger)', fontSize: 12 }}>{error}</div>}
        <Button onClick={submit} disabled={busy}>{busy ? 'ADDING…' : 'ADD TEMPLATE'}</Button>
      </div>
    </Modal>
  );
}

function LeavePoliciesTab({ employees, agencyId, canWrite }) {
  const [leaveTypes, setLeaveTypes] = useState([]);
  const [policies, setPolicies] = useState([]);
  const [requests, setRequests] = useState([]);
  const [error, setError] = useState('');
  const [showTypeCreate, setShowTypeCreate] = useState(false);
  const [showPolicyCreate, setShowPolicyCreate] = useState(false);
  const [showAssign, setShowAssign] = useState(false);

  useEffect(() => {
    load();
  }, [agencyId]);

  async function load() {
    setError('');
    try {
      const [typesRes, policiesRes, requestsRes] = await Promise.all([
        api.hrLeaveTypes(),
        api.hrLeavePolicies(),
        api.hrLeaveRequests('?status=PENDING'),
      ]);
      setLeaveTypes(typesRes.leaveTypes || []);
      setPolicies(policiesRes.policies || []);
      setRequests(requestsRes.requests || []);
    } catch (err) {
      setError(err.data?.message || err.message || 'Could not load leave policies.');
    }
  }

  async function decideRequest(id, action) {
    try {
      if (action === 'approve') await api.approveHrLeaveRequest(id);
      else await api.denyHrLeaveRequest(id, {});
      load();
    } catch (err) {
      setError(err.data?.message || err.message || `Could not ${action} this request.`);
    }
  }

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 16 }}>
      {error && <div style={{ color: 'var(--danger)', fontSize: 12 }}>{error}</div>}

      <Card>
        <SectionHeader>PENDING LEAVE REQUESTS</SectionHeader>
        <div style={{ fontSize: 12, color: 'var(--text-muted)', marginBottom: 12 }}>
          A protected leave type (e.g. FMLA) is never auto-approved or auto-denied by a balance check — review it the same as any other request.
        </div>
        {requests.length === 0 ? (
          <EmptyState description="No pending leave requests." />
        ) : (
          <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
            {requests.map((r) => (
              <div key={r.id} style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', padding: '10px 12px', background: 'var(--bg-sunken)', borderRadius: 'var(--radius-sm)' }}>
                <div>
                  <div style={{ fontWeight: 700, fontSize: 13 }}>
                    {fullName(r.employeeProfile?.user)} — {r.leaveType.name}{r.leaveType.isProtected && <Badge tone="lime" style={{ marginLeft: 6 }}>PROTECTED</Badge>}
                  </div>
                  <div style={{ fontSize: 12, color: 'var(--text-muted)' }}>
                    {new Date(r.startDate).toLocaleDateString()} – {new Date(r.endDate).toLocaleDateString()} · {minutesToHours(r.requestedMinutes)}h{r.note ? ` · "${r.note}"` : ''}
                  </div>
                </div>
                <div style={{ display: 'flex', gap: 8 }}>
                  {canWrite && <Button size="sm" onClick={() => decideRequest(r.id, 'approve')}>APPROVE</Button>}
                  {canWrite && <Button size="sm" variant="danger" onClick={() => decideRequest(r.id, 'deny')}>DENY</Button>}
                </div>
              </div>
            ))}
          </div>
        )}
      </Card>

      <Card>
        <SectionHeader right={canWrite ? <Button size="sm" onClick={() => setShowTypeCreate(true)}>+ LEAVE TYPE</Button> : <Badge tone="neutral">READ-ONLY</Badge>}>LEAVE TYPES</SectionHeader>
        {leaveTypes.length === 0 ? (
          <EmptyState description="No leave types configured yet." />
        ) : (
          <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
            {leaveTypes.map((lt) => (
              <div key={lt.id} style={{ fontSize: 13, color: 'var(--text-secondary)', display: 'flex', gap: 8, alignItems: 'center' }}>
                {lt.name} <Badge tone={lt.isPaid ? 'green' : 'neutral'}>{lt.isPaid ? 'PAID' : 'UNPAID'}</Badge>
                {lt.isProtected && <Badge tone="lime">PROTECTED</Badge>}
              </div>
            ))}
          </div>
        )}
      </Card>

      <Card>
        <SectionHeader right={canWrite ? <div style={{ display: 'flex', gap: 8 }}><Button size="sm" variant="secondary" onClick={() => setShowAssign(true)}>ASSIGN EMPLOYEE</Button><Button size="sm" onClick={() => setShowPolicyCreate(true)}>+ POLICY</Button></div> : <Badge tone="neutral">READ-ONLY</Badge>}>
          LEAVE POLICIES
        </SectionHeader>
        {policies.length === 0 ? (
          <EmptyState description="No leave policies configured yet." />
        ) : (
          <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
            {policies.map((p) => (
              <div key={p.id} style={{ fontSize: 13, color: 'var(--text-secondary)' }}>
                {p.name} — {p.leaveType.name} · {p.accrualMethod}
                {p.accrualAmountMinutes ? ` · ${minutesToHours(p.accrualAmountMinutes)}h/period` : ''}
                {p.annualCapMinutes ? ` · cap ${minutesToHours(p.annualCapMinutes)}h/yr` : ''}
              </div>
            ))}
          </div>
        )}
      </Card>

      {showTypeCreate && canWrite && (
        <CreateLeaveTypeModal onClose={() => setShowTypeCreate(false)} onCreated={() => { setShowTypeCreate(false); load(); }} />
      )}
      {showPolicyCreate && canWrite && (
        <CreateLeavePolicyModal leaveTypes={leaveTypes} onClose={() => setShowPolicyCreate(false)} onCreated={() => { setShowPolicyCreate(false); load(); }} />
      )}
      {showAssign && canWrite && (
        <AssignLeavePolicyModal employees={employees} policies={policies} onClose={() => setShowAssign(false)} onCreated={() => setShowAssign(false)} />
      )}
    </div>
  );
}

function CreateLeaveTypeModal({ onClose, onCreated }) {
  const [name, setName] = useState('');
  const [isPaid, setIsPaid] = useState(true);
  const [isProtected, setIsProtected] = useState(false);
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);

  async function submit() {
    if (!name.trim()) { setError('Name is required.'); return; }
    setBusy(true);
    setError('');
    try {
      await api.createHrLeaveType({ name: name.trim(), isPaid, isProtected });
      onCreated();
    } catch (err) {
      setError(err.data?.message || err.message || 'Could not create this leave type.');
    } finally {
      setBusy(false);
    }
  }

  return (
    <Modal title="Add Leave Type" onClose={onClose}>
      <div style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
        <label style={labelStyle}>Name</label>
        <input value={name} onChange={(e) => setName(e.target.value)} style={inputStyle} placeholder="e.g. Vacation, Sick, FMLA" />
        <label style={{ display: 'flex', alignItems: 'center', gap: 6, fontSize: 12, color: 'var(--text-secondary)' }}>
          <input type="checkbox" checked={isPaid} onChange={(e) => setIsPaid(e.target.checked)} /> Paid
        </label>
        <label style={{ display: 'flex', alignItems: 'center', gap: 6, fontSize: 12, color: 'var(--text-secondary)' }}>
          <input type="checkbox" checked={isProtected} onChange={(e) => setIsProtected(e.target.checked)} /> Protected (e.g. FMLA) — skips balance-denial, flagged for manual HR review, redacted on the team calendar
        </label>
        {error && <div style={{ color: 'var(--danger)', fontSize: 12 }}>{error}</div>}
        <Button onClick={submit} disabled={busy}>{busy ? 'ADDING…' : 'ADD LEAVE TYPE'}</Button>
      </div>
    </Modal>
  );
}

function CreateLeavePolicyModal({ leaveTypes, onClose, onCreated }) {
  const [leaveTypeId, setLeaveTypeId] = useState('');
  const [name, setName] = useState('');
  const [accrualMethod, setAccrualMethod] = useState('FRONT_LOADED');
  const [accrualAmountHours, setAccrualAmountHours] = useState('');
  const [annualCapHours, setAnnualCapHours] = useState('');
  const [carryoverCapHours, setCarryoverCapHours] = useState('');
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);

  async function submit() {
    if (!leaveTypeId || !name.trim()) { setError('Leave type and name are required.'); return; }
    setBusy(true);
    setError('');
    try {
      await api.createHrLeavePolicy({
        leaveTypeId, name: name.trim(), accrualMethod,
        accrualAmountMinutes: accrualAmountHours ? Math.round(Number(accrualAmountHours) * 60) : undefined,
        annualCapMinutes: annualCapHours ? Math.round(Number(annualCapHours) * 60) : undefined,
        carryoverCapMinutes: carryoverCapHours ? Math.round(Number(carryoverCapHours) * 60) : undefined,
      });
      onCreated();
    } catch (err) {
      setError(err.data?.message || err.message || 'Could not create this policy.');
    } finally {
      setBusy(false);
    }
  }

  return (
    <Modal title="Add Leave Policy" onClose={onClose}>
      <div style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
        <label style={labelStyle}>Leave Type</label>
        <select value={leaveTypeId} onChange={(e) => setLeaveTypeId(e.target.value)} style={selectStyle}>
          <option value="">Select leave type…</option>
          {leaveTypes.map((lt) => <option key={lt.id} value={lt.id}>{lt.name}</option>)}
        </select>
        <label style={labelStyle}>Policy Name</label>
        <input value={name} onChange={(e) => setName(e.target.value)} style={inputStyle} placeholder="e.g. Standard Vacation" />
        <label style={labelStyle}>Accrual Method</label>
        <select value={accrualMethod} onChange={(e) => setAccrualMethod(e.target.value)} style={selectStyle}>
          <option value="FRONT_LOADED">Front-loaded (once per year)</option>
          <option value="PER_PAY_PERIOD">Per pay period (semi-monthly)</option>
          <option value="PER_HOUR_WORKED">Per hour worked</option>
        </select>
        <label style={labelStyle}>{accrualMethod === 'PER_HOUR_WORKED' ? 'Hours earned per hour worked' : 'Hours per accrual'}</label>
        <input type="number" min="0" step="0.1" value={accrualAmountHours} onChange={(e) => setAccrualAmountHours(e.target.value)} style={inputStyle} />
        <label style={labelStyle}>Annual Cap (hours, optional)</label>
        <input type="number" min="0" step="0.1" value={annualCapHours} onChange={(e) => setAnnualCapHours(e.target.value)} style={inputStyle} />
        <label style={labelStyle}>Carryover Cap (hours, optional)</label>
        <input type="number" min="0" step="0.1" value={carryoverCapHours} onChange={(e) => setCarryoverCapHours(e.target.value)} style={inputStyle} />
        {error && <div style={{ color: 'var(--danger)', fontSize: 12 }}>{error}</div>}
        <Button onClick={submit} disabled={busy}>{busy ? 'ADDING…' : 'ADD POLICY'}</Button>
      </div>
    </Modal>
  );
}

function AssignLeavePolicyModal({ employees, policies, onClose, onCreated }) {
  const [employeeProfileId, setEmployeeProfileId] = useState('');
  const [leavePolicyId, setLeavePolicyId] = useState('');
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);

  async function submit() {
    if (!employeeProfileId || !leavePolicyId) { setError('Pick an employee and a policy.'); return; }
    setBusy(true);
    setError('');
    try {
      await api.createHrLeavePolicyAssignment({ employeeProfileId, leavePolicyId });
      onCreated();
    } catch (err) {
      setError(err.data?.message || err.message || 'Could not assign this policy.');
    } finally {
      setBusy(false);
    }
  }

  return (
    <Modal title="Assign Leave Policy" onClose={onClose}>
      <div style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
        <label style={labelStyle}>Employee</label>
        <select value={employeeProfileId} onChange={(e) => setEmployeeProfileId(e.target.value)} style={selectStyle}>
          <option value="">Select employee…</option>
          {employees.map((e) => <option key={e.id} value={e.id}>{fullName(e.user)}</option>)}
        </select>
        <label style={labelStyle}>Policy</label>
        <select value={leavePolicyId} onChange={(e) => setLeavePolicyId(e.target.value)} style={selectStyle}>
          <option value="">Select policy…</option>
          {policies.map((p) => <option key={p.id} value={p.id}>{p.name} ({p.leaveType.name})</option>)}
        </select>
        {error && <div style={{ color: 'var(--danger)', fontSize: 12 }}>{error}</div>}
        <Button onClick={submit} disabled={busy}>{busy ? 'ASSIGNING…' : 'ASSIGN'}</Button>
      </div>
    </Modal>
  );
}

function LeaveCalendarTab({ agencyId }) {
  const [entries, setEntries] = useState(null);
  const [error, setError] = useState('');
  const [rangeStart] = useState(() => toDateInput(new Date()));
  const [rangeEnd] = useState(() => toDateInput(addDays(new Date(), 60)));

  useEffect(() => {
    load();
  }, [agencyId]);

  async function load() {
    setError('');
    try {
      const data = await api.hrLeaveCalendar(`?start=${rangeStart}&end=${rangeEnd}${agencyId ? `&agencyId=${agencyId}` : ''}`);
      setEntries(data.entries || []);
    } catch (err) {
      setError(err.data?.message || err.message || 'Could not load the leave calendar.');
    }
  }

  if (error) return <EmptyState title="Could not load" description={error} action={<Button size="sm" onClick={load}>RETRY</Button>} />;
  if (entries === null) return <div style={{ color: 'var(--text-muted)', fontSize: 13 }}>Loading…</div>;

  return (
    <Card>
      <SectionHeader>LEAVE CALENDAR — NEXT 60 DAYS</SectionHeader>
      <div style={{ fontSize: 12, color: 'var(--text-muted)', marginBottom: 12 }}>
        A protected leave type (e.g. FMLA) always shows as "Approved time off" here unless you hold full HR_ADMIN authority.
      </div>
      {entries.length === 0 ? (
        <EmptyState description="No approved time off in this window." />
      ) : (
        <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
          {entries.map((e) => (
            <div key={e.id} style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', padding: '10px 12px', background: 'var(--bg-sunken)', borderRadius: 'var(--radius-sm)' }}>
              <div style={{ fontWeight: 700, fontSize: 13 }}>{e.employeeName}</div>
              <div style={{ fontSize: 12, color: 'var(--text-secondary)' }}>
                {new Date(e.startDate).toLocaleDateString()} – {new Date(e.endDate).toLocaleDateString()} · <Badge tone={e.isProtected ? 'lime' : 'neutral'}>{e.leaveTypeName}</Badge>
              </div>
            </div>
          ))}
        </div>
      )}
    </Card>
  );
}

const inputStyle = { padding: '8px 12px', background: 'var(--bg-sunken)', border: '1px solid var(--border-hairline)', borderRadius: 'var(--radius-sm)', color: 'var(--text-primary)' };
const selectStyle = { ...inputStyle };
const labelStyle = { fontSize: 11, color: 'var(--text-muted)', display: 'block', marginBottom: 4 };
