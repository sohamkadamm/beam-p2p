import { Link } from 'react-router-dom';

export function Wordmark({ to = '/' }: { to?: string }) {
  return (
    <Link to={to} className="wordmark" aria-label="Beam home">
      <svg viewBox="0 0 44 20" aria-hidden="true" className="wordmark-glyph">
        <circle cx="7" cy="10" r="6" className="dot-a" />
        <rect x="7" y="7.5" width="30" height="5" rx="2.5" className="beam" />
        <circle cx="37" cy="10" r="6" className="dot-b" />
      </svg>
      <span>Beam</span>
    </Link>
  );
}

export function TopBar({ children }: { children?: React.ReactNode }) {
  return (
    <header className="topbar">
      <Wordmark />
      <div className="topbar-end">{children}</div>
    </header>
  );
}
