import { useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { useAuth } from '../lib/AuthContext';
import { api } from '../lib/api';
import { Button } from '../ui';

export default function Login() {
  const { login } = useAuth();
  const navigate = useNavigate();
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const [mode, setMode] = useState('login'); // 'login' | 'forgot'
  const [forgotEmail, setForgotEmail] = useState('');
  const [forgotMessage, setForgotMessage] = useState('');
  const [forgotBusy, setForgotBusy] = useState(false);

  async function onSubmit(e) {
    e.preventDefault();
    setError('');
    setBusy(true);
    try {
      await login(email, password);
      navigate('/');
    } catch (err) {
      setError(err.data?.message || 'Incorrect email or password.');
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
      <div style={styles.card}>
        <h1 style={styles.logo}>EVENFLOW</h1>
        {mode === 'login' ? (
          <form onSubmit={onSubmit}>
            <label style={styles.label}>Email</label>
            <input style={styles.input} type="email" value={email} onChange={(e) => setEmail(e.target.value)} required />
            <label style={styles.label}>Password</label>
            <input style={styles.input} type="password" value={password} onChange={(e) => setPassword(e.target.value)} required />
            {error && <div style={styles.error}>{error}</div>}
            <Button style={{ width: '100%', marginTop: 24 }} disabled={busy} type="submit">
              {busy ? 'Signing in…' : 'Sign In'}
            </Button>
            <button type="button" style={styles.linkButton} onClick={() => { setMode('forgot'); setForgotMessage(''); }}>
              Forgot password?
            </button>
          </form>
        ) : (
          <form onSubmit={onForgotSubmit}>
            <label style={styles.label}>Email</label>
            <input style={styles.input} type="email" value={forgotEmail} onChange={(e) => setForgotEmail(e.target.value)} required />
            {forgotMessage && <div style={styles.message}>{forgotMessage}</div>}
            <Button style={{ width: '100%', marginTop: 24 }} disabled={forgotBusy} type="submit">
              {forgotBusy ? 'Sending…' : 'Send Reset Link'}
            </Button>
            <button type="button" style={styles.linkButton} onClick={() => { setMode('login'); setForgotMessage(''); }}>
              Back to sign in
            </button>
          </form>
        )}
      </div>
    </div>
  );
}

const styles = {
  wrap: { display: 'flex', alignItems: 'center', justifyContent: 'center', height: '100vh' },
  card: {
    width: 360, padding: 32, background: 'var(--bg-elevated)',
    backdropFilter: 'var(--glass-blur)', WebkitBackdropFilter: 'var(--glass-blur)',
    border: '1px solid var(--border-hairline)', borderTopColor: 'var(--border-glass-highlight)',
    borderRadius: 12, boxShadow: 'var(--shadow-card)',
  },
  logo: {
    fontFamily: 'var(--font-display)', fontWeight: 700, letterSpacing: 3, fontSize: 24, marginBottom: 24, textAlign: 'center',
    backgroundImage: 'var(--accent-gradient)', WebkitBackgroundClip: 'text', backgroundClip: 'text', color: 'transparent',
  },
  label: { color: 'var(--text-secondary)', fontSize: 12, display: 'block', marginBottom: 6, marginTop: 14 },
  input: { width: '100%', padding: '10px 12px', background: 'var(--bg-sunken)', border: '1px solid var(--border-strong)', borderRadius: 6, color: 'var(--text-primary)', fontSize: 14 },
  error: { color: 'var(--danger)', fontSize: 13, marginTop: 12 },
  message: { color: 'var(--accent)', fontSize: 13, marginTop: 12 },
  linkButton: { width: '100%', marginTop: 14, background: 'none', border: 'none', color: 'var(--text-secondary)', fontSize: 12, cursor: 'pointer', textAlign: 'center' },
};
