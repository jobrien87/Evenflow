import { useAuth } from '../lib/AuthContext';
import { SectionHeader } from '../ui';
import ChatThread from './ChatThread';

// Producers are real participants of the agency-wide team room
// (agencyChatParticipantIds on the server already includes them) but had
// no page that showed it — this is that page.
export default function TeamChatPanel() {
  const { user } = useAuth();

  return (
    <div style={s.wrap}>
      <SectionHeader>TEAM CHAT</SectionHeader>
      <div style={s.chatBox}>
        <ChatThread entityType="AGENCY" entityId={user.agencyId} variant="inline" title="TEAM CHAT" />
      </div>
    </div>
  );
}

const s = {
  wrap: { color: 'var(--text-primary)', height: '100%' },
  chatBox: { height: 640 },
};
