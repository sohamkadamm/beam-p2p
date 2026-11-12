import { useEffect, useState } from 'react';
import QRCode from 'qrcode';
import { formatClock } from '../lib/format';

const R = 47;
const CIRC = 2 * Math.PI * R;

/** The QR code inside a ring that drains as the code gets close to refreshing. */
export function QrAperture({ url, expiresAt, ttlSeconds }: { url: string; expiresAt: number; ttlSeconds: number }) {
  const [svg, setSvg] = useState('');
  const [left, setLeft] = useState(() => (expiresAt - Date.now()) / 1000);

  useEffect(() => {
    let alive = true;
    QRCode.toString(url, {
      type: 'svg',
      margin: 0,
      errorCorrectionLevel: 'M',
      color: { dark: '#142033', light: '#ffffff' },
    }).then((s) => alive && setSvg(s));
    return () => {
      alive = false;
    };
  }, [url]);

  useEffect(() => {
    const tick = () => setLeft(Math.max(0, (expiresAt - Date.now()) / 1000));
    tick();
    const id = window.setInterval(tick, 1000);
    return () => window.clearInterval(id);
  }, [expiresAt]);

  const fraction = Math.max(0, Math.min(1, left / ttlSeconds));
  const low = left <= 30;

  return (
    <figure className="aperture" data-room-url={url}>
      <svg className={`aperture-ring${low ? ' is-low' : ''}`} viewBox="0 0 100 100" aria-hidden="true">
        <circle cx="50" cy="50" r={R} className="ring-track" />
        <circle
          cx="50"
          cy="50"
          r={R}
          className="ring-fill"
          strokeDasharray={CIRC}
          strokeDashoffset={CIRC * (1 - fraction)}
          transform="rotate(-90 50 50)"
        />
      </svg>
      <div className="qr-card">
        {svg ? (
          <div className="qr" role="img" aria-label="QR code to connect your phone" dangerouslySetInnerHTML={{ __html: svg }} />
        ) : (
          <div className="qr qr-placeholder" />
        )}
      </div>
      <figcaption className="aperture-caption">
        New code in <span className="tabular">{formatClock(left)}</span>
      </figcaption>
    </figure>
  );
}
