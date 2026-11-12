import { useEffect, useState, type FormEvent } from 'react';
import { TopBar } from '../components/Wordmark';
import { formatBytes, formatSpeed } from '../lib/format';
import { Link } from 'react-router-dom';

interface Stats {
  sessions: number;
  transfers: number;
  files: number;
  bytes: number;
  avgSpeedBps: number;
  verifiedRate: number;
  recent: {
    id: number;
    created_at: string;
    file_count: number;
    total_bytes: number;
    duration_ms: number;
    avg_speed_bps: number;
    all_verified: boolean | number;
    from_device: string;
    to_device: string;
  }[];
}

/** Usage numbers from the session logs. File names and contents are never logged. */
export default function StatsPage() {
  const [auth, setAuth] = useState<'checking' | 'out' | 'in'>('checking');
  const [stats, setStats] = useState<Stats | null>(null);
  const [failed, setFailed] = useState(false);

  useEffect(() => {
    if (auth === 'out') return;
    let alive = true;
    const load = () =>
      fetch('/api/stats', { credentials: 'same-origin' })
        .then((r) => {
          if (r.status === 401) {
            if (alive) setAuth('out');
            return null;
          }
          return r.ok ? r.json() : Promise.reject();
        })
        .then((s) => {
          if (alive && s) {
            setStats(s);
            setFailed(false);
            setAuth('in');
          }
        })
        .catch(() => alive && setFailed(true));
    load();
    const id = window.setInterval(load, 5000);
    return () => {
      alive = false;
      window.clearInterval(id);
    };
  }, [auth]);

  async function signOut() {
    await fetch('/api/admin/logout', { method: 'POST' }).catch(() => {});
    setStats(null);
    setAuth('out');
  }

  if (auth === 'out') return <SignIn onSignedIn={() => setAuth('checking')} />;

  return (
    <div className="page">
      <TopBar>
        <Link className="topbar-link" to="/">Back to code</Link>
        {auth === 'in' && (
          <button className="btn btn-quiet btn-small" onClick={signOut}>
            Sign out
          </button>
        )}
      </TopBar>
      <main className="stats">
        <h1 className="stats-title">Usage</h1>
        <p className="stats-lede">Counts and speeds only. File names and contents never reach the server.</p>
        {failed && <p className="card-error">Can’t load usage right now. It retries every few seconds.</p>}
        {stats && (
          <>
            <dl className="figures">
              <div><dt>Data moved</dt><dd className="tabular">{formatBytes(stats.bytes)}</dd></div>
              <div><dt>Files sent</dt><dd className="tabular">{stats.files.toLocaleString()}</dd></div>
              <div><dt>Sessions</dt><dd className="tabular">{stats.sessions.toLocaleString()}</dd></div>
              <div><dt>Average speed</dt><dd className="tabular">{formatSpeed(stats.avgSpeedBps) || '—'}</dd></div>
              <div><dt>Arrived intact</dt><dd className="tabular">{Math.round(stats.verifiedRate * 100)}%</dd></div>
            </dl>
            <h2 className="stats-sub">Recent transfers</h2>
            {stats.recent.length ? (
              <div className="table-wrap">
                <table>
                  <thead>
                    <tr><th>When</th><th>From</th><th>To</th><th>Files</th><th>Size</th><th>Speed</th><th>Intact</th></tr>
                  </thead>
                  <tbody>
                    {stats.recent.map((r) => (
                      <tr key={r.id}>
                        <td className="tabular">{new Date(r.created_at).toLocaleString([], { dateStyle: 'short', timeStyle: 'short' })}</td>
                        <td>{r.from_device}</td>
                        <td>{r.to_device}</td>
                        <td className="tabular">{r.file_count}</td>
                        <td className="tabular">{formatBytes(r.total_bytes)}</td>
                        <td className="tabular">{formatSpeed(r.avg_speed_bps)}</td>
                        <td>{r.all_verified ? 'Yes' : 'No'}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            ) : (
              <p className="stats-empty">No transfers yet. Send something and it appears here.</p>
            )}
          </>
        )}
      </main>
    </div>
  );
}

function SignIn({ onSignedIn }: { onSignedIn: () => void }) {
  const [password, setPassword] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  async function submit(e: FormEvent) {
    e.preventDefault();
    setBusy(true);
    setError(null);
    try {
      const r = await fetch('/api/admin/login', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ password }),
      });
      if (r.ok) return onSignedIn();
      const body = await r.json().catch(() => ({}));
      setError(body.error || 'Couldn’t sign in. Try again.');
    } catch {
      setError('Can’t reach the Beam server. Check the connection and try again.');
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="page">
      <TopBar>
        <Link className="topbar-link" to="/">Back to code</Link>
      </TopBar>
      <main className="signin">
        <form className="signin-card" onSubmit={submit}>
          <h1>Sign in to see usage</h1>
          <p>Enter the admin password. It’s set with ADMIN_PASSWORD on the server, or printed in the server console.</p>
          <label htmlFor="admin-password">Password</label>
          <input
            id="admin-password"
            type="password"
            autoComplete="current-password"
            autoFocus
            required
            value={password}
            onChange={(e) => setPassword(e.target.value)}
          />
          {error && (
            <p className="signin-error" role="alert">
              {error}
            </p>
          )}
          <button className="btn btn-primary" type="submit" disabled={busy || !password}>
            {busy ? 'Signing in…' : 'Sign in'}
          </button>
        </form>
      </main>
    </div>
  );
}
