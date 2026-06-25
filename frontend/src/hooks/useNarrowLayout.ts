import { useEffect, useState } from 'react';

const NARROW_LAYOUT_QUERY = '(max-width: 768px)';

/** True when layout matches mobile cluster pages (width-based, not user-agent). */
export function useNarrowLayout(): boolean {
  const [narrow, setNarrow] = useState(
    () => typeof window !== 'undefined' && window.matchMedia(NARROW_LAYOUT_QUERY).matches
  );

  useEffect(() => {
    const media = window.matchMedia(NARROW_LAYOUT_QUERY);
    const onChange = () => setNarrow(media.matches);
    media.addEventListener('change', onChange);
    return () => media.removeEventListener('change', onChange);
  }, []);

  return narrow;
}
