import { useOwnBackgroundImage } from '../lib/useOwnBackgroundImage';

// A user's Personalize background photo, rendered as a fixed layer behind
// the whole app (z-index -1) with a dark scrim so the glass cards
// (client/src/ui/Card.jsx's translucent --bg-elevated) stay legible over
// any photo the user picks — cards blur/tint whatever shows through them,
// which is exactly the effect this feature is meant to add.
export default function PersonalizedBackdrop({ hasBackgroundImage }) {
  const blobUrl = useOwnBackgroundImage(hasBackgroundImage);

  if (!blobUrl) return null;

  return (
    <div
      style={{
        position: 'fixed',
        inset: 0,
        zIndex: -1,
        backgroundImage: `url(${blobUrl})`,
        backgroundSize: 'cover',
        backgroundPosition: 'center',
      }}
    >
      <div style={{ position: 'absolute', inset: 0, background: 'rgba(12, 14, 17, 0.55)' }} />
    </div>
  );
}
