import { useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { useAuth } from '../lib/AuthContext';
import { api } from '../lib/api';
import { Button, Logo } from '../ui';

export default function Login() {
  const { login, completeMfaLogin } = useAuth();
  const navigate = useNavigate();
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const [mode, setMode] = useState('login'); // 'login' | 'forgot' | 'mfa'
  const [forgotEmail, setForgotEmail] = useState('');
  const [forgotMessage, setForgotMessage] = useState('');
  const [forgotBusy, setForgotBusy] = useState(false);
  const [challengeToken, setChallengeToken] = useState('');
  const [mfaCode, setMfaCode] = useState('');

  async function onSubmit(e) {
    e.preventDefault();
    setError('');
    setBusy(true);
    try {
      const result = await login(email, password);
      if (result.mfaRequired) {
        setChallengeToken(result.challengeToken);
        setMode('mfa');
        return;
      }
      navigate('/');
    } catch (err) {
      setError(err.data?.message || 'Incorrect email or password.');
    } finally {
      setBusy(false);
    }
  }

  async function onMfaSubmit(e) {
    e.preventDefault();
    setError('');
    setBusy(true);
    try {
      await completeMfaLogin(challengeToken, mfaCode);
      navigate('/');
    } catch (err) {
      setError(err.data?.message || 'Invalid or expired code.');
    } finally {
      setBusy(false);
    }
  }

  async function onForgotSubmit(e) {
    e.preventDefault();
    setForgotBusy(true);
    setForgotMessage('');
    try {
      const res = await api.forgotPassword(forgotEmail);
      setForgotMessage(res.message || "If that email has an account, we've sent a reset link.");
    } catch (err) {
      setForgotMessage(err.data?.message || 'Something went wrong. Try again.');
    } finally {
      setForgotBusy(false);
    }
  }

  return (
    <div style={styles.wrap}>
      <div style={styles.glowBackdrop} />
      <div style={styles.hero}>
        <Logo variant="hero" size="lg" tagline="THE SUPER INTELLIGENCE POWERED ECOSYSTEM FOR INSURANCE AGENCIES" />
      </div>
      <div style={styles.card}>
        {mode === 'login' && (
          <form onSubmit={onSubmit}>
            <label style={styles.label}>Email</label>
            <input style={styles.input} type="email" value={email} onChange={(e) => setEmail(e.target.value)} required />
            <label style={styles.label}>Password</label>
            <input style={styles.input} type="password" value={password} onChange={(e) => setPassword(e.target.value)} required />
            {error && <div style={styles.error}>{error}</div>}
            <Button style={{ width: '100%', marginTop: 24, textTransform: 'uppercase', letterSpacing: 0.5 }} disabled={busy} type="submit">
              {busy ? 'Signing in…' : 'Sign In'}
            </Button>
            <button type="button" style={styles.linkButton} onClick={() => { setMode('forgot'); setForgotMessage(''); }}>
              Forgot password?
            </button>
          </form>
        )}
        {mode === 'forgot' && (
          <form onSubmit={onForgotSubmit}>
            <label style={styles.label}>Email</label>
            <input style={styles.input} type="email" value={forgotEmail} onChange={(e) => setForgotEmail(e.target.value)} required />
            {forgotMessage && <div style={styles.message}>{forgotMessage}</div>}
            <Button style={{ width: '100%', marginTop: 24, textTransform: 'uppercase', letterSpacing: 0.5 }} disabled={forgotBusy} type="submit">
              {forgotBusy ? 'Sending…' : 'Send Reset Link'}
            </Button>
            <button type="button" style={styles.linkButton} onClick={() => { setMode('login'); setForgotMessage(''); }}>
              Back to sign in
            </button>
          </form>
        )}
        {mode === 'mfa' && (
          <form onSubmit={onMfaSubmit}>
            <label style={styles.label}>Verification code</label>
            <div style={styles.hint}>Enter the 6-digit code from your authenticator app, or a backup code.</div>
            <input
              style={styles.input}
              type="text"
              inputMode="numeric"
              autoFocus
              autoComplete="one-time-code"
              value={mfaCode}
              onChange={(e) => setMfaCode(e.target.value)}
              required
            />
            {error && <div style={styles.error}>{error}</div>}
            <Button style={{ width: '100%', marginTop: 24, textTransform: 'uppercase', letterSpacing: 0.5 }} disabled={busy} type="submit">
              {busy ? 'Verifying…' : 'Verify'}
            </Button>
            <button
              type="button"
              style={styles.linkButton}
              onClick={() => { setMode('login'); setMfaCode(''); setChallengeToken(''); setError(''); }}
            >
              Back to sign in
            </button>
          </form>
        )}
      </div>
    </div>
  );
}

const styles = {
  wrap: {
    position: 'relative', display: 'flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'center',
    height: '100vh', gap: 40, overflow: 'hidden', background: 'var(--bg)',
  },
  glowBackdrop: {
    position: 'absolute', top: '18%', left: '50%', transform: 'translateX(-50%)',
    width: 520, height: 520, borderRadius: '50%', pointerEvents: 'none',
    background: 'radial-gradient(circle, rgba(198,255,46,0.16) 0%, rgba(22,224,160,0.08) 45%, transparent 70%)',
  },
  hero: { position: 'relative' },
  card: {
    position: 'relative', width: 360, padding: 32, background: 'var(--bg-elevated)',
    backdropFilter: 'var(--glass-blur)', WebkitBackdropFilter: 'var(--glass-blur)',
    border: '1px solid var(--border-hairline)', borderTopColor: 'var(--border-glass-highlight)',
    borderRadius: 12, boxShadow: 'var(--shadow-card)',
  },
  label: { color: 'var(--text-secondary)', fontSize: 12, display: 'block', marginBottom: 6, marginTop: 14 },
  input: { width: '100%', padding: '10px 12px', background: 'var(--bg-sunken)', border: '1px solid var(--border-strong)', borderRadius: 6, color: 'var(--text-primary)', fontSize: 14 },
  error: { color: 'var(--danger)', fontSize: 13, marginTop: 12 },
  message: { color: 'var(--accent)', fontSize: 13, marginTop: 12 },
  hint: { color: 'var(--text-secondary)', fontSize: 12, marginBottom: 10 },
  linkButton: { width: '100%', marginTop: 14, background: 'none', border: 'none', color: 'var(--text-secondary)', fontSize: 12, cursor: 'pointer', textAlign: 'center' },
};
