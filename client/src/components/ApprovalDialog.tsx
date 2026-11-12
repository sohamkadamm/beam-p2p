import { useEffect, useRef } from 'react';

export function ApprovalDialog({ device, onAllow, onDecline }: { device: string; onAllow: () => void; onDecline: () => void }) {
  const allowRef = useRef<HTMLButtonElement>(null);
  useEffect(() => allowRef.current?.focus(), []);

  return (
    <div className="scrim" role="presentation">
      <div className="dialog" role="alertdialog" aria-labelledby="approve-title" aria-describedby="approve-body">
        <div className="dialog-device" aria-hidden="true">
          <svg viewBox="0 0 24 24"><rect x="6" y="2" width="12" height="20" rx="3" /><line x1="10" y1="18" x2="14" y2="18" /></svg>
        </div>
        <h2 id="approve-title">{device} wants to connect</h2>
        <p id="approve-body">Allow only if this is your device. It will be able to send files to this screen and receive files you choose to send.</p>
        <div className="dialog-actions">
          <button className="btn btn-quiet" onClick={onDecline}>Decline</button>
          <button className="btn btn-primary" ref={allowRef} onClick={onAllow}>Allow</button>
        </div>
      </div>
    </div>
  );
}
