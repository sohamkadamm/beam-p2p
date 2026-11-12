import { useEffect, useRef, useSyncExternalStore } from 'react';
import type { TransferManager } from '../lib/transfers';
import { SendPanel } from './SendPanel';
import { TransferList } from './TransferList';
import { TopBar } from './Wordmark';
import { useWakeLock } from '../hooks/useWakeLock';

const EMPTY: never[] = [];
const noop = () => () => {};

/** The screen both devices see once they are connected. */
export function SessionView({
  manager,
  peerDevice,
  route,
  safetyCode,
  reconnecting,
  ended,
  onEnd,
  endedAction,
}: {
  manager: TransferManager | null;
  peerDevice: string;
  route?: 'direct' | 'relay' | 'unknown';
  safetyCode?: string;
  reconnecting?: boolean;
  ended?: { reason: 'left' | 'lost' };
  onEnd: () => void;
  endedAction?: React.ReactNode;
}) {
  const transfers = useSyncExternalStore(manager?.subscribe ?? noop, manager?.getSnapshot ?? (() => EMPTY));
  useIncomingAlert(transfers.filter((t) => t.status === 'pending').length);
  useWakeLock(!ended);

  return (
    <div className="page">
      <TopBar>
        {!ended && (
          <button className="btn btn-quiet btn-small" onClick={onEnd}>
            End session
          </button>
        )}
      </TopBar>
      <main className="session">
        <div
          className={`link-status${ended ? ' is-ended' : ''}${reconnecting && !ended ? ' is-reconnecting' : ''}`}
          role="status"
          data-testid="link-status"
        >
          <span className="link-dot" aria-hidden="true" />
          {ended ? (
            <span>{ended.reason === 'lost' ? `Lost the connection to ${peerDevice}` : `${peerDevice} disconnected`}</span>
          ) : reconnecting ? (
            <span>
              Reconnecting to <strong>{peerDevice}</strong>. Transfers continue when the link is back.
            </span>
          ) : (
            <span>
              Connected to <strong>{peerDevice}</strong>
              {route === 'direct' && <span className="route"> directly, device to device</span>}
              {route === 'relay' && <span className="route"> through an encrypted relay</span>}
            </span>
          )}
          {!ended && safetyCode && (
            <span className="safety" data-testid="safety-code">
              Safety code <strong className="tabular">{safetyCode}</strong>
              <span className="safety-hint">Both screens should show the same code</span>
            </span>
          )}
          {ended && endedAction}
        </div>
        <div className="session-grid">
          <SendPanel peerDevice={peerDevice} disabled={!!ended || !manager} onSend={(f) => (manager ? manager.send(f) : 'Still connecting. Try again in a moment.')} />
          {manager && <TransferList transfers={transfers} manager={manager} peerDevice={peerDevice} />}
        </div>
      </main>
    </div>
  );
}

/** A short vibration and a title badge when files arrive, so a busy screen notices. */
function useIncomingAlert(pending: number) {
  const prev = useRef(0);
  useEffect(() => {
    if (pending > prev.current) navigator.vibrate?.(120);
    prev.current = pending;
    document.title = pending ? `(${pending}) Files waiting · Beam` : 'Beam';
  }, [pending]);
  useEffect(() => () => void (document.title = 'Beam'), []);
}
