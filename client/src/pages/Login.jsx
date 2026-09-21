import { useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { useAuth } from '../lib/AuthContext';
import { Button } from '../ui';

export default function Login() {
  const { login } = useAuth();
  const navigate = useNavigate();
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);

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

  return (
    <div style={styles.wrap}>
      <div style={styles.card}>
        <h1 style={styles.logo}>EVENFLOW</h1>
        <form onSubmit={onSubmit}>
          <label style={styles.label}>Email</label>
          <input style={styles.input} type="email" value={email} onChange={(e) => setEmail(e.target.value)} required />
          <label style={styles.label}>Password</label>
          <input style={styles.input} type="password" value={password} onChange={(e) => setPassword(e.target.value)} required />
          {error && <div style={styles.error}>{error}</div>}
          <Button style={{ width: '100%', marginTop: 24 }} disabled={busy} type="submit">
            {busy ? 'Signing in…' : 'Sign In'}
          </Button>
        </form>
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
};
