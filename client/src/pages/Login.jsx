import { useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { useAuth } from '../lib/AuthContext';

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
          <button style={styles.button} disabled={busy} type="submit">
            {busy ? 'Signing in…' : 'Sign In'}
          </button>
        </form>
      </div>
    </div>
  );
}

const styles = {
  wrap: { display: 'flex', alignItems: 'center', justifyContent: 'center', height: '100vh', background: '#0a0a0a' },
  card: { width: 360, padding: 32, background: '#111', border: '1px solid #222', borderRadius: 12 },
  logo: { color: '#fff', letterSpacing: 4, fontSize: 22, marginBottom: 24, textAlign: 'center' },
  label: { color: '#999', fontSize: 12, display: 'block', marginBottom: 6, marginTop: 14 },
  input: { width: '100%', padding: '10px 12px', background: '#000', border: '1px solid #333', borderRadius: 6, color: '#fff', fontSize: 14 },
  button: { width: '100%', marginTop: 24, padding: '12px', background: '#00e5ff', color: '#000', fontWeight: 700, border: 'none', borderRadius: 6, cursor: 'pointer' },
  error: { color: '#ff4d4d', fontSize: 13, marginTop: 12 },
};
