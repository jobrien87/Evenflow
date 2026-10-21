import { useEffect, useRef } from 'react';
import { useNavigate } from 'react-router-dom';
import { api } from './api';
import { useAuth } from './AuthContext';
import { notificationTarget, notificationUrl } from './notificationRouting';
import { pushToast } from '../ui/Toast';
import { playDrumRoll } from './drumRoll';

const POLL_MS = 15000;

// Mirrors useLeadAlerts.js's exact pattern (a separate poll, not shared —
// same "keep it simple rather than refactoring the working bell" reasoning)
// but for chat.mention notifications specifically — a Platform Owner is
// never a real chat participant anywhere (see activePlatformOwners in
// server/src/lib/chat.js), so this is the one case where they need to be
// told about a message at all, and it should be hard to miss.
export function usePlatformMentionAlerts() {
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
          playDrumRoll();
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

// Non-rendering wrapper so AppLayout.jsx can conditionally mount this by
// role without violating the rules of hooks, same pattern as LeadAlertListener.
export default function PlatformMentionAlertListener() {
  usePlatformMentionAlerts();
  return null;
}
