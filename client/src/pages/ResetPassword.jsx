import { useState } from 'react';
import { useNavigate, useSearchParams } from 'react-router-dom';
import { api } from '../lib/api';

export default function ResetPassword() {
  const [params] = useSearchParams();
  const token = params.get('token') || '';
  const [password, setPassword] = useState('');
  const [message, setMessage] = useState('');
  const [done, setDone] = useState(false);
  const navigate = useNavigate();

  async function onSubmit(e) {
    e.preventDefault();
    try {
      await api.resetPassword(token, password);
      setDone(true);
      setMessage('Password updated. Redirecting to login…');
      setTimeout(() => navigate('/login'), 1500);
    } catch (err) {
      setMessage(err.data?.message || 'This reset link is invalid or expired.');
    }
  }

  return (
    <div style={s.wrap}>
      <div style={s.card}>
        <h2 style={s.h2}>Choose a new password</h2>
        {!done && (
          <form onSubmit={onSubmit}>
            <label style={s.label}>New password (min 10 characters)</label>
            <input style={s.input} type="password" value={password} onChange={(e) => setPassword(e.target.value)} minLength={10} required />
            <button style={s.button} type="submit">Reset Password</button>
          </form>
        )}
        {message && <div style={s.message}>{message}</div>}
      </div>
    </div>
  );
}

const s = {
  wrap: { display: 'flex', alignItems: 'center', justifyContent: 'center', height: '100vh' },
  card: {
    width: 380, padding: 32, background: 'var(--bg-elevated)',
    backdropFilter: 'var(--glass-blur)', WebkitBackdropFilter: 'var(--glass-blur)',
    border: '1px solid var(--border-hairline)', borderTopColor: 'var(--border-glass-highlight)',
    borderRadius: 12, color: 'var(--text-primary)', boxShadow: 'var(--shadow-card)',
  },
  h2: { fontWeight: 500, fontSize: 18, marginBottom: 16 },
  label: { color: 'var(--text-secondary)', fontSize: 12, display: 'block', marginBottom: 6 },
  input: { width: '100%', padding: '10px 12px', background: 'var(--bg-sunken)', border: '1px solid var(--border-strong)', borderRadius: 6, color: 'var(--text-primary)', marginBottom: 16 },
  button: { width: '100%', padding: '12px', background: 'var(--accent)', color: 'var(--accent-on)', fontWeight: 700, border: 'none', borderRadius: 6, cursor: 'pointer' },
  message: { color: 'var(--accent)', fontSize: 13, marginTop: 12 },
};
