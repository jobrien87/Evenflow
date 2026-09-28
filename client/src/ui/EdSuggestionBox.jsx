import { useEffect, useState } from 'react';
import { api } from '../lib/api';
import Icon from './Icon';
import Card from './Card';

// A small proactive "ED suggests" box — reuses the same real, per-role
// context-grounded data /ask and /briefing already draw from (via
// POST /ed/suggest), just framed as one glance-length suggestion for
// whichever page renders it. Honest fallback (message.available===false)
// renders identically in tone, just without the AI-generated commentary.
export default function EdSuggestionBox({ pageContext, title = 'ED SUGGESTS' }) {
  const [state, setState] = useState({ loading: true, message: '', available: null, error: '' });

  useEffect(() => {
    let cancelled = false;
    setState({ loading: true, message: '', available: null, error: '' });
    const humorLevel = (() => {
      try {
        return localStorage.getItem('ed_humor_level') || 'NORMAL';
      } catch {
        return 'NORMAL';
      }
    })();

    api.edSuggest(pageContext, humorLevel)
      .then((res) => {
        if (cancelled) return;
        setState({ loading: false, message: res.message, available: res.available, error: '' });
      })
      .catch((err) => {
        if (cancelled) return;
        setState({ loading: false, message: '', available: false, error: err.data?.message || "ED couldn't pull a suggestion right now." });
      });

    return () => { cancelled = true; };
  }, [pageContext]);

  return (
    <Card style={s.card}>
      <div style={s.header}>
        <Icon name="sparkle" size={15} style={{ color: 'var(--accent)' }} />
        <span style={s.title}>{title}</span>
      </div>
      {state.loading ? (
        <div style={s.muted}>Thinking it over…</div>
      ) : state.error ? (
        <div style={s.muted}>{state.error}</div>
      ) : (
        <div style={state.available ? s.message : s.messageFallback}>{state.message}</div>
      )}
    </Card>
  );
}

const s = {
  card: { padding: '14px 16px', background: 'var(--accent-gradient-soft)' },
  header: { display: 'flex', alignItems: 'center', gap: 6, marginBottom: 8 },
  title: { color: 'var(--accent)', fontSize: 11, fontWeight: 700, letterSpacing: 1.5 },
  message: { color: 'var(--text-primary)', fontSize: 13, lineHeight: 1.5 },
  messageFallback: { color: 'var(--text-secondary)', fontSize: 13, lineHeight: 1.5 },
  muted: { color: 'var(--text-muted)', fontSize: 13, fontStyle: 'italic' },
};
