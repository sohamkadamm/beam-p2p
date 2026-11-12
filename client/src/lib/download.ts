export function saveBlob(blob: Blob, filename: string): void {
  const url = URL.createObjectURL(blob);
  saveUrl(url, filename);
  setTimeout(() => URL.revokeObjectURL(url), 60_000);
}

export function saveUrl(url: string, filename: string): void {
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  a.rel = 'noopener';
  document.body.appendChild(a);
  a.click();
  a.remove();
}
