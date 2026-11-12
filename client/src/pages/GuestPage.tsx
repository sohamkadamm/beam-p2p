import { useParams } from 'react-router-dom';
import { useBeamSession, type ErrorKind } from '../hooks/useBeamSession';
import { SessionView } from '../components/SessionView';
import { StatusScreen } from '../components/StatusScreen';

const ERRORS: Record<ErrorKind, { title: string; body: string }> = {
  expired: { title: 'This code has expired', body: 'Scan the new code on the other screen.' },
  busy: { title: 'That screen is already connected', body: 'Another device is using it. End that session there, then scan the new code.' },
  rejected: { title: 'The other screen declined', body: 'Scan the code again and press Allow on that screen.' },
  server: { title: 'Can’t reach the Beam server', body: 'Check your internet connection, then scan the code again.' },
  unsupported: { title: 'This browser can’t run Beam', body: 'Open the link in Chrome or Safari.' },
  failed: { title: 'The devices couldn’t reach each other', body: 'Connect both devices to the same Wi-Fi or phone hotspot, then scan a new code.' },
  'same-device': { title: 'This is the same screen', body: 'Scan the code with a different device.' },
};

/** The phone, after scanning the QR code. */
export default function GuestPage() {
  const { token } = useParams();
  const { phase, manager, endSession } = useBeamSession('guest', token);

  switch (phase.name) {
    case 'starting':
    case 'joining':
      return <StatusScreen busy title="Connecting" />;
    case 'waiting-approval':
      return (
        <StatusScreen busy title={`Press Allow on ${phase.hostDevice}`}>
          <p>The screen you scanned needs to approve this phone first.</p>
        </StatusScreen>
      );
    case 'connecting':
      return (
        <StatusScreen busy title={`Connecting to ${phase.peerDevice}`}>
          <p>Setting up a direct link between the two devices.</p>
        </StatusScreen>
      );
    case 'connected':
    case 'ended':
      return (
        <SessionView
          manager={manager}
          peerDevice={phase.peerDevice}
          route={phase.name === 'connected' ? phase.route : undefined}
          safetyCode={phase.name === 'connected' ? phase.safetyCode : undefined}
          reconnecting={phase.name === 'connected' && phase.reconnecting}
          ended={phase.name === 'ended' ? { reason: phase.reason } : undefined}
          onEnd={endSession}
          endedAction={<span className="ended-hint">Scan a new code to connect again.</span>}
        />
      );
    case 'error': {
      const e = ERRORS[phase.kind];
      return (
        <StatusScreen tone="warn" title={e.title}>
          <p>{e.body}</p>
        </StatusScreen>
      );
    }
    default:
      return null;
  }
}
