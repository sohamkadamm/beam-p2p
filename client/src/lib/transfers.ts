import { createSHA256, type IHasher } from 'hash-wasm';
import type { BeamPeer } from './peer';
import { makeId } from './id';

/* ------------------------------------------------------------------ */
/* Types                                                               */
/* ------------------------------------------------------------------ */

export type Direction = 'out' | 'in';

export type TransferStatus =
  | 'queued' // outgoing, waiting for an earlier transfer to finish
  | 'waiting' // outgoing, waiting for the other device to accept
  | 'pending' // incoming, waiting for this device to accept
  | 'active'
  | 'finishing' // outgoing, all bytes sent, waiting for the receiver's confirmation
  | 'done'
  | 'declined'
  | 'cancelled'
  | 'failed';

export interface TransferFile {
  index: number;
  name: string;
  path: string; // folder path inside the transfer, e.g. "WT_Project/src/App.tsx"
  size: number;
  type: string;
  done: number;
  status: 'queued' | 'active' | 'done' | 'cancelled' | 'failed';
  verified?: boolean;
  url?: string; // object URL of the received file, or a preview of a sent image
}

export interface Transfer {
  id: string;
  direction: Direction;
  files: TransferFile[];
  totalBytes: number;
  doneBytes: number;
  status: TransferStatus;
  speed: number; // bytes per second, smoothed
  createdAt: number;
  startedAt?: number;
  finishedAt?: number;
  error?: string;
}

export interface PickedFile {
  file: File;
  path: string;
}

export interface TransferLog {
  fileCount: number;
  totalBytes: number;
  durationMs: number;
  avgSpeedBps: number;
  allVerified: boolean;
}

type WireFile = { name: string; path: string; size: number; type: string };
type Msg =
  | { t: 'offer'; id: string; files: WireFile[]; total: number }
  | { t: 'reply'; id: string; accept: boolean }
  | { t: 'file'; id: string; index: number }
  | { t: 'file-end'; id: string; index: number; sha256: string }
  | { t: 'done'; id: string }
  | { t: 'complete'; id: string; allVerified: boolean }
  | { t: 'cancel'; id: string }
  | { t: 'bye' };

export const MAX_TRANSFER_BYTES = 2 * 1024 ** 3; // 2 GB: received files are held in browser memory
const MAX_FILES = 5000;
const READ_SLICE = 1 << 20; // read 1 MB from disk at a time
const PREVIEW_LIMIT = 40 * 1024 ** 2;

/* ------------------------------------------------------------------ */
/* Manager                                                             */
/* ------------------------------------------------------------------ */

interface OutState {
  transfer: Transfer;
  picked: PickedFile[];
  cancelled: boolean;
  queuedBytes: number;
  resolveReply?: (accepted: boolean) => void;
  resolveComplete?: (allVerified: boolean) => void;
}

interface InState {
  transfer: Transfer;
  parts: ArrayBuffer[];
  current: TransferFile | null;
}

/**
 * Sends and receives files over a BeamPeer.
 *
 * Protocol (JSON control messages + raw binary chunks):
 *   sender  -> offer {files}         receiver -> reply {accept}
 *   sender  -> file {index}, <binary chunks...>, file-end {sha256}   (for each file)
 *   sender  -> done                  receiver -> complete {allVerified}
 * Either side can send cancel. Every file's SHA-256 is checked on arrival.
 */
export class TransferManager {
  private outgoing = new Map<string, OutState>();
  private incoming = new Map<string, InState>();
  private queue: OutState[] = [];
  private sending = false;
  private currentIn: InState | null = null;
  private listeners = new Set<() => void>();
  private snapshot: Transfer[] = [];
  private ticker: number | undefined;
  private lastSample = new Map<string, { t: number; bytes: number }>();

  private constructor(
    private readonly peer: BeamPeer,
    private readonly sendHasher: IHasher,
    private readonly recvHasher: IHasher,
    private readonly onLog: (log: TransferLog) => void,
    private readonly onBye: () => void,
  ) {}

  static async create(peer: BeamPeer, onLog: (log: TransferLog) => void, onBye: () => void) {
    const [a, b] = await Promise.all([createSHA256(), createSHA256()]);
    return new TransferManager(peer, a, b, onLog, onBye);
  }

  /* ---------- store interface for React (useSyncExternalStore) ---------- */

  subscribe = (fn: () => void) => {
    this.listeners.add(fn);
    return () => this.listeners.delete(fn);
  };

  getSnapshot = () => this.snapshot;

  private emit() {
    const all = [...this.outgoing.values(), ...this.incoming.values()].map((s) => ({
      ...s.transfer,
      files: s.transfer.files.map((f) => ({ ...f })),
    }));
    all.sort((a, b) => b.createdAt - a.createdAt);
    this.snapshot = all;
    this.listeners.forEach((fn) => fn());
    this.updateTicker();
  }

  /** While anything is moving, refresh progress and speed 4 times a second. */
  private updateTicker() {
    const busy = this.snapshot.some((t) => t.status === 'active' || t.status === 'finishing');
    if (busy && this.ticker === undefined) {
      this.ticker = window.setInterval(() => this.tick(), 250);
    } else if (!busy && this.ticker !== undefined) {
      window.clearInterval(this.ticker);
      this.ticker = undefined;
    }
  }

  private tick() {
    const now = performance.now();
    for (const s of this.outgoing.values()) {
      if (s.transfer.status !== 'active' && s.transfer.status !== 'finishing') continue;
      // Bytes handed to the browser minus what's still waiting in its send queue = bytes on the wire.
      s.transfer.doneBytes = Math.max(0, Math.min(s.transfer.totalBytes, s.queuedBytes - this.peer.bufferedAmount));
      this.sampleSpeed(s.transfer, now);
    }
    for (const s of this.incoming.values()) {
      if (s.transfer.status === 'active') this.sampleSpeed(s.transfer, now);
    }
    this.emit();
  }

  private sampleSpeed(t: Transfer, now: number) {
    const prev = this.lastSample.get(t.id);
    this.lastSample.set(t.id, { t: now, bytes: t.doneBytes });
    if (!prev) return;
    const dt = (now - prev.t) / 1000;
    if (dt <= 0) return;
    const instant = (t.doneBytes - prev.bytes) / dt;
    t.speed = t.speed ? t.speed * 0.7 + instant * 0.3 : instant;
  }

  /* ---------- sending ---------- */

  /** Returns an error message, or null when the files were queued. */
  send(picked: PickedFile[]): string | null {
    if (!picked.length) return null;
    if (!this.peer.isOpen) return 'The other device is no longer connected.';
    if (picked.length > MAX_FILES) return `Send up to ${MAX_FILES} files at a time.`;
    const total = picked.reduce((a, p) => a + p.file.size, 0);
    if (total > MAX_TRANSFER_BYTES) return 'Send up to 2 GB at a time. Split larger sets into smaller groups.';

    const transfer: Transfer = {
      id: makeId(),
      direction: 'out',
      files: picked.map((p, index) => ({
        index,
        name: p.file.name,
        path: p.path,
        size: p.file.size,
        type: p.file.type,
        done: 0,
        status: 'queued',
        url: p.file.type.startsWith('image/') && p.file.size < PREVIEW_LIMIT ? URL.createObjectURL(p.file) : undefined,
      })),
      totalBytes: total,
      doneBytes: 0,
      status: 'queued',
      speed: 0,
      createdAt: Date.now(),
    };
    const state: OutState = { transfer, picked, cancelled: false, queuedBytes: 0 };
    this.outgoing.set(transfer.id, state);
    this.queue.push(state);
    this.emit();
    void this.runQueue();
    return null;
  }

  private async runQueue() {
    if (this.sending) return;
    this.sending = true;
    while (this.queue.length) {
      const next = this.queue.shift()!;
      if (next.cancelled) continue;
      try {
        await this.sendOne(next);
      } catch (err) {
        if (!next.cancelled && !isFinal(next.transfer.status)) {
          next.transfer.status = 'failed';
          next.transfer.error = this.peer.isOpen ? 'Sending stopped unexpectedly.' : 'Connection lost.';
          this.emit();
        }
        console.warn('[beam] send failed', err);
      }
    }
    this.sending = false;
  }

  private async sendOne(s: OutState) {
    const t = s.transfer;
    t.status = 'waiting';
    this.emit();

    const accepted = await new Promise<boolean>((resolve) => {
      s.resolveReply = resolve;
      this.peer.sendJson({
        t: 'offer',
        id: t.id,
        total: t.totalBytes,
        files: t.files.map(({ name, path, size, type }) => ({ name, path, size, type })),
      } satisfies Msg);
    });
    s.resolveReply = undefined;
    if (s.cancelled) return;
    if (!accepted) {
      t.status = 'declined';
      this.emit();
      return;
    }

    t.status = 'active';
    t.startedAt = performance.now();
    this.emit();
    const chunkSize = this.peer.chunkSize;

    for (const f of t.files) {
      if (s.cancelled) return;
      const file = s.picked[f.index].file;
      f.status = 'active';
      this.peer.sendJson({ t: 'file', id: t.id, index: f.index } satisfies Msg);
      this.sendHasher.init();

      for (let offset = 0; offset < file.size; offset += READ_SLICE) {
        const buf = await file.slice(offset, offset + READ_SLICE).arrayBuffer();
        this.sendHasher.update(new Uint8Array(buf));
        for (let i = 0; i < buf.byteLength; i += chunkSize) {
          if (s.cancelled) return;
          await this.peer.drain();
          if (s.cancelled) return;
          const chunk = buf.slice(i, i + chunkSize);
          this.peer.sendBinary(chunk);
          s.queuedBytes += chunk.byteLength;
        }
        f.done = Math.min(f.size, offset + buf.byteLength);
      }

      this.peer.sendJson({ t: 'file-end', id: t.id, index: f.index, sha256: this.sendHasher.digest('hex') } satisfies Msg);
      f.status = 'done';
      f.done = f.size;
    }

    t.status = 'finishing';
    this.emit();
    const allVerified = await new Promise<boolean>((resolve) => {
      s.resolveComplete = resolve;
      this.peer.sendJson({ t: 'done', id: t.id } satisfies Msg);
    });
    s.resolveComplete = undefined;
    if (s.cancelled) return;
    t.status = 'done';
    t.doneBytes = t.totalBytes;
    t.finishedAt = performance.now();
    t.files.forEach((f) => (f.verified = allVerified));
    t.speed = averageSpeed(t);
    this.emit();
  }

  /* ---------- receiving ---------- */

  accept(id: string) {
    const s = this.incoming.get(id);
    if (!s || s.transfer.status !== 'pending') return;
    s.transfer.status = 'active';
    s.transfer.startedAt = performance.now();
    this.currentIn = s;
    this.peer.sendJson({ t: 'reply', id, accept: true } satisfies Msg);
    this.emit();
  }

  decline(id: string) {
    const s = this.incoming.get(id);
    if (!s || s.transfer.status !== 'pending') return;
    s.transfer.status = 'declined';
    this.peer.sendJson({ t: 'reply', id, accept: false } satisfies Msg);
    this.emit();
  }

  /** Stop a transfer from either side. */
  cancel(id: string) {
    const out = this.outgoing.get(id);
    if (out && !isFinal(out.transfer.status)) {
      out.cancelled = true;
      out.transfer.status = 'cancelled';
      out.resolveReply?.(false);
      out.resolveComplete?.(false);
      this.peer.sendJson({ t: 'cancel', id } satisfies Msg);
      this.emit();
      return;
    }
    const inc = this.incoming.get(id);
    if (inc && !isFinal(inc.transfer.status)) {
      this.dropIncoming(inc, 'cancelled');
      this.peer.sendJson({ t: 'cancel', id } satisfies Msg);
      this.emit();
    }
  }

  /** Remove a finished transfer from the list and free its memory. */
  dismiss(id: string) {
    const s = this.outgoing.get(id) ?? this.incoming.get(id);
    if (!s || !isFinal(s.transfer.status)) return;
    s.transfer.files.forEach((f) => f.url && URL.revokeObjectURL(f.url));
    this.outgoing.delete(id);
    this.incoming.delete(id);
    this.emit();
  }

  sayBye() {
    this.peer.sendJson({ t: 'bye' } satisfies Msg);
  }

  /** Feed every message from the other device in here. */
  handle(data: string | ArrayBuffer) {
    if (typeof data !== 'string') return this.onChunk(data);
    let msg: Msg;
    try {
      msg = JSON.parse(data);
    } catch {
      return;
    }
    switch (msg.t) {
      case 'offer':
        return this.onOffer(msg);
      case 'reply':
        return this.outgoing.get(msg.id)?.resolveReply?.(!!msg.accept);
      case 'complete':
        return this.outgoing.get(msg.id)?.resolveComplete?.(!!msg.allVerified);
      case 'file': {
        const s = this.incoming.get(msg.id);
        const f = s?.transfer.files[msg.index];
        if (!s || !f || s.transfer.status !== 'active') return;
        this.currentIn = s;
        s.current = f;
        s.parts = [];
        f.status = 'active';
        this.recvHasher.init();
        return;
      }
      case 'file-end':
        return this.onFileEnd(msg);
      case 'done':
        return this.onDone(msg.id);
      case 'cancel':
        return this.onRemoteCancel(msg.id);
      case 'bye':
        return this.onBye();
    }
  }

  private onOffer(msg: Extract<Msg, { t: 'offer' }>) {
    if (this.incoming.has(msg.id) || !Array.isArray(msg.files) || msg.files.length > MAX_FILES) return;
    const files: TransferFile[] = msg.files.map((f, index) => {
      const path = cleanPath(String(f.path || f.name));
      return {
        index,
        name: cleanName(String(f.name)) || `file-${index + 1}`,
        path: path || cleanName(String(f.name)) || `file-${index + 1}`,
        size: Math.max(0, Number(f.size) || 0),
        type: String(f.type || '').slice(0, 100),
        done: 0,
        status: 'queued',
      };
    });
    const total = files.reduce((a, f) => a + f.size, 0);
    const transfer: Transfer = {
      id: msg.id,
      direction: 'in',
      files,
      totalBytes: total,
      doneBytes: 0,
      status: 'pending',
      speed: 0,
      createdAt: Date.now(),
    };
    this.incoming.set(msg.id, { transfer, parts: [], current: null });
    if (total > MAX_TRANSFER_BYTES) {
      transfer.status = 'declined';
      transfer.error = 'Larger than 2 GB, so it was declined automatically.';
      this.peer.sendJson({ t: 'reply', id: msg.id, accept: false } satisfies Msg);
    }
    this.emit();
  }

  private onChunk(buf: ArrayBuffer) {
    const s = this.currentIn;
    const f = s?.current;
    if (!s || !f || s.transfer.status !== 'active') return;
    s.parts.push(buf);
    this.recvHasher.update(new Uint8Array(buf));
    f.done += buf.byteLength;
    s.transfer.doneBytes += buf.byteLength;
  }

  private onFileEnd(msg: Extract<Msg, { t: 'file-end' }>) {
    const s = this.incoming.get(msg.id);
    const f = s?.current;
    if (!s || !f || f.index !== msg.index) return;
    const blob = new Blob(s.parts, { type: f.type || 'application/octet-stream' });
    s.parts = [];
    s.current = null;
    f.verified = this.recvHasher.digest('hex') === msg.sha256 && blob.size === f.size;
    f.status = f.verified ? 'done' : 'failed';
    f.done = f.size;
    f.url = URL.createObjectURL(blob);
    this.emit();
  }

  private onDone(id: string) {
    const s = this.incoming.get(id);
    if (!s || s.transfer.status !== 'active') return;
    const t = s.transfer;
    t.status = 'done';
    t.doneBytes = t.totalBytes;
    t.finishedAt = performance.now();
    t.speed = averageSpeed(t);
    const allVerified = t.files.every((f) => f.verified);
    if (!allVerified) t.error = 'Some files did not match what was sent. Ask for them again.';
    if (this.currentIn === s) this.currentIn = null;
    this.peer.sendJson({ t: 'complete', id, allVerified } satisfies Msg);
    this.onLog({
      fileCount: t.files.length,
      totalBytes: t.totalBytes,
      durationMs: Math.round((t.finishedAt ?? 0) - (t.startedAt ?? 0)),
      avgSpeedBps: Math.round(t.speed),
      allVerified,
    });
    this.emit();
  }

  private onRemoteCancel(id: string) {
    const out = this.outgoing.get(id);
    if (out && !isFinal(out.transfer.status)) {
      out.cancelled = true;
      out.transfer.status = 'cancelled';
      out.transfer.error = 'The other device stopped this transfer.';
      out.resolveReply?.(false);
      out.resolveComplete?.(false);
    }
    const inc = this.incoming.get(id);
    if (inc && !isFinal(inc.transfer.status)) {
      this.dropIncoming(inc, 'cancelled');
      inc.transfer.error = 'The sender stopped this transfer.';
    }
    this.emit();
  }

  private dropIncoming(s: InState, status: TransferStatus) {
    s.parts = [];
    s.current = null;
    s.transfer.status = status;
    s.transfer.files.forEach((f) => {
      if (f.status !== 'done') f.status = 'cancelled';
    });
    if (this.currentIn === s) this.currentIn = null;
  }

  /** Called when the connection ends. Anything unfinished is marked as failed. */
  shutdown() {
    for (const s of this.outgoing.values()) {
      if (!isFinal(s.transfer.status)) {
        s.cancelled = true;
        s.transfer.status = 'failed';
        s.transfer.error = 'Connection lost before it finished.';
        s.resolveReply?.(false);
        s.resolveComplete?.(false);
      }
    }
    for (const s of this.incoming.values()) {
      if (!isFinal(s.transfer.status)) {
        this.dropIncoming(s, 'failed');
        s.transfer.error = 'Connection lost before it finished.';
      }
    }
    this.queue = [];
    this.emit();
    if (this.ticker !== undefined) window.clearInterval(this.ticker);
    this.ticker = undefined;
  }
}

/* ------------------------------------------------------------------ */
/* Helpers                                                             */
/* ------------------------------------------------------------------ */

export function isFinal(s: TransferStatus) {
  return s === 'done' || s === 'declined' || s === 'cancelled' || s === 'failed';
}

function averageSpeed(t: Transfer) {
  const secs = ((t.finishedAt ?? 0) - (t.startedAt ?? 0)) / 1000;
  return secs > 0 ? t.totalBytes / secs : t.speed;
}

function cleanName(name: string) {
  return name.replace(/[\u0000-\u001f<>:"/\\|?*]/g, '_').replace(/^\.+$/, '_').slice(0, 200);
}

/** Keeps the folder structure but blocks tricks like "../../" in incoming paths. */
function cleanPath(p: string) {
  return p
    .replace(/\\/g, '/')
    .split('/')
    .filter((part) => part && part !== '.' && part !== '..')
    .map(cleanName)
    .join('/')
    .slice(0, 500);
}
