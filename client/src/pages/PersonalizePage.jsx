import { useState } from 'react';
import { api } from '../lib/api';
import { useAuth } from '../lib/AuthContext';
import { useOwnBackgroundImage } from '../lib/useOwnBackgroundImage';
import { Card, SectionHeader, Button, FileDropzone, Toggle, pushToast } from '../ui';
import { widgetsForRole } from '../lib/dashboardWidgets';

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
  const [hiddenWidgets, setHiddenWidgets] = useState(user?.hiddenDashboardWidgets || []);
  const [savingWidgets, setSavingWidgets] = useState(false);
  const [widgetsSaved, setWidgetsSaved] = useState(false);

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

  function toggleWidget(key, visible) {
    setWidgetsSaved(false);
    setHiddenWidgets((prev) => (visible ? prev.filter((k) => k !== key) : [...new Set([...prev, key])]));
  }

  async function handleSaveWidgets() {
    setError('');
    setSavingWidgets(true);
    try {
      await api.updatePersonalization({ hiddenDashboardWidgets: hiddenWidgets });
      await refreshUser();
      setWidgetsSaved(true);
      pushToast({ title: 'Main Stage updated', body: 'Your dashboard layout is saved.', icon: 'checklist' });
    } catch (err) {
      setError(err.data?.message || 'Could not save your Main Stage layout.');
    } finally {
      setSavingWidgets(false);
    }
  }

  const widgetGroups = widgetsForRole(user).reduce((groups, w) => {
    const last = groups[groups.length - 1];
    if (last && last.name === w.group) last.items.push(w);
    else groups.push({ name: w.group, items: [w] });
    return groups;
  }, []);

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

      <Card style={{ marginTop: 'var(--space-5)' }}>
        <SectionHeader>Main Stage Dashboard</SectionHeader>
        <div style={s.hint}>
          Choose which sections appear on your Main Stage dashboard. Nothing you turn off is deleted — it's just
          hidden from your own view.
        </div>
        {widgetGroups.map((g) => (
          <div key={g.name} style={s.widgetGroup}>
            <div style={s.widgetGroupHeading}>{g.name}</div>
            {g.items.map((w) => (
              <div key={w.key} style={s.widgetRow}>
                <span style={s.widgetLabel}>{w.label}</span>
                <Toggle
                  checked={!hiddenWidgets.includes(w.key)}
                  onChange={(visible) => toggleWidget(w.key, visible)}
                  label={w.label}
                />
              </div>
            ))}
          </div>
        ))}
        <div style={s.widgetFooter}>
          <Button variant="primary" onClick={handleSaveWidgets} disabled={savingWidgets}>
            {savingWidgets ? 'Saving…' : widgetsSaved ? 'Saved ✓' : 'Save'}
          </Button>
        </div>
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
  widgetGroup: { marginBottom: 14 },
  widgetGroupHeading: { color: 'var(--text-primary)', fontSize: 11, fontWeight: 700, textTransform: 'uppercase', letterSpacing: 0.5, marginBottom: 8 },
  widgetRow: { display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 12, padding: '8px 0', borderBottom: '1px solid var(--border-hairline)' },
  widgetLabel: { fontSize: 13, color: 'var(--text-secondary)' },
  widgetFooter: { display: 'flex', justifyContent: 'flex-end', marginTop: 14 },
};
