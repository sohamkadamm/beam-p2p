import JSZip from 'jszip';
import type { TransferFile } from './transfers';
import { saveBlob } from './download';

/** Bundles received files into one ZIP, keeping their folder structure. */
export async function downloadAsZip(files: TransferFile[], onProgress?: (percent: number) => void): Promise<void> {
  const zip = new JSZip();
  const used = new Set<string>();
  for (const f of files) {
    if (!f.url || f.status !== 'done') continue;
    const blob = await (await fetch(f.url)).blob();
    zip.file(uniquePath(f.path || f.name, used), blob, { binary: true });
  }
  // STORE (no compression): photos and videos are already compressed, and this is much faster.
  const out = await zip.generateAsync({ type: 'blob', compression: 'STORE', streamFiles: true }, (m) =>
    onProgress?.(m.percent),
  );
  saveBlob(out, zipName(files));
}

function zipName(files: TransferFile[]): string {
  const roots = [...new Set(files.map((f) => (f.path || f.name).split('/')[0]))];
  const stamp = new Date().toISOString().slice(0, 16).replace(/[-:T]/g, '');
  return roots.length === 1 && files.length > 1 ? `${roots[0]}.zip` : `beam-${stamp}.zip`;
}

function uniquePath(path: string, used: Set<string>): string {
  if (!used.has(path)) {
    used.add(path);
    return path;
  }
  const dot = path.lastIndexOf('.');
  const base = dot > path.lastIndexOf('/') ? path.slice(0, dot) : path;
  const ext = dot > path.lastIndexOf('/') ? path.slice(dot) : '';
  for (let n = 2; ; n++) {
    const candidate = `${base} (${n})${ext}`;
    if (!used.has(candidate)) {
      used.add(candidate);
      return candidate;
    }
  }
}
