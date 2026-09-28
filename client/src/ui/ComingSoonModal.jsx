import Modal from './Modal';
import Icon from './Icon';

// Shared "this feature isn't live yet" popup — used today for the Record
// Store stub nav tab (real leads-marketplace webhooks/API integration
// with Boberdoo lands later), reusable for any other stubbed feature.
export default function ComingSoonModal({ title = 'COMING SOON', label, description, onClose }) {
  return (
    <Modal title={title} onClose={onClose} maxWidth={360}>
      <div style={{ textAlign: 'center', padding: '12px 0' }}>
        <div style={{
          width: 56, height: 56, borderRadius: '50%', margin: '0 auto 16px',
          background: 'var(--accent-gradient-soft)', display: 'flex', alignItems: 'center', justifyContent: 'center',
        }}>
          <Icon name="vinyl" size={28} style={{ color: 'var(--accent)' }} />
        </div>
        <div style={{ color: 'var(--text-primary)', fontWeight: 700, fontSize: 16, marginBottom: 8 }}>{label}</div>
        <div style={{ color: 'var(--text-secondary)', fontSize: 13, lineHeight: 1.5 }}>{description}</div>
      </div>
    </Modal>
  );
}
