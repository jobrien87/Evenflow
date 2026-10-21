import { useEffect, useState } from 'react';
import { useParams } from 'react-router-dom';
import { api } from '../lib/api';
import { Card, EmptyState } from '../ui';
import ChatThread from './ChatThread';

// Where every role lands to see/reply to a direct message aimed at them —
// a DM notification deep-links here (notificationRouting.js's 'DM' case),
// and DirectMessagesPanel.jsx (the Platform Owner's own "start a DM"
// picker) could link here too. Resolves the conversation via the exact
// same entity-conversation endpoint ChatThread itself already uses
// (entityType="DM", entityId=the other participant's id) — only needs
// that participant's name up front for the title.
export default function DirectMessageThread() {
  const { userId } = useParams();
  const [otherUser, setOtherUser] = useState(null);
  const [error, setError] = useState('');
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    setError('');
    api.chatEntityConversation('DM', userId)
      .then((res) => { if (!cancelled) setOtherUser(res.otherUser); })
      .catch((err) => { if (!cancelled) setError(err.data?.message || 'Could not open this conversation.'); })
      .finally(() => { if (!cancelled) setLoading(false); });
    return () => { cancelled = true; };
  }, [userId]);

  if (loading) return <div style={s.muted}>Loading…</div>;
  if (error || !otherUser) {
    return <EmptyState title="Couldn't open this conversation" description={error || 'That user could not be found.'} />;
  }

  return (
    <Card style={s.threadCard}>
      <ChatThread
        entityType="DM"
        entityId={userId}
        variant="inline"
        title={`${otherUser.firstName} ${otherUser.lastName}`.toUpperCase()}
      />
    </Card>
  );
}

const s = {
  muted: { color: 'var(--text-muted)', fontSize: 13, padding: '10px 0' },
  threadCard: { padding: 'var(--space-4)', height: 640, display: 'flex', flexDirection: 'column' },
};
