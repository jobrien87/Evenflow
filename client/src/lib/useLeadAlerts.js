import { useEffect, useRef } from 'react';
import { useNavigate } from 'react-router-dom';
import { api } from './api';
import { useAuth } from './AuthContext';
import { notificationTarget, notificationUrl } from './notificationRouting';
import { pushToast } from '../ui/Toast';
import { playDrumRoll } from './drumRoll';

// lead.first_attempt_overdue is a speed-to-lead SLA breach — reuses the
// exact same "make noise + pop a toast right now" mechanism as a brand new
// lead, since a blown SLA needs the same immediate notice.
const LEAD_ALERT_TYPES = new Set(['lead.new', 'lead.assigned', 'lead.moshpit_available', 'lead.first_attempt_overdue']);
const POLL_MS = 15000;

// Polls the same real Notification data NotificationBell.jsx already reads
// (a separate 15s poll, not shared — kept simple rather than refactoring
// the existing, working bell) and, whenever a lead.new/lead.assigned/
// lead.moshpit_available row newer than the last check shows up, fires the
// drum-roll sound plus a toast. No new backend endpoint or notification
// type — those three already fire on every real lead-creation path
// (leads.js, vendorApi.js).
export function useLeadAlerts() {
  const { user } = useAuth();
  const navigate = useNavigate();
  // Seeded at mount so a login/refresh never replays a lead that landed
  // before this session started.
  const lastSeenAtRef = useRef(Date.now());

  useEffect(() => {
    let cancelled = false;

    async function poll() {
      try {
        const data = await api.notifications();
        if (cancelled) return;

        const candidates = (data.notifications || [])
          .filter((n) => LEAD_ALERT_TYPES.has(n.type) && !n.readAt)
          .filter((n) => new Date(n.createdAt).getTime() > lastSeenAtRef.current)
          .sort((a, b) => new Date(a.createdAt) - new Date(b.createdAt));

        // Only the newest one per tick, even if several leads landed in the
        // same interval, to avoid stacking sound/toasts on top of each other.
        const newest = candidates[candidates.length - 1];
        if (newest) {
          playDrumRoll();
          const target = notificationTarget(newest, user?.role);
          pushToast({
            title: newest.title,
            body: newest.body,
            icon: 'leads',
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

// Roles that can own/see a lead land — matches who leads.js/vendorApi.js
// actually notify today.
const LEAD_ALERT_ROLES = new Set(['PRODUCER', 'AGENCY_OWNER', 'AGENCY_MANAGER', 'TELEMARKETER']);

// Non-rendering wrapper so AppLayout.jsx can conditionally mount this by
// role without violating the rules of hooks (a hook itself can't be called
// conditionally, but a component can be conditionally rendered).
export default function LeadAlertListener() {
  useLeadAlerts();
  return null;
}

export { LEAD_ALERT_ROLES };
