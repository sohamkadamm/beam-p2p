import { useState } from 'react';
import type { Transfer, TransferFile, TransferManager } from '../lib/transfers';
import { isFinal } from '../lib/transfers';
import { formatBytes, formatDuration, formatSpeed, plural } from '../lib/format';
import { topLevelNames } from '../lib/picker';
import { saveUrl } from '../lib/download';
import { downloadAsZip } from '../lib/zip';

const VISIBLE_FILES = 6;

export function TransferList({ transfers, manager, peerDevice }: { transfers: Transfer[]; manager: TransferManager; peerDevice: string }) {
  if (!transfers.length) {
    return (
      <section className="transfers is-empty" aria-label="Transfers">
        <p>Files you send or receive show up here. Nothing is stored after you close this page.</p>
      </section>
    );
  }
  return (
    <section className="transfers" aria-label="Transfers">
      {transfers.map((t) => (
        <TransferCard key={t.id} t={t} manager={manager} peerDevice={peerDevice} />
      ))}
    </section>
  );
}

function TransferCard({ t, manager, peerDevice }: { t: Transfer; manager: TransferManager; peerDevice: string }) {
  const [expanded, setExpanded] = useState(false);
  const [zipping, setZipping] = useState<number | null>(null);
  const incoming = t.direction === 'in';
  const pct = t.totalBytes ? Math.round((t.doneBytes / t.totalBytes) * 100) : t.status === 'done' ? 100 : 0;
  const files = expanded ? t.files : t.files.slice(0, VISIBLE_FILES);
  const hidden = t.files.length - files.length;
  const allVerified = t.status === 'done' && t.files.every((f) => f.verified);
  const downloadable = incoming && t.status === 'done' && t.files.some((f) => f.status === 'done');

  async function zipAll() {
    setZipping(0);
    try {
      await downloadAsZip(t.files, (p) => setZipping(Math.round(p)));
    } finally {
      setZipping(null);
    }
  }

  return (
    <article className={`card card-${t.status} card-${t.direction}`} data-transfer-status={t.status} data-direction={t.direction}>
      <header className="card-head">
        <div>
          <p className="card-dir">{incoming ? `From ${peerDevice}` : `To ${peerDevice}`}</p>
          <h3 className="card-title">{summary(t)}</h3>
          <p className="card-meta">
            {plural(t.files.length, 'file')}, {formatBytes(t.totalBytes)}
          </p>
        </div>
        <StatusLine t={t} pct={pct} allVerified={allVerified} />
      </header>

      {(t.status === 'active' || t.status === 'finishing') && (
        <div className="bar" role="progressbar" aria-valuenow={pct} aria-valuemin={0} aria-valuemax={100} aria-label="Overall progress">
          <span style={{ width: `${pct}%` }} />
        </div>
      )}

      {t.error && <p className="card-error">{t.error}</p>}

      <ul className="files">
        {files.map((f) => (
          <FileRow key={f.index} f={f} incoming={incoming} transferDone={t.status === 'done'} />
        ))}
      </ul>
      {hidden > 0 && (
        <button className="link-btn" onClick={() => setExpanded(true)}>
          Show {plural(hidden, 'more file')}
        </button>
      )}

      <footer className="card-actions">
        {t.status === 'pending' && (
          <>
            <button className="btn btn-quiet" onClick={() => manager.decline(t.id)}>Decline</button>
            <button className="btn btn-primary" data-testid="accept" onClick={() => manager.accept(t.id)}>
              Receive {plural(t.files.length, 'file')}
            </button>
          </>
        )}
        {downloadable && t.files.length > 1 && (
          <button className="btn btn-primary" data-testid="zip" disabled={zipping !== null} onClick={zipAll}>
            {zipping === null ? 'Download all as ZIP' : `Preparing ZIP ${zipping}%`}
          </button>
        )}
        {downloadable && t.files.length === 1 && t.files[0].url && (
          <button className="btn btn-primary" onClick={() => saveUrl(t.files[0].url!, t.files[0].name)}>
            Download
          </button>
        )}
        {!isFinal(t.status) && t.status !== 'pending' && (
          <button className="btn btn-quiet" onClick={() => manager.cancel(t.id)}>
            Stop
          </button>
        )}
        {isFinal(t.status) && (
          <button className="btn btn-quiet" onClick={() => manager.dismiss(t.id)}>
            Remove from list
          </button>
        )}
      </footer>
    </article>
  );
}

function StatusLine({ t, pct, allVerified }: { t: Transfer; pct: number; allVerified: boolean }) {
  let text = '';
  let cls = '';
  switch (t.status) {
    case 'queued':
      text = 'Waiting for the previous transfer';
      break;
    case 'waiting':
      text = 'Waiting for the other device to accept';
      break;
    case 'pending':
      text = 'Wants to send you files';
      cls = 'is-attention';
      break;
    case 'active': {
      const remaining = t.speed > 0 ? (t.totalBytes - t.doneBytes) / t.speed : NaN;
      text = [`${pct}%`, formatSpeed(t.speed), Number.isFinite(remaining) ? `${formatDuration(remaining)} left` : '']
        .filter(Boolean)
        .join(', ');
      break;
    }
    case 'finishing':
      text = 'Checking files on the other device';
      break;
    case 'done': {
      const secs = ((t.finishedAt ?? 0) - (t.startedAt ?? 0)) / 1000;
      text = allVerified ? `Verified, in ${formatDuration(secs)}` : 'Finished with problems';
      cls = allVerified ? 'is-good' : 'is-bad';
      break;
    }
    case 'declined':
      text = 'Declined';
      cls = 'is-muted';
      break;
    case 'cancelled':
      text = 'Stopped';
      cls = 'is-muted';
      break;
    case 'failed':
      text = 'Did not finish';
      cls = 'is-bad';
      break;
  }
  return <p className={`card-status ${cls} tabular`}>{text}</p>;
}

function FileRow({ f, incoming, transferDone }: { f: TransferFile; incoming: boolean; transferDone: boolean }) {
  const isImage = f.type.startsWith('image/') && !!f.url;
  const filePct = f.size ? Math.round((f.done / f.size) * 100) : 0;
  const folder = f.path.includes('/') ? f.path.slice(0, f.path.lastIndexOf('/')) : '';

  return (
    <li className={`file file-${f.status}`}>
      {isImage ? <img className="thumb" src={f.url} alt="" loading="lazy" /> : <FileGlyph name={f.name} />}
      <div className="file-text">
        <p className="file-name" title={f.path}>{f.name}</p>
        <p className="file-meta tabular">
          {folder && <span className="file-folder">{folder}/ </span>}
          {formatBytes(f.size)}
          {f.status === 'active' && `, ${filePct}%`}
        </p>
      </div>
      <div className="file-end">
        {f.verified === true && transferDone && (
          <span className="verified" title="SHA-256 fingerprint matches the original">
            <svg viewBox="0 0 16 16" aria-hidden="true"><path d="M3.5 8.5l3 3 6-7" /></svg>
            Verified
          </span>
        )}
        {f.verified === false && <span className="mismatch">Damaged</span>}
        {incoming && f.status === 'done' && f.url && (
          <button className="icon-btn" aria-label={`Download ${f.name}`} onClick={() => saveUrl(f.url!, f.name)}>
            <svg viewBox="0 0 20 20" aria-hidden="true"><path d="M10 3v10M6 9l4 4 4-4M4 16h12" /></svg>
          </button>
        )}
      </div>
    </li>
  );
}

function FileGlyph({ name }: { name: string }) {
  const ext = name.includes('.') ? name.split('.').pop()!.slice(0, 4).toUpperCase() : 'FILE';
  return (
    <span className="glyph" aria-hidden="true">
      {ext}
    </span>
  );
}

function summary(t: Transfer): string {
  if (t.files.length === 1) return t.files[0].name;
  const roots = topLevelNames(t.files.map((f) => f.path));
  if (roots.length === 1) return roots[0];
  const folders = roots.filter((r) => t.files.some((f) => f.path.startsWith(`${r}/`)));
  if (folders.length && folders.length < roots.length) {
    const loose = roots.length - folders.length;
    return `${folders[0]}${folders.length > 1 ? ` and ${plural(folders.length - 1, 'folder')}` : ''} and ${plural(loose, 'file')}`;
  }
  if (t.files.every((f) => f.type.startsWith('image/'))) return plural(t.files.length, 'photo');
  return `${t.files[0].name} and ${plural(t.files.length - 1, 'more file')}`;
}
