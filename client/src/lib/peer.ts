import type { Socket } from 'socket.io-client';
import { sha256 } from 'hash-wasm';

export type Role = 'host' | 'guest';

type Signal = { sdp?: RTCSessionDescriptionInit; candidate?: RTCIceCandidateInit };

export interface PeerHandlers {
  onOpen: () => void;
  onMessage: (data: string | ArrayBuffer) => void;
  onClose: (reason: 'closed' | 'failed') => void;
  /** The direct link dropped and Beam is trying to restore it. */
  onReconnecting: () => void;
  onRecovered: () => void;
}

const GIVE_UP_MS = 25_000; // how long to keep trying to restore a dropped link

/**
 * The direct device-to-device connection.
 *
 * Two data channels are pre-agreed (negotiated) so both sides can send at the same time:
 *   channel 0 carries everything the host sends, channel 1 everything the guest sends.
 * The socket is only used to exchange the offer/answer and network candidates.
 */
export class BeamPeer {
  readonly pc: RTCPeerConnection;
  private readonly out: RTCDataChannel;
  private readonly in: RTCDataChannel;
  private pendingCandidates: RTCIceCandidateInit[] = [];
  private opened = false;
  private closed = false;
  private troubleSince: number | undefined;
  private giveUpTimer: number | undefined;
  private restartTimer: number | undefined;

  constructor(
    private readonly role: Role,
    private readonly socket: Socket,
    iceServers: RTCIceServer[],
    private readonly handlers: PeerHandlers,
  ) {
    this.pc = new RTCPeerConnection({ iceServers });
    const hostChannel = this.pc.createDataChannel('host-to-guest', { negotiated: true, id: 0, ordered: true });
    const guestChannel = this.pc.createDataChannel('guest-to-host', { negotiated: true, id: 1, ordered: true });
    this.out = role === 'host' ? hostChannel : guestChannel;
    this.in = role === 'host' ? guestChannel : hostChannel;

    for (const ch of [this.out, this.in]) {
      ch.binaryType = 'arraybuffer';
      ch.onopen = () => this.checkOpen();
      ch.onclose = () => this.finish(this.troubleSince ? 'failed' : 'closed');
    }
    this.out.bufferedAmountLowThreshold = 1 << 20; // resume sending when under 1 MB queued
    this.in.onmessage = (e) => this.handlers.onMessage(e.data);

    this.pc.onicecandidate = (e) => {
      if (e.candidate) this.socket.emit('signal', { candidate: e.candidate.toJSON() } satisfies Signal);
    };
    this.pc.onconnectionstatechange = () => {
      const s = this.pc.connectionState;
      if (s === 'connected') this.recovered();
      else if (s === 'disconnected' || s === 'failed') {
        if (this.opened) this.trouble(s);
        else if (s === 'failed') this.finish('failed');
      }
    };

    this.onSignal = this.onSignal.bind(this);
    this.socket.on('signal', this.onSignal);
  }

  /** The host makes the offer; the guest waits for it. */
  async start(): Promise<void> {
    if (this.role !== 'host') return;
    const offer = await this.pc.createOffer();
    await this.pc.setLocalDescription(offer);
    this.socket.emit('signal', { sdp: this.pc.localDescription!.toJSON() } satisfies Signal);
  }

  private async onSignal({ sdp, candidate }: Signal): Promise<void> {
    try {
      if (sdp) {
        await this.pc.setRemoteDescription(sdp);
        if (sdp.type === 'offer') {
          const answer = await this.pc.createAnswer();
          await this.pc.setLocalDescription(answer);
          this.socket.emit('signal', { sdp: this.pc.localDescription!.toJSON() } satisfies Signal);
        }
        const queued = this.pendingCandidates;
        this.pendingCandidates = [];
        for (const c of queued) await this.pc.addIceCandidate(c).catch(() => {});
      } else if (candidate) {
        if (this.pc.remoteDescription) await this.pc.addIceCandidate(candidate).catch(() => {});
        else this.pendingCandidates.push(candidate);
      }
    } catch (err) {
      console.error('[beam] signaling error', err);
      this.finish('failed');
    }
  }

  /**
   * The direct link dropped (Wi-Fi switch, phone sleeping, network change).
   * Data channels stay alive for a while, so the host asks for an "ICE restart":
   * both devices look for a new route and the same connection carries on,
   * including any transfer that was in progress.
   */
  private trouble(state: 'disconnected' | 'failed'): void {
    if (this.closed) return;
    if (!this.troubleSince) {
      this.troubleSince = Date.now();
      this.handlers.onReconnecting();
      this.giveUpTimer = window.setTimeout(() => {
        if (this.pc.connectionState !== 'connected') this.finish('failed');
      }, GIVE_UP_MS);
    }
    window.clearTimeout(this.restartTimer);
    // "disconnected" often heals on its own within a second or two; "failed" never does.
    this.restartTimer = window.setTimeout(() => void this.restartIce(), state === 'failed' ? 0 : 2500);
  }

  private recovered(): void {
    if (!this.troubleSince) return;
    this.troubleSince = undefined;
    window.clearTimeout(this.giveUpTimer);
    window.clearTimeout(this.restartTimer);
    this.handlers.onRecovered();
  }

  /** Host only: look for a new network route without dropping the connection. */
  async restartIce(force = false): Promise<void> {
    if (this.role !== 'host' || this.closed) return;
    if (!force && this.pc.connectionState === 'connected') return;
    try {
      const offer = await this.pc.createOffer({ iceRestart: true });
      await this.pc.setLocalDescription(offer);
      this.socket.emit('signal', { sdp: this.pc.localDescription!.toJSON() } satisfies Signal);
    } catch (err) {
      console.warn('[beam] ICE restart failed', err);
    }
  }

  /** Called when the signaling server is reachable again; retries if the link is still down. */
  retryIfStuck(): void {
    if (this.opened && this.troubleSince) void this.restartIce();
  }

  /**
   * A 6-digit code made from both devices' encryption keys (DTLS fingerprints).
   * If both screens show the same code, nobody is sitting in the middle of the connection,
   * not even the Beam server.
   */
  async safetyCode(): Promise<string> {
    const fingerprint = (sdp?: string) => sdp?.match(/a=fingerprint:sha-256 ([0-9A-F:]+)/i)?.[1]?.toUpperCase() ?? '';
    const a = fingerprint(this.pc.localDescription?.sdp);
    const b = fingerprint(this.pc.remoteDescription?.sdp);
    if (!a || !b) return '';
    const digest = await sha256([a, b].sort().join('|'));
    const n = parseInt(digest.slice(0, 12), 16) % 1_000_000;
    const code = n.toString().padStart(6, '0');
    return `${code.slice(0, 3)} ${code.slice(3)}`;
  }

  private checkOpen(): void {
    if (!this.opened && this.out.readyState === 'open' && this.in.readyState === 'open') {
      this.opened = true;
      this.handlers.onOpen();
    }
  }

  get isOpen(): boolean {
    return this.opened && !this.closed;
  }

  /** Largest message both browsers accept. 64 KB keeps every browser pairing happy. */
  get chunkSize(): number {
    const max = this.pc.sctp?.maxMessageSize;
    return max && Number.isFinite(max) && max > 0 ? Math.min(64 * 1024, max) : 64 * 1024;
  }

  /** Bytes handed to the browser that haven't been sent yet. */
  get bufferedAmount(): number {
    return this.out.readyState === 'open' ? this.out.bufferedAmount : 0;
  }

  sendJson(msg: object): void {
    if (this.out.readyState === 'open') this.out.send(JSON.stringify(msg));
  }

  sendBinary(chunk: ArrayBuffer): void {
    this.out.send(chunk);
  }

  /** Waits until the send queue drains below the threshold, so big files don't fill memory. */
  async drain(): Promise<void> {
    const HIGH_WATER = 8 << 20;
    while (this.out.bufferedAmount > HIGH_WATER) {
      if (this.out.readyState !== 'open') throw new Error('Connection closed');
      await new Promise<void>((resolve) => {
        const done = () => {
          this.out.removeEventListener('bufferedamountlow', done);
          this.out.removeEventListener('close', done);
          resolve();
        };
        this.out.addEventListener('bufferedamountlow', done);
        this.out.addEventListener('close', done);
      });
    }
  }

  /** How the two devices ended up connected: directly, or through a relay. */
  async routeType(): Promise<'direct' | 'relay' | 'unknown'> {
    try {
      const stats = await this.pc.getStats();
      let pairId: string | undefined;
      stats.forEach((r) => {
        if (r.type === 'transport' && r.selectedCandidatePairId) pairId = r.selectedCandidatePairId;
      });
      let pair: any;
      stats.forEach((r) => {
        if (r.type === 'candidate-pair' && (r.id === pairId || (!pairId && r.selected) || (!pairId && r.nominated && r.state === 'succeeded'))) pair = r;
      });
      if (!pair) return 'unknown';
      const local = stats.get(pair.localCandidateId);
      const remote = stats.get(pair.remoteCandidateId);
      return local?.candidateType === 'relay' || remote?.candidateType === 'relay' ? 'relay' : 'direct';
    } catch {
      return 'unknown';
    }
  }

  close(): void {
    this.finish('closed');
  }

  private finish(reason: 'closed' | 'failed'): void {
    if (this.closed) return;
    this.closed = true;
    window.clearTimeout(this.giveUpTimer);
    window.clearTimeout(this.restartTimer);
    this.socket.off('signal', this.onSignal);
    try {
      this.out.close();
      this.in.close();
      this.pc.close();
    } catch {
      /* already closed */
    }
    this.handlers.onClose(reason);
  }
}
