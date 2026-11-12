import { useEffect } from 'react';

/**
 * Keeps the screen on while `active`, so a phone doesn't lock itself mid-transfer
 * (a locked phone pauses the page and the transfer stops).
 * Browsers drop the lock when the tab is hidden, so it is taken again when the tab is visible.
 */
export function useWakeLock(active: boolean) {
  useEffect(() => {
    if (!active || !('wakeLock' in navigator)) return;
    let lock: WakeLockSentinel | null = null;
    let alive = true;

    const acquire = async () => {
      if (!alive || document.visibilityState !== 'visible' || (lock && !lock.released)) return;
      try {
        lock = await navigator.wakeLock.request('screen');
      } catch {
        // Not allowed right now (battery saver, unsupported). Transfers still work.
      }
    };
    const onVisible = () => void acquire();

    void acquire();
    document.addEventListener('visibilitychange', onVisible);
    return () => {
      alive = false;
      document.removeEventListener('visibilitychange', onVisible);
      void lock?.release().catch(() => {});
    };
  }, [active]);
}
