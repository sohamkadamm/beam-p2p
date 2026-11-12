/** Short random id. Works on plain http too (crypto.randomUUID needs https). */
export function makeId(): string {
  const bytes = new Uint8Array(9);
  crypto.getRandomValues(bytes);
  return Array.from(bytes, (b) => b.toString(36).padStart(2, '0')).join('');
}
