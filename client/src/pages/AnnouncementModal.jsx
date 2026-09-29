import { useEffect, useRef, useState } from 'react';
import { api } from '../lib/api';
import { Modal, Button } from '../ui';

const POLL_MS = 15000;

// Genuinely non-dismissible: Modal's own backdrop-click and CLOSE button
// only ever appear when an onClose is passed in — omitting it here means
// the backdrop click is a no-op and no CLOSE button renders at all, with
// zero changes needed to Modal.jsx itself. The full-screen overlay still
// blocks every click to the app behind it, so "can't access the app until
// acknowledged" falls out of that for free.
export default function AnnouncementModal() {
  const [announcement, setAnnouncement] = useState(null);
  const [busy, setBusy] = useState(false);
  const dismissedIdRef = useRef(null);

  useEffect(() => {
    check();
    const interval = setInterval(check, POLL_MS);
    return () => clearInterval(interval);
  }, []);

  async function check() {
    try {
      const data = await api.pendingAnnouncement();
      if (data.announcement && data.announcement.id === dismissedIdRef.current) return;
      setAnnouncement(data.announcement);
    } catch {
      // Non-fatal — the next poll retries; nothing to show meanwhile.
    }
  }

  async function acknowledge() {
    if (!announcement) return;
    setBusy(true);
    try {
      await api.ackAnnouncement(announcement.id);
      dismissedIdRef.current = announcement.id;
      setAnnouncement(null);
    } catch {
      // Leave the modal up so the person can just try the button again.
    } finally {
      setBusy(false);
    }
  }

  if (!announcement) return null;

  return (
    <Modal title="ANNOUNCEMENT" maxWidth={480}>
      <div style={s.title}>{announcement.title}</div>
      <div style={s.meta}>
        From {announcement.createdBy?.firstName} {announcement.createdBy?.lastName} · {new Date(announcement.createdAt).toLocaleString()}
      </div>
      <div style={s.body}>{announcement.body}</div>
      <Button variant="primary" disabled={busy} onClick={acknowledge} style={{ width: '100%', marginTop: 20 }}>
        {busy ? 'ACKNOWLEDGING…' : 'I ACKNOWLEDGE'}
      </Button>
    </Modal>
  );
}

const s = {
  title: { fontWeight: 700, fontSize: 18, color: 'var(--text-primary)', marginBottom: 4 },
  meta: { color: 'var(--text-muted)', fontSize: 12, marginBottom: 16 },
  body: { color: 'var(--text-secondary)', fontSize: 14, whiteSpace: 'pre-wrap', lineHeight: 1.5 },
};
