import { useEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { useNavigate, useLocation } from 'react-router-dom';
import Icon from './Icon';
import Button from './Button';

const CARD_WIDTH = 340;
const CARD_HEIGHT_ESTIMATE = 210;
const MARGIN = 18;
const FIND_TIMEOUT_MS = 2000;
const FIND_INTERVAL_MS = 50;

function clamp(value, min, max) {
  return Math.min(Math.max(value, min), max);
}

// Picks whichever side of the highlighted element has room for the card —
// right, then left, then below, then above — falling back to centered when
// nothing fits (a small element near a viewport edge, or no target at all).
function placeCard(rect) {
  if (!rect) return null;
  const vw = window.innerWidth;
  const vh = window.innerHeight;

  const right = rect.right ?? rect.left + rect.width;
  const bottom = rect.bottom ?? rect.top + rect.height;
  const spaceRight = vw - right;
  const spaceLeft = rect.left;
  const spaceBelow = vh - bottom;
  const spaceAbove = rect.top;

  if (spaceRight >= CARD_WIDTH + MARGIN) {
    return { top: clamp(rect.top, MARGIN, vh - CARD_HEIGHT_ESTIMATE - MARGIN), left: right + MARGIN };
  }
  if (spaceLeft >= CARD_WIDTH + MARGIN) {
    return { top: clamp(rect.top, MARGIN, vh - CARD_HEIGHT_ESTIMATE - MARGIN), left: rect.left - CARD_WIDTH - MARGIN };
  }
  if (spaceBelow >= CARD_HEIGHT_ESTIMATE + MARGIN) {
    return { top: bottom + MARGIN, left: clamp(rect.left, MARGIN, vw - CARD_WIDTH - MARGIN) };
  }
  if (spaceAbove >= CARD_HEIGHT_ESTIMATE + MARGIN) {
    return { top: rect.top - CARD_HEIGHT_ESTIMATE - MARGIN, left: clamp(rect.left, MARGIN, vw - CARD_WIDTH - MARGIN) };
  }
  return null;
}

// A real spotlight product tour: walks a role's nav tabs and key functional
// elements one at a time, navigating the app to each step's real route,
// finding the real live DOM element (a nav link, a card, a widget — never a
// fake mockup) and cutting a glowing hole in the backdrop around it, then
// docking a tooltip card next to it. Falls back to a plain centered card for
// intro/closing steps with no target, or if an element genuinely never
// mounts (never lets the tour break outright).
export default function TourOverlay({ steps, startIndex = 0, onDone }) {
  const [i, setI] = useState(() => clamp(startIndex, 0, steps.length - 1));
  const [rect, setRect] = useState(null);
  const [searching, setSearching] = useState(true);
  const targetElRef = useRef(null);
  const navigate = useNavigate();
  const location = useLocation();

  const step = steps[i];
  const isFirst = i === 0;
  const isLast = i === steps.length - 1;

  function updateRect() {
    if (!targetElRef.current || !document.body.contains(targetElRef.current)) return;
    const r = targetElRef.current.getBoundingClientRect();
    setRect({ top: r.top, left: r.left, width: r.width, height: r.height });
  }

  // Drives each step: navigate to its route if we're not already there,
  // then poll for its target element (it may take a moment to mount after
  // a route change or a data fetch) and scroll it into view once found.
  useEffect(() => {
    let cancelled = false;
    let attempts = 0;
    targetElRef.current = null;
    setSearching(true);

    if (step.route && location.pathname !== step.route) {
      navigate(step.route);
    }

    function attempt() {
      if (cancelled) return;
      if (!step.selector) {
        setRect(null);
        setSearching(false);
        return;
      }
      const el = document.querySelector(step.selector);
      if (el) {
        targetElRef.current = el;
        el.scrollIntoView({ behavior: 'smooth', block: 'center', inline: 'nearest' });
        setTimeout(() => {
          if (cancelled) return;
          updateRect();
          setSearching(false);
        }, 260);
        return;
      }
      attempts += FIND_INTERVAL_MS;
      if (attempts < FIND_TIMEOUT_MS) {
        setTimeout(attempt, FIND_INTERVAL_MS);
      } else {
        // Element never showed up (conditional content, different data
        // state, etc.) — degrade to a centered card rather than stalling.
        setRect(null);
        setSearching(false);
      }
    }

    attempt();
    return () => { cancelled = true; };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [i]);

  // Keeps the spotlight glued to its target if the page scrolls or the
  // window resizes mid-step.
  useEffect(() => {
    function onScrollOrResize() { updateRect(); }
    window.addEventListener('scroll', onScrollOrResize, true);
    window.addEventListener('resize', onScrollOrResize);
    return () => {
      window.removeEventListener('scroll', onScrollOrResize, true);
      window.removeEventListener('resize', onScrollOrResize);
    };
  }, []);

  useEffect(() => {
    function onKey(e) {
      if (e.key === 'Escape') onDone();
      else if (e.key === 'ArrowRight' && !isLast) setI((v) => v + 1);
      else if (e.key === 'ArrowLeft' && !isFirst) setI((v) => v - 1);
    }
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [isFirst, isLast]);

  const spotlightRect = rect
    ? { top: rect.top - 8, left: rect.left - 8, width: rect.width + 16, height: rect.height + 16 }
    : null;
  const placement = placeCard(spotlightRect);
  const centered = !placement;

  return createPortal(
    <>
      {/* Full-viewport click catcher — a scripted tour shouldn't let the
          user accidentally mutate data mid-walkthrough. Sits below the
          card/spotlight in z-index so their own buttons stay clickable.
          Deliberately does NOT dismiss on click — only SKIP TOUR/Escape do,
          so an accidental misclick never boots someone out of the tour. */}
      <div style={s.catcher} />

      {spotlightRect && (
        <div
          style={{
            ...s.spotlight,
            top: spotlightRect.top,
            left: spotlightRect.left,
            width: spotlightRect.width,
            height: spotlightRect.height,
            opacity: searching ? 0 : 1,
          }}
        />
      )}
      {!spotlightRect && <div style={s.dimBackdrop} />}

      <div
        style={
          centered
            ? s.cardCentered
            : { ...s.card, top: placement.top, left: placement.left, width: CARD_WIDTH }
        }
      >
        <div style={s.iconWrap}>
          <Icon name={step.icon} size={26} style={{ color: 'var(--accent)' }} />
        </div>
        <div style={s.title}>{step.title}</div>
        <div style={s.body}>{step.body}</div>

        <div style={s.progressTrack}>
          <div style={{ ...s.progressFill, width: `${((i + 1) / steps.length) * 100}%` }} />
        </div>
        <div style={s.progressLabel}>{i + 1} / {steps.length}</div>

        <div style={s.actionsRow}>
          <button style={s.skipLink} onClick={onDone}>SKIP TOUR</button>
          <div style={{ display: 'flex', gap: 8 }}>
            {!isFirst && (
              <Button variant="secondary" size="sm" onClick={() => setI((v) => v - 1)}>BACK</Button>
            )}
            <Button variant="primary" size="sm" onClick={() => (isLast ? onDone() : setI((v) => v + 1))}>
              {isLast ? "LET'S GO" : 'NEXT'}
            </Button>
          </div>
        </div>
      </div>
    </>,
    document.body
  );
}

const s = {
  catcher: {
    position: 'fixed', inset: 0, zIndex: 'var(--z-modal)',
  },
  dimBackdrop: {
    position: 'fixed', inset: 0, background: 'rgba(6, 7, 9, 0.72)',
    backdropFilter: 'var(--glass-blur-sm)', WebkitBackdropFilter: 'var(--glass-blur-sm)',
    zIndex: 'calc(var(--z-modal) + 1)', pointerEvents: 'none',
  },
  spotlight: {
    position: 'fixed', zIndex: 'calc(var(--z-modal) + 1)', pointerEvents: 'none',
    borderRadius: 12,
    boxShadow: '0 0 0 9999px rgba(6, 7, 9, 0.82), 0 0 0 2px var(--accent), 0 0 28px 2px var(--accent)',
    transition: 'top var(--dur-base) var(--ease-standard), left var(--dur-base) var(--ease-standard), width var(--dur-base) var(--ease-standard), height var(--dur-base) var(--ease-standard), opacity var(--dur-fast) var(--ease-standard)',
  },
  card: {
    position: 'fixed', zIndex: 'calc(var(--z-modal) + 2)',
    background: 'var(--bg-elevated)', backdropFilter: 'var(--glass-blur)', WebkitBackdropFilter: 'var(--glass-blur)',
    border: '1px solid var(--border-hairline)', borderTopColor: 'var(--border-glass-highlight)',
    borderRadius: 'var(--radius-lg)', padding: 'var(--space-5)',
    boxShadow: 'var(--shadow-card)',
    transition: 'top var(--dur-base) var(--ease-standard), left var(--dur-base) var(--ease-standard)',
  },
  cardCentered: {
    position: 'fixed', top: '50%', left: '50%', transform: 'translate(-50%, -50%)',
    zIndex: 'calc(var(--z-modal) + 2)', width: CARD_WIDTH, maxWidth: 'calc(100vw - 40px)',
    background: 'var(--bg-elevated)', backdropFilter: 'var(--glass-blur)', WebkitBackdropFilter: 'var(--glass-blur)',
    border: '1px solid var(--border-hairline)', borderTopColor: 'var(--border-glass-highlight)',
    borderRadius: 'var(--radius-lg)', padding: 'var(--space-6)',
    boxShadow: 'var(--shadow-card)', textAlign: 'center',
  },
  iconWrap: {
    width: 48, height: 48, borderRadius: '50%', margin: '0 auto 14px',
    background: 'var(--accent-gradient-soft)', display: 'flex', alignItems: 'center', justifyContent: 'center',
  },
  title: { color: 'var(--text-primary)', fontWeight: 700, fontSize: 16, marginBottom: 6 },
  body: { color: 'var(--text-secondary)', fontSize: 13, lineHeight: 1.55, marginBottom: 16 },
  progressTrack: { height: 3, borderRadius: 2, background: 'var(--border-hairline)', overflow: 'hidden', marginBottom: 4 },
  progressFill: { height: '100%', background: 'var(--accent-gradient)', transition: 'width var(--dur-base) var(--ease-standard)' },
  progressLabel: { color: 'var(--text-muted)', fontSize: 10, marginBottom: 14, textAlign: 'right' },
  actionsRow: { display: 'flex', justifyContent: 'space-between', alignItems: 'center' },
  skipLink: { background: 'none', border: 'none', color: 'var(--text-muted)', fontSize: 11, letterSpacing: 0.5, cursor: 'pointer', fontWeight: 700 },
};
