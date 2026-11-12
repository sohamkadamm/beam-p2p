import { io, Socket } from 'socket.io-client';

/**
 * One socket per page. It only carries pairing and WebRTC setup messages, never files.
 * It reconnects by itself after a network blip; a paired device then resumes its session.
 */
export function connectSocket(): Socket {
  return io({
    transports: ['websocket', 'polling'],
    reconnection: true,
    reconnectionDelay: 800,
    reconnectionDelayMax: 4000,
    timeout: 10000,
  });
}

export function emitWithAck<T>(socket: Socket, event: string, payload: unknown, timeoutMs = 8000): Promise<T> {
  return socket.timeout(timeoutMs).emitWithAck(event, payload) as Promise<T>;
}
