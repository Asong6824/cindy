import { useEffect, useState } from 'react';

export function useKosPreviewAvailability() {
  const [available, setAvailable] = useState<boolean>();
  useEffect(() => {
    let current = true;
    const api = window.electronAPI?.kosPreview;
    if (!api) setAvailable(false);
    else void api.available().then(value => { if (current) setAvailable(value); })
      .catch(() => { if (current) setAvailable(false); });
    return () => { current = false; };
  }, []);
  return available;
}
