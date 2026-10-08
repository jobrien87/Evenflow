import { useState } from 'react';
import { api } from '../lib/api';
import { useAuth } from '../lib/AuthContext';
import { Card, SectionHeader, Button, Badge, pushToast } from '../ui';

// Reachable by every role at /security (see App.jsx), same "per-account
// settings, not tied to any role's nav tree" pattern as PersonalizePage —
// the self-service enroll/disable flow for TOTP MFA (server/src/routes/
// auth.js's /auth/mfa/* routes). MFA is optional for every role here;
// Platform Owner/Agency Owner are simply the roles this is meant to be
// used by, per the SOC 2 Tier 1 plan — nothing in the UI restricts it.
export default function SecurityPage() {
  const { user, refreshUser } = useAuth();
  const [step, setStep] = useState('idle'); // 'idle' | 'enrolling' | 'backup-codes' | 'disabling'
  const [enrollment, setEnrollment] = useState(null); // { secret, otpauthUrl, qrDataUrl }
  const [code, setCode] = useState('');
  const [backupCodes, setBackupCodes] = useState(null);
  const [disablePassword, setDisablePassword] = useState('');
  const [disableCode, setDisableCode] = useState('');
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);

  async function startEnroll() {
    setError('');
    setBusy(true);
    try {
      const data = await api.mfaEnroll();
      setEnrollment(data);
      setCode('');
      setStep('enrolling');
    } catch (err) {
      setError(err.data?.message || 'Could not start enrollment.');
    } finally {
      setBusy(false);
    }
  }

  async function confirmEnroll(e) {
    e.preventDefault();
    setError('');
    setBusy(true);
    try {
      const data = await api.mfaConfirm(code);
      setBackupCodes(data.backupCodes);
      setStep('backup-codes');
      await refreshUser();
    } catch (err) {
      setError(err.data?.message || 'Invalid code.');
    } finally {
      setBusy(false);
    }
  }

  function finishEnroll() {
    setStep('idle');
    setEnrollment(null);
    setBackupCodes(null);
    setCode('');
    pushToast({ title: 'Two-factor authentication enabled', body: 'Your account now requires a code at login.', icon: 'lock' });
  }

  async function confirmDisable(e) {
    e.preventDefault();
    setError('');
    setBusy(true);
    try {
      await api.mfaDisable(disablePassword, disableCode);
      await refreshUser();
      setStep('idle');
      setDisablePassword('');
      setDisableCode('');
      pushToast({ title: 'Two-factor authentication disabled', icon: 'lock' });
    } catch (err) {
      setError(err.data?.message || 'Could not disable two-factor authentication.');
    } finally {
      setBusy(false);
    }
  }

  return (
    <div style={s.wrap}>
      <Card>
        <SectionHeader>Two-Factor Authentication</SectionHeader>
        {error && step !== 'backup-codes' && <div style={s.error}>{error}</div>}

        {step === 'idle' && (
          <>
            <div style={s.row}>
              <Badge tone={user?.mfaEnabled ? 'accent' : 'neutral'}>
                {user?.mfaEnabled ? 'Enabled' : 'Not enabled'}
              </Badge>
            </div>
            <div style={s.hint}>
              {user?.mfaEnabled
                ? 'A 6-digit code from your authenticator app is required every time you sign in.'
                : 'Add a second step to login using an authenticator app (Google Authenticator, Authy, 1Password, etc.).'}
            </div>
            {user?.mfaEnabled ? (
              <Button variant="danger" onClick={() => { setError(''); setStep('disabling'); }}>
                Disable two-factor authentication
              </Button>
            ) : (
              <Button variant="primary" onClick={startEnroll} disabled={busy}>
                {busy ? 'Starting…' : 'Set up two-factor authentication'}
              </Button>
            )}
          </>
        )}

        {step === 'enrolling' && enrollment && (
          <form onSubmit={confirmEnroll}>
            <div style={s.hint}>
              Scan this QR code with your authenticator app, or enter the key manually, then enter the 6-digit code it shows.
            </div>
            <img src={enrollment.qrDataUrl} alt="MFA enrollment QR code" style={s.qr} />
            <div style={s.secretRow}>
              <code style={s.secretCode}>{enrollment.secret}</code>
            </div>
            <label style={s.label}>6-digit code</label>
            <input
              style={s.input}
              type="text"
              inputMode="numeric"
              autoFocus
              value={code}
              onChange={(e) => setCode(e.target.value)}
              required
            />
            {error && <div style={s.error}>{error}</div>}
            <div style={s.buttonRow}>
              <Button variant="primary" type="submit" disabled={busy}>
                {busy ? 'Confirming…' : 'Confirm & enable'}
              </Button>
              <Button variant="secondary" type="button" onClick={() => { setStep('idle'); setEnrollment(null); setError(''); }}>
                Cancel
              </Button>
            </div>
          </form>
        )}

        {step === 'backup-codes' && backupCodes && (
          <div>
            <div style={s.hint}>
              Save these one-time backup codes somewhere safe. Each one can be used instead of a code from your
              authenticator app if you ever lose access to it — once used, a code is gone.
            </div>
            <div style={s.backupGrid}>
              {backupCodes.map((c) => (
                <code key={c} style={s.backupCode}>{c}</code>
              ))}
            </div>
            <Button variant="primary" onClick={finishEnroll} style={{ marginTop: 16 }}>
              I've saved these codes
            </Button>
          </div>
        )}

        {step === 'disabling' && (
          <form onSubmit={confirmDisable}>
            <div style={s.hint}>Confirm your password and a current code to turn two-factor authentication off.</div>
            <label style={s.label}>Password</label>
            <input
              style={s.input}
              type="password"
              autoFocus
              value={disablePassword}
              onChange={(e) => setDisablePassword(e.target.value)}
              required
            />
            <label style={s.label}>Authenticator code or backup code</label>
            <input
              style={s.input}
              type="text"
              value={disableCode}
              onChange={(e) => setDisableCode(e.target.value)}
              required
            />
            {error && <div style={s.error}>{error}</div>}
            <div style={s.buttonRow}>
              <Button variant="danger" type="submit" disabled={busy}>
                {busy ? 'Disabling…' : 'Disable'}
              </Button>
              <Button variant="secondary" type="button" onClick={() => { setStep('idle'); setDisablePassword(''); setDisableCode(''); setError(''); }}>
                Cancel
              </Button>
            </div>
          </form>
        )}
      </Card>
    </div>
  );
}

const s = {
  wrap: { maxWidth: 480 },
  row: { marginBottom: 10 },
  hint: { color: 'var(--text-muted)', fontSize: 12, marginBottom: 14, lineHeight: 1.5 },
  error: { color: 'var(--danger)', fontSize: 12, marginBottom: 10 },
  label: { color: 'var(--text-secondary)', fontSize: 12, display: 'block', marginBottom: 6, marginTop: 14 },
  input: { width: '100%', padding: '10px 12px', background: 'var(--bg-sunken)', border: '1px solid var(--border-strong)', borderRadius: 6, color: 'var(--text-primary)', fontSize: 14 },
  buttonRow: { display: 'flex', gap: 10, marginTop: 18 },
  qr: { display: 'block', width: 180, height: 180, margin: '0 auto 14px', borderRadius: 'var(--radius-md)', background: '#fff', padding: 8 },
  secretRow: { textAlign: 'center', marginBottom: 14 },
  secretCode: {
    display: 'inline-block', padding: '6px 10px', background: 'var(--bg-sunken)',
    border: '1px solid var(--border-hairline)', borderRadius: 6, fontSize: 13, letterSpacing: 1,
  },
  backupGrid: {
    display: 'grid', gridTemplateColumns: 'repeat(2, 1fr)', gap: 8, marginTop: 10,
  },
  backupCode: {
    padding: '8px 10px', background: 'var(--bg-sunken)', border: '1px solid var(--border-hairline)',
    borderRadius: 6, fontSize: 13, textAlign: 'center',
  },
};
