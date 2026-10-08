// My HR — the self-service page for Producer/Telemarketer: their own HR
// profile basics (Part A), their own timesheets (Part B — My Time), and
// now their own schedule + leave balance/requests (Part C — My Schedule,
// My Time Off).
import { useEffect, useState } from 'react';
import { api } from '../../lib/api';
import { Card, SectionHeader, Badge, Button, EmptyState } from '../../ui';

function minutesToHours(minutes) {
  if (minutes == null) return '—';
  return (minutes / 60).toFixed(1);
}

// Always renders in the employee's own work time zone, never the
// viewer's browser-local zone (the viewer IS the employee here, but the
// browser's local zone can still differ from their configured work
// zone) — see HrDashboardPage.jsx's formatShiftTime for the same fix
// and the real-browser bug it caught.
function formatShiftTime(isoString, timeZone) {
  return new Date(isoString).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', timeZone: timeZone || 'America/New_York' });
}

const LEAVE_STATUS_TONE = { PENDING: 'neutral', APPROVED: 'green', DENIED: 'danger', CANCELLED: 'neutral' };

const inputStyle = { padding: '8px 12px', background: 'var(--bg-sunken)', border: '1px solid var(--border-hairline)', borderRadius: 'var(--radius-sm)', color: 'var(--text-primary)' };
const selectStyle = { ...inputStyle };
const labelStyle = { fontSize: 11, color: 'var(--text-muted)', display: 'block', marginBottom: 4 };

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

      <MyScheduleSection workTimeZone={employee?.workTimeZone} />
      <MyTimeOffSection />
    </div>
  );
}

function MyScheduleSection({ workTimeZone }) {
  const [shifts, setShifts] = useState(null);
  const [error, setError] = useState('');
  const [swapShiftId, setSwapShiftId] = useState('');
  const [coveringUserId, setCoveringUserId] = useState('');
  const [reason, setReason] = useState('');

  useEffect(() => {
    load();
  }, []);

  function load() {
    api.hrMySchedule()
      .then((data) => setShifts(data.shifts))
      .catch((err) => setError(err.data?.message || err.message || 'Could not load your schedule.'));
  }

  async function requestSwap(shiftId) {
    try {
      await api.requestHrShiftSwap(shiftId, { proposedCoveringUserId: coveringUserId.trim() || undefined, reason: reason.trim() || undefined });
      setSwapShiftId('');
      setCoveringUserId('');
      setReason('');
      load();
    } catch (err) {
      setError(err.data?.message || err.message || 'Could not request a swap for this shift.');
    }
  }

  return (
    <Card>
      <SectionHeader>MY SCHEDULE</SectionHeader>
      {error && <EmptyState title="Could not load" description={error} />}
      {!error && shifts === null && <div style={{ color: 'var(--text-muted)', fontSize: 13 }}>Loading…</div>}
      {!error && shifts && shifts.length === 0 && (
        <EmptyState description="No upcoming shifts have been scheduled for you yet." />
      )}
      {!error && shifts && shifts.length > 0 && (
        <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
          {shifts.map((s) => (
            <div key={s.id} style={{ padding: '10px 12px', background: 'var(--bg-sunken)', borderRadius: 'var(--radius-sm)' }}>
              <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
                <div>
                  <div style={{ fontWeight: 700, fontSize: 13 }}>{new Date(s.workDate).toLocaleDateString(undefined, { weekday: 'long', month: 'short', day: 'numeric' })}</div>
                  <div style={{ fontSize: 12, color: 'var(--text-muted)' }}>
                    {formatShiftTime(s.startAt, workTimeZone)} – {formatShiftTime(s.endAt, workTimeZone)}
                    {s.shiftTemplate ? ` · ${s.shiftTemplate.name}` : ''}
                  </div>
                </div>
                <div style={{ display: 'flex', gap: 8, alignItems: 'center' }}>
                  <Badge tone={s.status === 'COVERED' ? 'lime' : 'green'}>{s.status}</Badge>
                  {s.swapRequests?.length > 0 && <Badge tone="neutral">SWAP PENDING</Badge>}
                  {s.status === 'SCHEDULED' && !s.swapRequests?.length && swapShiftId !== s.id && (
                    <Button size="sm" variant="secondary" onClick={() => setSwapShiftId(s.id)}>REQUEST SWAP</Button>
                  )}
                </div>
              </div>
              {swapShiftId === s.id && (
                <div style={{ marginTop: 8, display: 'flex', flexDirection: 'column', gap: 8 }}>
                  <input placeholder="Covering teammate's user ID (optional)" value={coveringUserId} onChange={(e) => setCoveringUserId(e.target.value)} style={inputStyle} />
                  <input placeholder="Reason (optional)" value={reason} onChange={(e) => setReason(e.target.value)} style={inputStyle} />
                  <div style={{ display: 'flex', gap: 8 }}>
                    <Button size="sm" onClick={() => requestSwap(s.id)}>SUBMIT SWAP REQUEST</Button>
                    <Button size="sm" variant="secondary" onClick={() => setSwapShiftId('')}>CANCEL</Button>
                  </div>
                </div>
              )}
            </div>
          ))}
        </div>
      )}
    </Card>
  );
}

function MyTimeOffSection() {
  const [balances, setBalances] = useState(null);
  const [requests, setRequests] = useState(null);
  const [error, setError] = useState('');
  const [leaveTypeId, setLeaveTypeId] = useState('');
  const [startDate, setStartDate] = useState('');
  const [endDate, setEndDate] = useState('');
  const [requestedHours, setRequestedHours] = useState('');
  const [note, setNote] = useState('');
  const [busy, setBusy] = useState(false);
  const [formError, setFormError] = useState('');

  useEffect(() => {
    load();
  }, []);

  function load() {
    api.hrLeaveBalance().then((data) => setBalances(data.balances)).catch((err) => setError(err.data?.message || err.message || 'Could not load your leave balance.'));
    api.hrMyLeaveRequests().then((data) => setRequests(data.requests)).catch(() => {});
  }

  async function submitRequest() {
    if (!leaveTypeId || !startDate || !endDate || !requestedHours) { setFormError('Fill in every field.'); return; }
    setBusy(true);
    setFormError('');
    try {
      await api.createHrLeaveRequest({
        leaveTypeId, startDate, endDate,
        requestedMinutes: Math.round(Number(requestedHours) * 60),
        note: note.trim() || undefined,
      });
      setStartDate(''); setEndDate(''); setRequestedHours(''); setNote('');
      load();
    } catch (err) {
      setFormError(err.data?.message || err.message || 'Could not submit this request.');
    } finally {
      setBusy(false);
    }
  }

  return (
    <Card>
      <SectionHeader>MY TIME OFF</SectionHeader>
      {error && <EmptyState title="Could not load" description={error} />}

      {!error && balances && (
        <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap', marginBottom: 16 }}>
          {balances.length === 0 ? (
            <div style={{ fontSize: 12, color: 'var(--text-muted)', fontStyle: 'italic' }}>No leave policy has been assigned to you yet.</div>
          ) : balances.map((b) => (
            <div key={b.leaveTypeId} style={{ padding: '10px 12px', background: 'var(--bg-sunken)', borderRadius: 'var(--radius-sm)', minWidth: 140 }}>
              <div style={{ fontSize: 11, color: 'var(--text-muted)' }}>{b.leaveTypeName}</div>
              <div style={{ fontSize: 18, fontWeight: 700 }}>{minutesToHours(b.balanceMinutes)}h</div>
            </div>
          ))}
        </div>
      )}

      {!error && balances && balances.length > 0 && (
        <div style={{ display: 'flex', flexDirection: 'column', gap: 8, marginBottom: 16, padding: 12, background: 'var(--bg-elevated)', borderRadius: 'var(--radius-sm)' }}>
          <div style={{ fontSize: 11, fontWeight: 700, color: 'var(--text-muted)', letterSpacing: 0.5 }}>REQUEST TIME OFF</div>
          <select value={leaveTypeId} onChange={(e) => setLeaveTypeId(e.target.value)} style={selectStyle}>
            <option value="">Select leave type…</option>
            {balances.map((b) => <option key={b.leaveTypeId} value={b.leaveTypeId}>{b.leaveTypeName}</option>)}
          </select>
          <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
            <input type="date" value={startDate} onChange={(e) => setStartDate(e.target.value)} style={inputStyle} />
            <input type="date" value={endDate} onChange={(e) => setEndDate(e.target.value)} style={inputStyle} />
            <input type="number" min="0" step="0.5" placeholder="Hours" value={requestedHours} onChange={(e) => setRequestedHours(e.target.value)} style={{ ...inputStyle, width: 90 }} />
          </div>
          <input placeholder="Note (optional)" value={note} onChange={(e) => setNote(e.target.value)} style={inputStyle} />
          {formError && <div style={{ color: 'var(--danger)', fontSize: 12 }}>{formError}</div>}
          <Button size="sm" onClick={submitRequest} disabled={busy}>{busy ? 'SUBMITTING…' : 'SUBMIT REQUEST'}</Button>
        </div>
      )}

      <div style={{ fontSize: 11, fontWeight: 700, color: 'var(--text-muted)', letterSpacing: 0.5, marginBottom: 8 }}>REQUEST HISTORY</div>
      {!error && requests === null && <div style={{ color: 'var(--text-muted)', fontSize: 13 }}>Loading…</div>}
      {!error && requests && requests.length === 0 && (
        <div style={{ fontSize: 12, color: 'var(--text-muted)', fontStyle: 'italic' }}>No leave requests yet.</div>
      )}
      {!error && requests && requests.length > 0 && (
        <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
          {requests.map((r) => (
            <div key={r.id} style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', padding: '10px 12px', background: 'var(--bg-sunken)', borderRadius: 'var(--radius-sm)' }}>
              <div>
                <div style={{ fontWeight: 700, fontSize: 13 }}>{r.leaveType.name}</div>
                <div style={{ fontSize: 12, color: 'var(--text-muted)' }}>
                  {new Date(r.startDate).toLocaleDateString()} – {new Date(r.endDate).toLocaleDateString()} · {minutesToHours(r.requestedMinutes)}h
                </div>
              </div>
              <Badge tone={LEAVE_STATUS_TONE[r.status] || 'neutral'}>{r.status}</Badge>
            </div>
          ))}
        </div>
      )}
    </Card>
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
