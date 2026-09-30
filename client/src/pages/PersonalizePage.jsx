import { useState } from 'react';
import { api } from '../lib/api';
import { useAuth } from '../lib/AuthContext';
import { useOwnBackgroundImage } from '../lib/useOwnBackgroundImage';
import { Card, SectionHeader, Button, FileDropzone, Icon, FallingEffectOverlay, FALLING_EFFECTS, FALLING_EFFECT_LABELS, pushToast } from '../ui';

const EFFECT_PREVIEW_ICON = {
  NONE: 'close',
  HEARTS: 'heart',
  STARS: 'sparkle',
  SNOW: 'sparkle',
  MONEY: 'dollar',
  BUBBLES: 'target',
  CONFETTI: 'sparkle',
  FIRE: 'flame',
};

// Reachable by every role at /personalize (see App.jsx) — a per-account
// cosmetic settings page, not tied to any role's nav tree. Background
// image and falling effect are two independent settings, saved separately
// (an image upload is a multipart request; the effect is a plain PATCH),
// matching this app's established "no combined form for two different
// wire formats" pattern (e.g. calls.js's upload vs. its transcript PATCH).
export default function PersonalizePage() {
  const { user, refreshUser } = useAuth();
  const blobUrl = useOwnBackgroundImage(user?.hasBackgroundImage);
  const [uploading, setUploading] = useState(false);
  const [removing, setRemoving] = useState(false);
  const [savingEffect, setSavingEffect] = useState(false);
  const [previewEffect, setPreviewEffect] = useState(null);
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

  async function handleSelectEffect(effect) {
    setError('');
    setSavingEffect(true);
    try {
      await api.updatePersonalization({ fallingEffect: effect });
      await refreshUser();
    } catch (err) {
      setError(err.data?.message || 'Could not save that effect.');
    } finally {
      setSavingEffect(false);
    }
  }

  const activeEffect = user?.fallingEffect || 'NONE';
  const shownEffect = previewEffect || activeEffect;

  return (
    <div style={s.wrap}>
      <FallingEffectOverlay effect={shownEffect} />

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
        <SectionHeader>Falling Effect</SectionHeader>
        <div style={s.hint}>Pick something to fall across your screen while you work. Hover an option to preview it.</div>
        <div style={s.effectGrid}>
          {FALLING_EFFECTS.map((effect) => (
            <button
              key={effect}
              type="button"
              style={s.effectTile(effect === activeEffect)}
              disabled={savingEffect}
              onClick={() => handleSelectEffect(effect)}
              onMouseEnter={() => setPreviewEffect(effect)}
              onMouseLeave={() => setPreviewEffect(null)}
            >
              <Icon name={EFFECT_PREVIEW_ICON[effect] || 'sparkle'} size={20} />
              <span>{FALLING_EFFECT_LABELS[effect]}</span>
              {effect === activeEffect && <span style={s.activeBadge}>ACTIVE</span>}
            </button>
          ))}
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
  effectGrid: { display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(110px, 1fr))', gap: 10 },
  effectTile: (active) => ({
    display: 'flex',
    flexDirection: 'column',
    alignItems: 'center',
    gap: 6,
    padding: '14px 8px',
    borderRadius: 'var(--radius-sm)',
    border: `1px solid ${active ? 'var(--accent)' : 'var(--border-hairline)'}`,
    background: active ? 'var(--accent-gradient-soft)' : 'var(--bg-sunken)',
    color: active ? 'var(--text-primary)' : 'var(--text-secondary)',
    fontSize: 12,
    fontWeight: 600,
    cursor: 'pointer',
    position: 'relative',
  }),
  activeBadge: {
    position: 'absolute',
    top: 4,
    right: 4,
    fontSize: 8,
    fontWeight: 700,
    letterSpacing: 0.5,
    color: 'var(--accent)',
  },
};
