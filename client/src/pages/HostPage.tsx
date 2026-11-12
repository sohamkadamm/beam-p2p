import { useBeamSession } from '../hooks/useBeamSession';
import { QrAperture } from '../components/QrAperture';
import { ApprovalDialog } from '../components/ApprovalDialog';
import { SessionView } from '../components/SessionView';
import { StatusScreen } from '../components/StatusScreen';
import { TopBar } from '../components/Wordmark';
import { Link } from 'react-router-dom';

/** The screen (lab PC, laptop, projector). Shows the QR code, then the transfer view. */
export default function HostPage() {
  const { phase, manager, respond, endSession, restart } = useBeamSession('host');

  if (phase.name === 'qr' || phase.name === 'approval' || phase.name === 'starting') {
    return (
      <div className="page page-host">
        <TopBar>
          <Link className="topbar-link" to="/stats">Usage</Link>
        </TopBar>
        <main className="pair">
          <div className="pair-copy">
            <h1 className="pair-title">Scan to connect your phone</h1>
            <ol className="pair-steps">
              <li>Open your phone’s camera and point it at the code.</li>
              <li>Tap the link that appears.</li>
              <li>Press Allow on this screen.</li>
            </ol>
            <p className="pair-note">
              Files travel straight between the two devices. Nothing is uploaded, and there’s no app or account.
            </p>
          </div>
          <div className="pair-code">
            {phase.name === 'starting' ? (
              <div className="aperture aperture-loading" aria-label="Preparing a code" />
            ) : (
              <QrAperture url={phase.url} expiresAt={phase.expiresAt} ttlSeconds={phase.ttlSeconds} />
            )}
          </div>
        </main>
        {phase.name === 'approval' && (
          <ApprovalDialog device={phase.device} onAllow={() => respond(true)} onDecline={() => respond(false)} />
        )}
      </div>
    );
  }

  if (phase.name === 'connecting') {
    return (
      <StatusScreen busy title={`Connecting to ${phase.peerDevice}`}>
        <p>Setting up a direct link between the two devices.</p>
      </StatusScreen>
    );
  }

  if (phase.name === 'connected' || phase.name === 'ended') {
    return (
      <SessionView
        manager={manager}
        peerDevice={phase.peerDevice}
        route={phase.name === 'connected' ? phase.route : undefined}
          safetyCode={phase.name === 'connected' ? phase.safetyCode : undefined}
          reconnecting={phase.name === 'connected' && phase.reconnecting}
        ended={phase.name === 'ended' ? { reason: phase.reason } : undefined}
        onEnd={endSession}
        endedAction={
          <button className="btn btn-primary btn-small" onClick={restart}>
            Show a new code
          </button>
        }
      />
    );
  }

  if (phase.name === 'error') {
    const failed = phase.kind === 'failed';
    return (
      <StatusScreen
        tone="warn"
        title={failed ? 'The devices couldn’t reach each other' : phase.kind === 'unsupported' ? 'This browser can’t run Beam' : 'Can’t reach the Beam server'}
        action={
          phase.kind !== 'unsupported' && (
            <button className="btn btn-primary" onClick={restart}>
              Try again
            </button>
          )
        }
      >
        {failed && <p>Connect both devices to the same Wi-Fi or phone hotspot, then scan a new code.</p>}
        {phase.kind === 'unsupported' && <p>Open this page in a recent version of Chrome, Edge, Safari or Firefox.</p>}
        {phase.kind === 'server' && <p>Check this computer’s internet connection, then try again.</p>}
      </StatusScreen>
    );
  }

  return null;
}
