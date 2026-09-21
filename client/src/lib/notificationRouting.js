import { basePathForRole } from '../layout/navConfig';

// Maps a real notification (relatedEntityType/relatedEntityId, both stored
// on the server — never guessed here) to where that entity actually lives
// in this app's per-role routes, so a click does real navigation instead of
// only marking the notification read. Every branch below was checked
// against the actual server notifyUser() call sites and the actual client
// routes each role has — a role with no real view for an entity type falls
// back to its own base path rather than pointing at a route that doesn't
// exist for them or a panel that can't show the thing.
export function notificationTarget(notification, role) {
  const base = basePathForRole(role);
  const id = notification.relatedEntityId;
  if (!id) return { path: base, highlightId: null, openChat: false };

  // Two different vocabularies collide here: direct entity notifications
  // (lead.assigned, transfer.offered, ...) store relatedEntityType as
  // 'Lead'/'Transfer' (set directly in leads.js/transfers.js), while EVERY
  // chat.message notification carries whatever chat.js's own conversation
  // route normalizes entityType to — always 'LEAD'/'TRANSFER', all caps
  // (see chat.js: `entityType = req.params.entityType.toUpperCase()`).
  // Normalize both onto the same key rather than duplicating every case.
  const entityKey = notification.relatedEntityType === 'LEAD' ? 'Lead'
    : notification.relatedEntityType === 'TRANSFER' ? 'Transfer'
    : notification.relatedEntityType;

  switch (entityKey) {
    case 'Lead':
      // lead.assigned -> the Producer's own dashboard queue;
      // lead.new (vendor lead) -> the Agency Owner's Team & Leads list.
      // No lead-level chat UI exists anywhere yet, so a chat.message
      // notification about a Lead only ever gets the highlight, not openChat.
      return { path: base, highlightId: id, openChat: false };

    case 'Transfer':
      if (role === 'AGENCY_OWNER' || role === 'AGENCY_MANAGER') {
        return { path: '/agency/transfers', highlightId: id, openChat: notification.type === 'chat.message' };
      }
      if (role === 'TELEMARKETER') return { path: '/telemarketer', highlightId: id, openChat: false };
      return { path: base, highlightId: null, openChat: false };

    case 'Vendor':
      // Only Agency Owners/Managers ever get a vendor.status_changed notification.
      return { path: '/agency/vendors', highlightId: id, openChat: false };

    case 'SupportTicket':
      if (role === 'PLATFORM_OWNER') return { path: '/platform/support', highlightId: id, openChat: false };
      if (role === 'AGENCY_OWNER' || role === 'AGENCY_MANAGER') return { path: '/agency/support', highlightId: id, openChat: false };
      // Producers/Telemarketers can open a ticket via Ed but have no
      // support panel of their own today — land safely on their base page.
      return { path: base, highlightId: null, openChat: false };

    case 'TrainingAssignment':
      // /agency/training and /platform/training are the course ADMIN view,
      // not an assignee's "my training" view — only Producers have a real
      // assignee-facing training route today.
      if (role === 'PRODUCER') return { path: '/producer/training', highlightId: id, openChat: false };
      return { path: base, highlightId: null, openChat: false };

    case 'Call':
      if (role === 'PRODUCER') return { path: '/producer/coaching', highlightId: id, openChat: false };
      if (role === 'AGENCY_OWNER' || role === 'AGENCY_MANAGER') return { path: '/agency/coaching', highlightId: id, openChat: false };
      return { path: base, highlightId: null, openChat: false };

    case 'AGENCY':
      // The persistent agency-wide team room — always a chat.message
      // notification, always opens straight into the room rather than
      // just highlighting something (there's no separate "row" for a
      // room to highlight).
      if (role === 'TELEMARKETER') return { path: '/telemarketer', highlightId: null, openChat: true };
      return { path: '/agency/transfers', highlightId: null, openChat: true };

    default:
      return { path: base, highlightId: null, openChat: false };
  }
}
