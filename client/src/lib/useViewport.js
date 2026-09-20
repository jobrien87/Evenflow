import { useEffect, useState } from 'react';

const MOBILE_QUERY = '(max-width: 768px)';

// Structural (not cosmetic) responsive branching only — e.g. sidebar vs.
// drawer+bottom-nav. Cosmetic sizing stays in CSS.
export function useIsMobile() {
  const [isMobile, setIsMobile] = useState(() =>
    typeof window !== 'undefined' ? window.matchMedia(MOBILE_QUERY).matches : false
  );

  useEffect(() => {
    const mql = window.matchMedia(MOBILE_QUERY);
    const onChange = (e) => setIsMobile(e.matches);
    mql.addEventListener('change', onChange);
    return () => mql.removeEventListener('change', onChange);
  }, []);

  return isMobile;
}
