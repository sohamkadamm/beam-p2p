import type { PickedFile } from './transfers';

/** Files from a normal <input type="file">, including folder pickers (webkitRelativePath). */
export function fromFileList(list: FileList | null): PickedFile[] {
  if (!list) return [];
  return Array.from(list).map((file) => ({ file, path: file.webkitRelativePath || file.name }));
}

/** Files and whole folders dropped onto the page, keeping folder paths. */
export async function fromDataTransfer(dt: DataTransfer): Promise<PickedFile[]> {
  const entries = Array.from(dt.items)
    .filter((i) => i.kind === 'file')
    .map((i) => i.webkitGetAsEntry?.())
    .filter((e): e is FileSystemEntry => !!e);

  // Browsers without the entries API: fall back to plain files.
  if (!entries.length) return fromFileList(dt.files);

  const out: PickedFile[] = [];
  for (const entry of entries) await walk(entry, out);
  return out;
}

async function walk(entry: FileSystemEntry, out: PickedFile[]): Promise<void> {
  if (entry.isFile) {
    const file = await new Promise<File>((resolve, reject) => (entry as FileSystemFileEntry).file(resolve, reject));
    out.push({ file, path: entry.fullPath.replace(/^\/+/, '') || file.name });
    return;
  }
  if (entry.isDirectory) {
    const reader = (entry as FileSystemDirectoryEntry).createReader();
    // readEntries returns results in batches; keep reading until it's empty.
    for (;;) {
      const batch = await new Promise<FileSystemEntry[]>((resolve, reject) => reader.readEntries(resolve, reject));
      if (!batch.length) break;
      for (const child of batch) await walk(child, out);
    }
  }
}

/** Top-level names in a set of picked files, for a short summary like "WT_Project and 3 files". */
export function topLevelNames(paths: string[]): string[] {
  return [...new Set(paths.map((p) => p.split('/')[0]))];
}
