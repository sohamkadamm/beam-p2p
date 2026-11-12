import { randomBytes, randomUUID } from 'node:crypto';

/**
 * Keeps track of pairing rooms.
 *
 * A room is created when a screen opens Beam and shows its QR code.
 * Life of a room:
 *   open     -> waiting for a phone to scan the QR
 *   pending  -> a phone scanned it, the screen must Allow or Decline
 *   locked   -> paired; nobody else can join
 *
 * Rooms that are never scanned expire after `ttlMs`, and the screen gets a fresh QR.
 */
export class RoomManager {
  constructor({ ttlMs }) {
    this.ttlMs = ttlMs;
    this.rooms = new Map(); // token -> room
  }

  create(hostId, hostDevice) {
    // 18 random bytes = 24 URL-safe characters. Never typed by a person, so it can be long.
    const token = randomBytes(18).toString('base64url');
    const room = {
      token,
      hostId,
      hostDevice,
      pendingGuestId: null,
      pendingGuestDevice: null,
      guestId: null,
      guestDevice: null,
      locked: false,
      sessionId: null,
      hostSecret: null,
      guestSecret: null,
      graceTimers: { host: null, guest: null },
      createdAt: Date.now(),
      expiresAt: Date.now() + this.ttlMs,
      timer: null,
    };
    this.rooms.set(token, room);
    return room;
  }

  get(token) {
    if (typeof token !== 'string' || token.length > 64) return null;
    return this.rooms.get(token) ?? null;
  }

  lock(room) {
    room.locked = true;
    room.guestId = room.pendingGuestId;
    room.guestDevice = room.pendingGuestDevice;
    room.pendingGuestId = null;
    room.pendingGuestDevice = null;
    room.sessionId = randomUUID();
    // Each side gets a secret so it can rejoin after a network blip (see session:resume).
    room.hostSecret = randomBytes(18).toString('base64url');
    room.guestSecret = randomBytes(18).toString('base64url');
    clearTimeout(room.timer);
    room.timer = null;
  }

  delete(token) {
    const room = this.rooms.get(token);
    if (room) {
      clearTimeout(room.timer);
      clearTimeout(room.graceTimers.host);
      clearTimeout(room.graceTimers.guest);
    }
    this.rooms.delete(token);
  }

  /** The id of the other socket in a paired room, or null. */
  otherPeer(room, socketId) {
    if (!room.locked) return null;
    if (socketId === room.hostId) return room.guestId;
    if (socketId === room.guestId) return room.hostId;
    return null;
  }

  get size() {
    return this.rooms.size;
  }
}
