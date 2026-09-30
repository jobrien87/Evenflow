import { useState } from 'react';
import { api } from '../lib/api';
import { useAuth } from '../lib/AuthContext';
import { useOwnBackgroundImage } from '../lib/useOwnBackgroundImage';
import { Card, SectionHeader, Button, FileDropzone, pushToast } from '../ui';

// Reachable by every role at /personalize (see App.jsx) — a per-account
// cosmetic settings page, not tied to any role's nav tree. Background
// image and birthday are two independent settings, saved separately (an
// image upload is a multipart request; the birthday is a plain PATCH),
// matching this app's established "no combined form for two different
// wire formats" pattern (e.g. calls.js's upload vs. its transcript PATCH).
//
// The falling-effect picker that used to live here is retired — falling
// effects are now real event-driven celebrations (a sale, a completed
// goal, a first login, a birthday), fired by lib/celebrations.js and
// rendered by ui/CelebrationHost.jsx, not a persistent cosmetic choice.
export default function PersonalizePage() {
  const { user, refreshUser } = useAuth();
  const blobUrl = useOwnBackgroundImage(user?.hasBackgroundImage);
  const [uploading, setUploading] = useState(false);
  const [removing, setRemoving] = useState(false);
  const [birthday, setBirthday] = useState(user?.birthday ? user.birthday.slice(0, 10) : '');
  const [savingBirthday, setSavingBirthday] = useState(false);
  const [error, setError] = useState('');

  async function handleFile(file) {
    setError('');
    setUploading(true);
    try {
      await api.uploadBackgroundImage(file);
      await refreshUser();
      pushToast({ title: 'Background updated', body: 'Your new background is live.', icon: 'palette' });
    } catch (err) {
      setError(err.data?.message || 'Could not upload that image.');
    } finally {
      setUploading(false);
    }
  }

  async function handleRemove() {
    setError('');
    setRemoving(true);
    try {
      await api.deleteBackgroundImage();
      await refreshUser();
    } catch (err) {
      setError(err.data?.message || 'Could not remove the background.');
    } finally {
      setRemoving(false);
    }
  }

  async function handleSaveBirthday(e) {
    e.preventDefault();
    setError('');
    setSavingBirthday(true);
    try {
      await api.updatePersonalization({ birthday: birthday || null });
      await refreshUser();
      pushToast({ title: 'Birthday saved', body: "We'll celebrate it when it comes around.", icon: 'cake' });
    } catch (err) {
      setError(err.data?.message || 'Could not save your birthday.');
    } finally {
      setSavingBirthday(false);
    }
  }

  return (
    <div style={s.wrap}>
      <Card style={{ marginBottom: 'var(--space-5)' }}>
        <SectionHeader>Background Image</SectionHeader>
        {error && <div style={s.error}>{error}</div>}

        {blobUrl && (
          <div style={s.previewWrap}>
            <img src={blobUrl} alt="Your background" style={s.previewImg} />
            <Button variant="danger" size="sm" onClick={handleRemove} disabled={removing} style={{ marginTop: 10 }}>
              {removing ? 'Removing…' : 'Remove background'}
            </Button>
          </div>
        )}

        <FileDropzone
          onFile={handleFile}
          accept="image/*"
          disabled={uploading}
          label={uploading ? 'Uploading…' : blobUrl ? 'Click to upload, or drag a new photo here' : 'Click to upload, or drag a photo here'}
          hint="JPG, PNG, GIF, or WEBP — up to 8MB"
        />
      </Card>

      <Card>
        <SectionHeader>Birthday</SectionHeader>
        <div style={s.hint}>Add your birthday and the app will celebrate it when it comes around.</div>
        <form onSubmit={handleSaveBirthday} style={s.birthdayForm}>
          <input
            type="date"
            style={s.input}
            value={birthday}
            onChange={(e) => setBirthday(e.target.value)}
          />
          <Button variant="primary" type="submit" disabled={savingBirthday}>
            {savingBirthday ? 'Saving…' : 'Save'}
          </Button>
        </form>
      </Card>
    </div>
  );
}

const s = {
  wrap: { maxWidth: 640 },
  error: { color: 'var(--danger)', fontSize: 12, marginBottom: 10 },
  hint: { color: 'var(--text-muted)', fontSize: 12, marginBottom: 14 },
  previewWrap: { marginBottom: 16, textAlign: 'center' },
  previewImg: {
    width: '100%',
    maxHeight: 220,
    objectFit: 'cover',
    borderRadius: 'var(--radius-md)',
    border: '1px solid var(--border-hairline)',
  },
  birthdayForm: { display: 'flex', gap: 10, alignItems: 'center' },
  input: { padding: '8px 10px', background: 'var(--bg-sunken)', border: '1px solid var(--border-strong)', borderRadius: 6, color: 'var(--text-primary)', fontSize: 13 },
};
