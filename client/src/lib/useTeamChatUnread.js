import { useEffect, useState } from 'react';
import { api } from './api';
import { useAuth } from './AuthContext';

const CHAT_ROLES = ['AGENCY_OWNER', 'AGENCY_MANAGER', 'PRODUCER', 'TELEMARKETER'];

// Whether any agency-wide team chat room the current user belongs to has
// an unread message — polled the same way NotificationBell.jsx polls its
// own unread count. GET /chat/conversations already reports `unread` per
// room (server-side lastReadAt/markRead, wired up when the agency-wide
// chat shipped), so this is pure client-side aggregation, no new backend
// endpoint. A Telemarketer can have one room per assigned agency; any one
// of them being unread counts.
export function useTeamChatUnread() {
  const { user } = useAuth();
  const [hasUnread, setHasUnread] = useState(false);
  const eligible = CHAT_ROLES.includes(user?.role);

  useEffect(() => {
    if (!eligible) return;
    let cancelled = false;
    async function poll() {
      try {
        const data = await api.chatConversations();
        if (cancelled) return;
        setHasUnread(data.conversations.some((c) => c.relatedEntityType === 'AGENCY' && c.unread));
      } catch {
        // ignore transient failures, next poll retries
      }
    }
    poll();
    const interval = setInterval(poll, 15000);
    return () => {
      cancelled = true;
      clearInterval(interval);
    };
  }, [eligible]);

  return eligible && hasUnread;
}
