import { useEffect, useRef } from 'react';
import { useNavigate } from 'react-router-dom';
import { api } from './api';
import { useAuth } from './AuthContext';
import { notificationTarget, notificationUrl } from './notificationRouting';
import { pushToast } from '../ui/Toast';
import { playHiHat } from './drumRoll';

const POLL_MS = 15000;

// Mirrors useLeadAlerts.js's exact pattern (a separate poll, not shared —
// same "keep it simple rather than refactoring the working bell" reasoning)
// but for chat.mention notifications — mounted for every authenticated
// role, since postMessage (server/src/lib/chat.js) creates a chat.mention
// Notification for whoever was actually @-mentioned, regardless of role or
// conversation type. Each user only ever sees their own notifications, so
// the hi-hat only ever plays for the person who was tagged.
export function useMentionAlerts() {
  const { user } = useAuth();
  const navigate = useNavigate();
  const lastSeenAtRef = useRef(Date.now());

  useEffect(() => {
    let cancelled = false;

    async function poll() {
      try {
        const data = await api.notifications();
        if (cancelled) return;

        const candidates = (data.notifications || [])
          .filter((n) => n.type === 'chat.mention' && !n.readAt)
          .filter((n) => new Date(n.createdAt).getTime() > lastSeenAtRef.current)
          .sort((a, b) => new Date(a.createdAt) - new Date(b.createdAt));

        // Only the newest one per tick, same as useLeadAlerts — avoids
        // stacking sound/toasts when several mentions land in one interval.
        const newest = candidates[candidates.length - 1];
        if (newest) {
          playHiHat();
          const target = notificationTarget(newest, user?.role, user?.id);
          pushToast({
            title: newest.title,
            body: newest.body,
            icon: 'chat',
            onClick: () => {
              const url = notificationUrl(target);
              if (url) navigate(url);
            },
          });
        }

        lastSeenAtRef.current = Date.now();
      } catch {
        // Transient failure — next poll retries; never surfaces an error here.
      }
    }

    poll();
    const interval = setInterval(poll, POLL_MS);
    return () => {
      cancelled = true;
      clearInterval(interval);
    };
  }, [user?.role, navigate]);
}

// Non-rendering wrapper so AppLayout.jsx can mount this unconditionally
// without violating the rules of hooks, same pattern as LeadAlertListener.
export default function MentionAlertListener() {
  useMentionAlerts();
  return null;
}
