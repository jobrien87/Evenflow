import { useEffect, useState } from 'react';
import { api } from './api';

// Fetches the logged-in user's own Personalize background photo as a blob
// URL (not a plain <img src>/CSS url()) — see PersonalizedBackdrop.jsx for
// why a credentialed fetch is needed instead. Shared by the always-on
// backdrop and the Personalize page's own preview, since both need the
// exact same "am I set, and if so what does it look like" state.
export function useOwnBackgroundImage(hasBackgroundImage) {
  const [blobUrl, setBlobUrl] = useState(null);

  useEffect(() => {
    if (!hasBackgroundImage) {
      setBlobUrl(null);
      return undefined;
    }
    let cancelled = false;
    let objectUrl = null;
    fetch(api.myBackgroundUrl(), { credentials: 'include' })
      .then((res) => (res.ok ? res.blob() : null))
      .then((blob) => {
        if (cancelled || !blob) return;
        objectUrl = URL.createObjectURL(blob);
        setBlobUrl(objectUrl);
      })
      .catch(() => {});
    return () => {
      cancelled = true;
      if (objectUrl) URL.revokeObjectURL(objectUrl);
    };
  }, [hasBackgroundImage]);

  return blobUrl;
}
