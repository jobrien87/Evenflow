import { useEffect, useState } from 'react';
import { api } from '../lib/api';
import { SectionHeader } from '../ui';

// The flashy hero at the top of the Coaching tab — the ordered sales
// training series (intro -> mindset -> humor -> voice -> impression ->
// sp1 -> sp2), played via Bunny's own iframe embed, with a central player,
// prev/next, and a clickable library row below. Videos/order come live
// from GET /calls/coaching-videos (server/src/lib/coachingVideos.js) — a
// slot with no matching video in the Bunny library yet (e.g. sp2, still
// uploading) shows as a real, honest "coming soon" tile, never a fake one.
export default function CoachingVideoTheater() {
  const [videos, setVideos] = useState(null);
  const [activeIdx, setActiveIdx] = useState(0);

  useEffect(() => {
    load();
  }, []);

  async function load() {
    const data = await api.coachingVideos();
    setVideos(data.videos);
    const firstAvailable = data.videos.findIndex((v) => v.available);
    setActiveIdx(firstAvailable >= 0 ? firstAvailable : 0);
  }

  function step(direction) {
    if (!videos) return;
    for (let i = 1; i <= videos.length; i++) {
      const idx = (activeIdx + direction * i + videos.length * 10) % videos.length;
      if (videos[idx].available) {
        setActiveIdx(idx);
        return;
      }
    }
  }

  if (!videos) return null;

  const active = videos[activeIdx];
  const anyAvailable = videos.some((v) => v.available);

  return (
    <section style={s.section}>
      <SectionHeader>Coaching Video Series</SectionHeader>
      <div style={s.theater}>
        <div style={s.content}>
          {active?.available ? (
            <>
              <div style={s.playerFrame}>
                <iframe
                  key={active.slug}
                  style={s.embed}
                  src={active.embedUrl}
                  loading="lazy"
                  allow="accelerometer;gyroscope;autoplay;encrypted-media;picture-in-picture;"
                  allowFullScreen
                  title={active.label}
                />
              </div>
              <div style={s.controls}>
                <button style={s.navButton} onClick={() => step(-1)} aria-label="Previous video">&#10094; PREV</button>
                <div style={s.nowPlaying}>
                  {active.order} / {videos.length} — {active.label.toUpperCase()}
                </div>
                <button style={s.navButton} onClick={() => step(1)} aria-label="Next video">NEXT &#10095;</button>
              </div>
            </>
          ) : (
            <div style={s.emptyFrame}>
              {anyAvailable ? `${active?.label} is still uploading — check back soon.` : 'The coaching video series is still being uploaded — check back soon.'}
            </div>
          )}

          <div style={s.library}>
            {videos.map((v, i) => (
              <button
                key={v.slug}
                style={{ ...s.tile, ...(i === activeIdx ? s.tileActive : {}), ...(!v.available ? s.tileDisabled : {}) }}
                disabled={!v.available}
                onClick={() => setActiveIdx(i)}
              >
                <div style={s.tileNum}>{v.order}</div>
                <div style={s.tileLabel}>{v.label}</div>
                {!v.available && <div style={s.tileBadge}>SOON</div>}
              </button>
            ))}
          </div>
        </div>
      </div>
    </section>
  );
}

const s = {
  section: { marginBottom: 'var(--space-6, 24px)' },
  theater: {
    position: 'relative',
    overflow: 'hidden',
    borderRadius: 16,
    background: 'var(--bg)',
    border: '1px solid var(--border-hairline)',
    padding: 20,
  },
  content: { position: 'relative', zIndex: 1 },
  playerFrame: {
    width: '100%', aspectRatio: '16 / 9', borderRadius: 12, overflow: 'hidden',
    boxShadow: '0 0 40px rgba(198, 255, 46, 0.25), 0 0 0 1px rgba(198, 255, 46, 0.3)',
  },
  embed: { width: '100%', height: '100%', border: 'none', display: 'block' },
  emptyFrame: {
    width: '100%', aspectRatio: '16 / 9', borderRadius: 12,
    background: 'var(--bg-sunken)', border: '1px dashed var(--border-strong)',
    display: 'flex', alignItems: 'center', justifyContent: 'center',
    color: 'var(--text-muted)', fontSize: 14, textAlign: 'center', padding: 24,
  },
  controls: { display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginTop: 14, gap: 12, flexWrap: 'wrap' },
  navButton: {
    padding: '10px 18px', background: 'var(--accent-gradient)', color: 'var(--accent-on)',
    border: 'none', borderRadius: 8, fontWeight: 800, letterSpacing: 0.5, cursor: 'pointer', fontSize: 12,
  },
  nowPlaying: { color: 'var(--text-primary)', fontWeight: 700, fontSize: 13, letterSpacing: 0.5 },
  library: {
    display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(110px, 1fr))', gap: 10, marginTop: 20,
  },
  tile: {
    position: 'relative', display: 'flex', flexDirection: 'column', alignItems: 'center', gap: 6,
    padding: '14px 8px', borderRadius: 10, cursor: 'pointer',
    background: 'var(--bg-elevated)', border: '1px solid var(--border-hairline)', color: 'var(--text-secondary)',
  },
  tileActive: {
    border: '1px solid var(--accent)', boxShadow: '0 0 14px rgba(198, 255, 46, 0.35)', color: 'var(--accent)',
  },
  tileDisabled: { opacity: 0.45, cursor: 'not-allowed' },
  tileNum: { fontSize: 11, fontWeight: 800, color: 'var(--accent-2)' },
  tileLabel: { fontSize: 12, fontWeight: 700, textTransform: 'uppercase', letterSpacing: 0.3 },
  tileBadge: {
    position: 'absolute', top: 4, right: 4, fontSize: 8, fontWeight: 800, letterSpacing: 0.5,
    padding: '2px 5px', borderRadius: 4, background: 'var(--bg-sunken)', color: 'var(--text-muted)',
  },
};
