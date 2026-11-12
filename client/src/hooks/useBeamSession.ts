import { useCallback, useEffect, useRef, useState } from 'react';
import type { Socket } from 'socket.io-client';
import { connectSocket, emitWithAck } from '../lib/socket';
import { BeamPeer, type Role } from '../lib/peer';
import { TransferManager } from '../lib/transfers';
import { deviceName } from '../lib/device';

export type Route = 'direct' | 'relay' | 'unknown';

export type Phase =
  | { name: 'starting' }
  | { name: 'qr'; url: string; expiresAt: number; ttlSeconds: number }
  | { name: 'approval'; url: string; expiresAt: number; ttlSeconds: number; device: string }
  | { name: 'joining' }
  | { name: 'waiting-approval'; hostDevice: string }
  | { name: 'connecting'; peerDevice: string }
  | { name: 'connected'; peerDevice: string; route: Route; safetyCode: string; reconnecting: boolean }
  | { name: 'ended'; peerDevice: string; reason: 'left' | 'lost' }
  | { name: 'error'; kind: ErrorKind };

export type ErrorKind = 'expired' | 'busy' | 'rejected' | 'server' | 'unsupported' | 'failed' | 'same-device';

interface QrInfo {
  url: string;
  expiresAt: number;
  ttlSeconds: number;
}

interface Resume {
  token: string;
  role: Role;
  secret: string;
}

declare global {
  interface Window {
    /** Handles for automated tests and debugging in the browser console. */
    __beam?: { socket: Socket; peer: BeamPeer | null };
  }
}

/**
 * Runs one Beam session from pairing to goodbye.
 *  host  = the screen that shows the QR code
 *  guest = the phone that scanned it (token comes from the URL)
 */
export function useBeamSession(role: Role, token?: string) {
  const [phase, setPhase] = useState<Phase>({ name: 'starting' });
  const [manager, setManager] = useState<TransferManager | null>(null);
  const [attempt, setAttempt] = useState(0);
  const respondRef = useRef<(allow: boolean) => void>(() => {});
  const endRef = useRef<() => void>(() => {});

  useEffect(() => {
    if (typeof RTCPeerConnection === 'undefined') {
      setPhase({ name: 'error', kind: 'unsupported' });
      return;
    }

    let disposed = false;
    let socket: Socket;
    let peer: BeamPeer | null = null;
    let mgr: TransferManager | null = null;
    let qr: QrInfo | null = null;
    let resume: Resume | null = null;
    let connected: Extract<Phase, { name: 'connected' }> | null = null;
    let failedConnects = 0;
    let peerDevice = '';
    const me = deviceName();
    const set = (p: Phase) => {
      if (disposed) return;
      connected = p.name === 'connected' ? p : null;
      setPhase(p);
    };
    const patchConnected = (patch: Partial<Extract<Phase, { name: 'connected' }>>) => connected && set({ ...connected, ...patch });

    setPhase(role === 'host' ? { name: 'starting' } : { name: 'joining' });
    setManager(null);

    const iceConfig = fetch('/api/ice-config')
      .then((r) => r.json())
      .then((j) => j.iceServers as RTCIceServer[])
      .catch(() => [{ urls: 'stun:stun.l.google.com:19302' }] as RTCIceServer[]);

    async function createRoom() {
      try {
        const [{ baseUrl }, res] = await Promise.all([
          fetch('/api/config').then((r) => r.json()),
          emitWithAck<{ token: string; expiresAt: number; ttlSeconds: number }>(socket, 'host:create', { device: me }),
        ]);
        // The server's clock may differ from this device's, so count down from now.
        qr = { url: `${baseUrl}/r/${res.token}`, expiresAt: Date.now() + res.ttlSeconds * 1000, ttlSeconds: res.ttlSeconds };
        set({ name: 'qr', ...qr });
      } catch {
        set({ name: 'error', kind: 'server' });
      }
    }

    function joinRoom() {
      emitWithAck<{ ok?: boolean; error?: ErrorKind; hostDevice?: string }>(socket, 'guest:join', { token, device: me })
        .then((res) => {
          if (res.error) set({ name: 'error', kind: res.error });
          else set({ name: 'waiting-approval', hostDevice: res.hostDevice ?? 'the other screen' });
        })
        .catch(() => set({ name: 'error', kind: 'server' }));
    }

    /** After a socket reconnect, tell the server this device is the same one as before. */
    function resumeSession(r: Resume) {
      emitWithAck<{ ok?: boolean; error?: string }>(socket, 'session:resume', r)
        .then((res) => {
          if (res.ok) peer?.retryIfStuck();
          // The server forgot the session (for example it restarted). That's fine while the direct
          // link is up: files don't need the server. Only a dead link ends the session.
          else if (!peer?.isOpen) peer?.close();
        })
        .catch(() => {});
    }

    async function startPeer(myRole: Role, device: string) {
      peerDevice = device;
      set({ name: 'connecting', peerDevice: device });
      const iceServers = await iceConfig;
      if (disposed) return;
      let opened = false;
      peer = new BeamPeer(myRole, socket, iceServers, {
        onOpen: async () => {
          opened = true;
          const [route, safetyCode] = await Promise.all([peer!.routeType(), peer!.safetyCode()]);
          set({ name: 'connected', peerDevice, route, safetyCode, reconnecting: false });
        },
        onMessage: (data) => mgr?.handle(data),
        onReconnecting: () => patchConnected({ reconnecting: true }),
        onRecovered: async () => patchConnected({ reconnecting: false, route: (await peer?.routeType()) ?? 'unknown' }),
        onClose: (reason) => {
          mgr?.shutdown();
          resume = null;
          if (!opened) return set({ name: 'error', kind: 'failed' });
          set({ name: 'ended', peerDevice, reason: reason === 'failed' ? 'lost' : 'left' });
          socket.emit('session:leave');
        },
      });
      window.__beam = { socket, peer };
      mgr = await TransferManager.create(
        peer,
        (log) => socket.connected && socket.emit('transfer:log', log),
        () => peer?.close(),
      );
      if (disposed) return;
      setManager(mgr);
      await peer.start();
    }

    socket = connectSocket();
    window.__beam = { socket, peer: null };

    socket.on('connect', () => {
      failedConnects = 0;
      if (resume) return resumeSession(resume);
      if (peer) return; // session already over; nothing to rejoin
      if (role === 'host') void createRoom();
      else joinRoom();
    });

    socket.on('connect_error', () => {
      failedConnects++;
      if (!peer && failedConnects >= 4) set({ name: 'error', kind: 'server' });
    });

    socket.on('disconnect', () => {
      // Before pairing, the code on screen is no longer valid; a fresh one comes on reconnect.
      if (!peer && !disposed) set(role === 'host' ? { name: 'starting' } : { name: 'joining' });
    });

    // Host events
    socket.on('host:room-expired', () => void createRoom());
    socket.on('host:join-request', ({ device }: { device: string }) => qr && set({ name: 'approval', ...qr, device }));
    socket.on('host:join-cancelled', () => qr && set({ name: 'qr', ...qr }));

    // Guest events
    socket.on('guest:rejected', () => set({ name: 'error', kind: 'rejected' }));
    socket.on('guest:expired', () => set({ name: 'error', kind: 'expired' }));

    // Both
    socket.on('peer:ready', (msg: { role: Role; peerDevice: string; token: string; resumeSecret: string }) => {
      resume = { token: msg.token, role: msg.role, secret: msg.resumeSecret };
      void startPeer(msg.role, msg.peerDevice);
    });
    socket.on('peer:back', () => peer?.retryIfStuck());
    socket.on('peer:left', () => {
      if (peer?.isOpen) return; // the direct link decides; its close event will follow
      if (peer) return peer.close();
      if (role === 'host') void createRoom();
      else set({ name: 'error', kind: 'expired' });
    });

    respondRef.current = (allow: boolean) => {
      socket.emit('host:respond', { allow });
      if (!allow && qr) set({ name: 'qr', ...qr });
    };
    endRef.current = () => {
      mgr?.sayBye();
      // Give the goodbye message a moment to reach the other device.
      window.setTimeout(() => peer?.close(), 150);
    };

    const onUnload = () => mgr?.sayBye();
    window.addEventListener('pagehide', onUnload);

    return () => {
      disposed = true;
      window.removeEventListener('pagehide', onUnload);
      mgr?.shutdown();
      peer?.close();
      socket.removeAllListeners();
      socket.disconnect();
    };
  }, [role, token, attempt]);

  const respond = useCallback((allow: boolean) => respondRef.current(allow), []);
  const endSession = useCallback(() => endRef.current(), []);
  const restart = useCallback(() => setAttempt((n) => n + 1), []);

  return { phase, manager, respond, endSession, restart };
}
