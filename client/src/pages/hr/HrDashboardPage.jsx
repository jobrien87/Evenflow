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
  { key: 'settings', label: 'SETTINGS' },
];

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
  const [employees, setEmployees] = useState([]);
  const [departments, setDepartments] = useState([]);
  const [positions, setPositions] = useState([]);
  const [legalEmployers, setLegalEmployers] = useState([]);
  const [roleGrants, setRoleGrants] = useState([]);
  const [agencyUsers, setAgencyUsers] = useState([]);

  useEffect(() => {
    load();
  }, [agencyId]);

  async function load() {
    setLoading(true);
    setLoadError('');
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
      setEmployees(emp.employees || []);
      setDepartments(dept.departments || []);
      setPositions(pos.positions || []);
      setLegalEmployers(le.legalEmployers || []);
      setRoleGrants(grants.grants || []);
      setAgencyUsers(users.users || []);
    } catch (err) {
      setLoadError(err.data?.message || err.message || 'Could not load Backstage HR.');
    } finally {
      setLoading(false);
    }
  }

  if (loading) return <div style={{ padding: 24, color: 'var(--text-muted)' }}>Loading Backstage HR…</div>;
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
          onChange={load}
        />
      )}
      {tab === 'departments' && <DepartmentsTab departments={departments} agencyUsers={agencyUsers} agencyId={agencyId} onChange={load} />}
      {tab === 'settings' && (
        <SettingsTab
          legalEmployers={legalEmployers}
          roleGrants={roleGrants}
          agencyUsers={agencyUsers}
          agencyId={agencyId}
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

function EmployeesTab({ employees, departments, positions, legalEmployers, agencyUsers, agencyId, currentUserId, onChange }) {
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
        <SectionHeader right={<Button size="sm" onClick={() => setShowCreate(true)}>+ ADD EMPLOYEE PROFILE</Button>}>EMPLOYEES</SectionHeader>
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
                    onChange={onChange}
                  />
                )}
              </div>
            ))}
          </div>
        )}
      </Card>

      {showCreate && (
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

function EmployeeDetail({ employee, departments, positions, legalEmployers, agencyUsers, onChange }) {
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
      {error && <div style={{ color: 'var(--danger)', fontSize: 12 }}>{error}</div>}
      <Button size="sm" onClick={save} disabled={busy}>{busy ? 'SAVING…' : 'SAVE CHANGES'}</Button>

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

function DepartmentsTab({ departments, agencyUsers, agencyId, onChange }) {
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
      <SectionHeader right={<Button size="sm" onClick={() => setShowCreate((v) => !v)}>{showCreate ? 'CANCEL' : '+ ADD DEPARTMENT'}</Button>}>DEPARTMENTS</SectionHeader>
      {showCreate && (
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
              <Button size="sm" variant="secondary" onClick={() => toggleActive(d)}>{d.isActive ? 'DEACTIVATE' : 'REACTIVATE'}</Button>
            </div>
          ))}
        </div>
      )}
    </Card>
  );
}

function SettingsTab({ legalEmployers, roleGrants, agencyUsers, agencyId, onChange }) {
  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 16 }}>
      <LegalEmployersCard legalEmployers={legalEmployers} agencyId={agencyId} onChange={onChange} />
      <RoleGrantsCard roleGrants={roleGrants} agencyUsers={agencyUsers} agencyId={agencyId} onChange={onChange} />
    </div>
  );
}

function LegalEmployersCard({ legalEmployers, agencyId, onChange }) {
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
      <div style={{ display: 'flex', gap: 8, marginBottom: 14, flexWrap: 'wrap' }}>
        <input placeholder="Legal name" value={legalName} onChange={(e) => setLegalName(e.target.value)} style={{ ...inputStyle, flex: 1, minWidth: 160 }} />
        <input placeholder="Country (US)" value={jurisdictionCountry} onChange={(e) => setJurisdictionCountry(e.target.value.toUpperCase())} style={{ ...inputStyle, width: 90 }} maxLength={2} />
        <input placeholder="Region (optional)" value={jurisdictionRegion} onChange={(e) => setJurisdictionRegion(e.target.value)} style={{ ...inputStyle, width: 120 }} />
        <Button size="sm" onClick={create} disabled={busy}>{busy ? 'ADDING…' : 'ADD'}</Button>
      </div>
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

function RoleGrantsCard({ roleGrants, agencyUsers, agencyId, onChange }) {
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
      {error && <div style={{ color: 'var(--danger)', fontSize: 12, marginBottom: 10 }}>{error}</div>}
      {roleGrants.length === 0 ? (
        <EmptyState description="No HR role grants yet." />
      ) : (
        <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
          {roleGrants.map((g) => (
            <div key={g.id} style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', padding: '8px 12px', background: 'var(--bg-sunken)', borderRadius: 'var(--radius-sm)' }}>
              <div style={{ fontSize: 13 }}>{fullName(g.user)} — <Badge tone="lime">{g.hrRole}</Badge></div>
              <Button size="sm" variant="danger" onClick={() => revoke(g.id)}>REVOKE</Button>
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
