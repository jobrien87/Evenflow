import { useEffect, useState } from 'react';
import { api } from '../lib/api';
import { useAuth } from '../lib/AuthContext';

export default function AgencyBillingPanel() {
  const { user } = useAuth();
  const [subscription, setSubscription] = useState(undefined);
  const [showRequest, setShowRequest] = useState(false);
  const [requestNote, setRequestNote] = useState('');
  const [status, setStatus] = useState('');

  useEffect(() => {
    if (user.agencyId) {
      api.agencySubscription(user.agencyId).then((d) => setSubscription(d.subscription));
    }
  }, [user.agencyId]);

  async function requestChange(e) {
    e.preventDefault();
    setStatus('Submitting…');
    try {
      await api.createSupportTicket({
        category: 'billing',
        subject: 'Plan change request',
        description: requestNote,
      });
      setStatus('Request submitted to the platform team.');
      setRequestNote('');
      setTimeout(() => setShowRequest(false), 1200);
    } catch (err) {
      setStatus(err.data?.message || 'Failed to submit request.');
    }
  }

  if (subscription === undefined) return <div style={{ color: '#666' }}>Loading…</div>;

  return (
    <div style={s.wrap}>
      <h3 style={s.h3}>YOUR PLAN</h3>
      {subscription ? (
        <div style={s.card}>
          <div style={s.planName}>{subscription.plan.name}</div>
          <div style={s.planPrice}>${(subscription.plan.priceCents / 100).toFixed(2)}/{subscription.plan.interval === 'MONTHLY' ? 'month' : 'year'}</div>
          <div style={s.statusBadge(subscription.status)}>{subscription.status}</div>
          <div style={s.moduleList}>
            {[
              { key: 'crmEnabled', label: 'CRM' },
              { key: 'transfersEnabled', label: 'Yield Transfers' },
              { key: 'coachingEnabled', label: 'Sales Coaching' },
            ].map((m) => (
              <div key={m.key} style={s.moduleRow}>
                <span>{m.label}</span>
                <span style={{ color: subscription.plan[m.key] ? '#00e5ff' : '#555' }}>
                  {subscription.plan[m.key] ? 'Included' : 'Not included'}
                </span>
              </div>
            ))}
          </div>
        </div>
      ) : (
        <div style={s.card}>
          <div style={{ color: '#888' }}>No active subscription on file. Your agency has default (CRM-only) access.</div>
        </div>
      )}

      <button style={s.requestButton} onClick={() => setShowRequest(!showRequest)}>
        Request a plan change
      </button>

      {showRequest && (
        <form onSubmit={requestChange} style={s.form}>
          <div style={s.hint}>
            Plan changes are handled by the platform team, not self-serve. Describe what you're looking for and we'll follow up.
          </div>
          <textarea
            style={{ ...s.input, minHeight: 80 }}
            placeholder="e.g. We'd like to add Yield Transfers to our plan"
            value={requestNote}
            onChange={(e) => setRequestNote(e.target.value)}
            required
          />
          <button style={s.submitButton} type="submit">Submit Request</button>
          {status && <div style={s.status}>{status}</div>}
        </form>
      )}
    </div>
  );
}

const s = {
  wrap: { maxWidth: 420 },
  h3: { color: '#888', fontSize: 12, letterSpacing: 2, marginBottom: 12 },
  card: { background: '#111', border: '1px solid #222', borderRadius: 8, padding: 20, marginBottom: 16 },
  planName: { fontSize: 20, fontWeight: 700, color: '#fff' },
  planPrice: { color: '#888', fontSize: 13, marginTop: 4 },
  statusBadge: (status) => ({
    display: 'inline-block', marginTop: 10, fontSize: 11, padding: '4px 10px', borderRadius: 4,
    background: status === 'ACTIVE' ? '#0d1a1a' : '#1a1610', color: status === 'ACTIVE' ? '#00e5ff' : '#ffb84d',
  }),
  moduleList: { marginTop: 16, borderTop: '1px solid #222', paddingTop: 12 },
  moduleRow: { display: 'flex', justifyContent: 'space-between', padding: '6px 0', fontSize: 13, color: '#ccc' },
  requestButton: { padding: '10px 16px', background: 'transparent', border: '1px solid #333', color: '#aaa', borderRadius: 6, cursor: 'pointer', fontSize: 13 },
  form: { display: 'flex', flexDirection: 'column', gap: 10, background: '#111', padding: 16, borderRadius: 8, marginTop: 12, border: '1px solid #222' },
  hint: { color: '#666', fontSize: 12, lineHeight: 1.5 },
  input: { padding: '10px 12px', background: '#000', border: '1px solid #333', borderRadius: 6, color: '#fff' },
  submitButton: { padding: '10px', background: '#00e5ff', border: 'none', borderRadius: 6, fontWeight: 700, cursor: 'pointer' },
  status: { color: '#00e5ff', fontSize: 12 },
};
