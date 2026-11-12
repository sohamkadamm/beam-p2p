import 'dotenv/config';
import express from 'express';
import http from 'node:http';
import https from 'node:https';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { Server } from 'socket.io';
import { RoomManager } from './rooms.js';
import { createStore } from './store.js';
import { loadOrCreateCert } from './cert.js';
import { createAdmin } from './admin.js';
import { timingSafeEqual } from 'node:crypto';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const env = process.env;
const PORT = Number(env.PORT || 3000);
const ROOM_TTL_MS = Number(env.ROOM_TTL_SECONDS || 300) * 1000;
const RESUME_GRACE_MS = 30_000; // how long a dropped device has to come back
const CLIENT_DIST = path.resolve(__dirname, '../../client/dist');

const store = await createStore(env);
const rooms = new RoomManager({ ttlMs: ROOM_TTL_MS });
const admin = createAdmin(env);

/* ------------------------------------------------------------------ */
/* HTTP API                                                            */
/* ------------------------------------------------------------------ */

const app = express();
app.disable('x-powered-by');
app.set('trust proxy', true);
app.use(express.json({ limit: '16kb' }));

app.get('/api/health', (_req, res) => {
  res.json({ ok: true, uptimeSeconds: Math.round(process.uptime()), openRooms: rooms.size, store: store.kind });
});

/** The address phones should open. Used to build the QR code. */
app.get('/api/config', (req, res) => {
  res.json({ baseUrl: publicBaseUrl(req), roomTtlSeconds: ROOM_TTL_MS / 1000 });
});

/** STUN/TURN servers the browsers use to find a route to each other. */
app.get('/api/ice-config', (_req, res) => {
  const iceServers = [{ urls: ['stun:stun.l.google.com:19302', 'stun:stun1.l.google.com:19302'] }];
  if (env.TURN_URLS) {
    iceServers.push({
      urls: env.TURN_URLS.split(',').map((s) => s.trim()).filter(Boolean),
      username: env.TURN_USERNAME,
      credential: env.TURN_CREDENTIAL,
    });
  }
  res.json({ iceServers });
});

app.post('/api/admin/login', admin.login);
app.post('/api/admin/logout', admin.logout);
app.get('/api/admin/me', admin.me);

app.get('/api/stats', admin.requireAdmin, async (_req, res, next) => {
  try {
    res.json(await store.stats());
  } catch (err) {
    next(err);
  }
});

app.use('/api', (_req, res) => res.status(404).json({ error: 'Not found' }));

// Serve the built React app, falling back to index.html for client-side routes.
if (fs.existsSync(CLIENT_DIST)) {
  app.use(express.static(CLIENT_DIST, { index: false, maxAge: '1h' }));
  app.use((req, res, next) => {
    if (req.method !== 'GET' || req.path.startsWith('/socket.io')) return next();
    res.sendFile(path.join(CLIENT_DIST, 'index.html'));
  });
} else {
  app.get('/', (_req, res) =>
    res.type('text').send('Beam server is running. Build the client (npm run build) or use the Vite dev server on port 5173.'),
  );
}

app.use((err, _req, res, _next) => {
  console.error('[beam] request failed:', err);
  res.status(500).json({ error: 'Server error' });
});

/* ------------------------------------------------------------------ */
/* Server + Socket.io signaling                                        */
/* ------------------------------------------------------------------ */

let server;
let scheme = 'http';
if (env.HTTPS === 'true') {
  const { key, cert } = await loadOrCreateCert(lanAddress(), env);
  server = https.createServer({ key, cert }, app);
  scheme = 'https';
} else {
  server = http.createServer(app);
}

const io = new Server(server, {
  cors: { origin: env.CORS_ORIGIN ? env.CORS_ORIGIN.split(',') : true },
  maxHttpBufferSize: 256 * 1024, // signaling messages are small; files never pass through here
});

io.on('connection', (socket) => {
  /** Screen asks for a new room (and QR code). */
  socket.on('host:create', ({ device } = {}, ack) => {
    if (typeof ack !== 'function') return;
    leaveCurrentRoom(socket, 'replaced');
    const room = rooms.create(socket.id, cleanDevice(device));
    socket.data.token = room.token;
    socket.data.role = 'host';
    room.timer = setTimeout(() => {
      const r = rooms.get(room.token);
      if (r && !r.locked) {
        if (r.pendingGuestId) io.to(r.pendingGuestId).emit('guest:expired');
        rooms.delete(r.token);
        io.to(r.hostId).emit('host:room-expired');
      }
    }, ROOM_TTL_MS);
    ack({ token: room.token, expiresAt: room.expiresAt, ttlSeconds: ROOM_TTL_MS / 1000 });
  });

  /** Phone opened the link inside the QR code. */
  socket.on('guest:join', ({ token, device } = {}, ack) => {
    if (typeof ack !== 'function') return;
    const room = rooms.get(token);
    if (!room) return ack({ error: 'expired' });
    if (room.hostId === socket.id) return ack({ error: 'same-device' });
    if (room.locked || room.pendingGuestId) return ack({ error: 'busy' });

    room.pendingGuestId = socket.id;
    room.pendingGuestDevice = cleanDevice(device);
    socket.data.token = room.token;
    socket.data.role = 'guest';
    io.to(room.hostId).emit('host:join-request', { device: room.pendingGuestDevice });
    ack({ ok: true, hostDevice: room.hostDevice });
  });

  /** Screen pressed Allow or Decline. */
  socket.on('host:respond', async ({ allow } = {}) => {
    const room = rooms.get(socket.data.token);
    if (!room || room.hostId !== socket.id || !room.pendingGuestId || room.locked) return;
    const guestId = room.pendingGuestId;

    if (!allow) {
      room.pendingGuestId = null;
      room.pendingGuestDevice = null;
      const guest = io.sockets.sockets.get(guestId);
      if (guest) guest.data.token = null;
      io.to(guestId).emit('guest:rejected');
      return;
    }

    rooms.lock(room);
    io.to(room.hostId).emit('peer:ready', { role: 'host', peerDevice: room.guestDevice, token: room.token, resumeSecret: room.hostSecret });
    io.to(room.guestId).emit('peer:ready', { role: 'guest', peerDevice: room.hostDevice, token: room.token, resumeSecret: room.guestSecret });
    safe(() =>
      store.startSession({
        id: room.sessionId,
        started_at: new Date(),
        host_device: room.hostDevice,
        guest_device: room.guestDevice,
      }),
    );
  });

  /** WebRTC offer / answer / ICE candidates, relayed to the other device only. */
  socket.on('signal', (data) => {
    const room = rooms.get(socket.data.token);
    if (!room) return;
    const other = rooms.otherPeer(room, socket.id);
    if (other) io.to(other).emit('signal', data);
  });

  /** Receiver reports a finished transfer (metadata only). */
  socket.on('transfer:log', (log = {}) => {
    const room = rooms.get(socket.data.token);
    if (!room || !room.locked) return;
    const n = (v, max) => Math.max(0, Math.min(Number(v) || 0, max));
    // The receiver logs it, so a transfer *to* the guest was sent by the host.
    const direction = socket.id === room.guestId ? 'host_to_guest' : 'guest_to_host';
    safe(() =>
      store.addTransfer({
        session_id: room.sessionId,
        created_at: new Date(),
        direction,
        file_count: Math.round(n(log.fileCount, 100000)),
        total_bytes: Math.round(n(log.totalBytes, 1e13)),
        duration_ms: Math.round(n(log.durationMs, 2147483647)),
        avg_speed_bps: Math.round(n(log.avgSpeedBps, 1e12)),
        all_verified: !!log.allVerified,
      }),
    );
  });

  /** A paired device lost its socket (Wi-Fi blip) and is back with its secret. */
  socket.on('session:resume', ({ token, role, secret } = {}, ack) => {
    if (typeof ack !== 'function') return;
    const room = rooms.get(token);
    if (!room || !room.locked || (role !== 'host' && role !== 'guest')) return ack({ error: 'gone' });
    const expected = role === 'host' ? room.hostSecret : room.guestSecret;
    if (!secretMatches(secret, expected)) return ack({ error: 'gone' });

    clearTimeout(room.graceTimers[role]);
    room.graceTimers[role] = null;
    if (role === 'host') room.hostId = socket.id;
    else room.guestId = socket.id;
    socket.data.token = room.token;
    socket.data.role = role;
    const other = role === 'host' ? room.guestId : room.hostId;
    if (other) io.to(other).emit('peer:back');
    ack({ ok: true });
  });

  socket.on('session:leave', () => leaveCurrentRoom(socket, 'left'));
  socket.on('disconnect', () => leaveCurrentRoom(socket, 'disconnected'));
});

function leaveCurrentRoom(socket, reason) {
  const room = rooms.get(socket.data.token);
  socket.data.token = null;
  if (!room) return;

  // A paired device that merely lost its connection gets a grace period to resume.
  const role = socket.id === room.hostId ? 'host' : socket.id === room.guestId ? 'guest' : null;
  if (room.locked && role && reason === 'disconnected') {
    if (role === 'host') room.hostId = null;
    else room.guestId = null;
    const other = role === 'host' ? room.guestId : room.hostId;
    if (other) io.to(other).emit('peer:reconnecting');
    room.graceTimers[role] = setTimeout(() => {
      const r = rooms.get(room.token);
      if (!r) return;
      const remaining = r.hostId || r.guestId;
      if (remaining) io.to(remaining).emit('peer:left', { reason: 'timeout' });
      safe(() => store.endSession(r.sessionId, `${role}_timeout`));
      rooms.delete(r.token);
    }, RESUME_GRACE_MS);
    return;
  }

  if (socket.id === room.hostId) {
    const notify = room.guestId || room.pendingGuestId;
    if (notify) io.to(notify).emit('peer:left', { reason });
    if (room.sessionId) safe(() => store.endSession(room.sessionId, `host_${reason}`));
    rooms.delete(room.token);
  } else if (socket.id === room.pendingGuestId) {
    room.pendingGuestId = null;
    room.pendingGuestDevice = null;
    io.to(room.hostId).emit('host:join-cancelled');
  } else if (socket.id === room.guestId) {
    io.to(room.hostId).emit('peer:left', { reason });
    if (room.sessionId) safe(() => store.endSession(room.sessionId, `guest_${reason}`));
    rooms.delete(room.token);
  }
}

/* ------------------------------------------------------------------ */
/* Helpers                                                             */
/* ------------------------------------------------------------------ */

function secretMatches(given, expected) {
  if (typeof given !== 'string' || typeof expected !== 'string') return false;
  const a = Buffer.from(given);
  const b = Buffer.from(expected);
  return a.length === b.length && timingSafeEqual(a, b);
}

function cleanDevice(device) {
  const s = typeof device === 'string' ? device.replace(/[^\w .,()\-]/g, '').trim() : '';
  return (s || 'Unknown device').slice(0, 60);
}

function safe(fn) {
  Promise.resolve()
    .then(fn)
    .catch((err) => console.warn('[beam] log write failed:', err.message));
}

function lanAddress() {
  for (const list of Object.values(os.networkInterfaces())) {
    for (const a of list || []) {
      if (a.family === 'IPv4' && !a.internal) return a.address;
    }
  }
  return null;
}

/**
 * Phones can't open "localhost", so when the screen is using localhost
 * we put the computer's Wi-Fi address in the QR instead.
 */
function publicBaseUrl(req) {
  if (env.PUBLIC_URL) return env.PUBLIC_URL.replace(/\/$/, '');
  const proto = (req.get('x-forwarded-proto') || req.protocol || scheme).split(',')[0];
  const hostHeader = req.get('x-forwarded-host') || req.get('host') || `localhost:${PORT}`;
  const url = new URL(`${proto}://${hostHeader}`);
  if (['localhost', '127.0.0.1', '[::1]'].includes(url.hostname)) {
    const lan = lanAddress();
    if (lan) url.hostname = lan;
    // In dev the page is served by Vite (5173); phones should reach that too.
  }
  return url.origin;
}

server.listen(PORT, '0.0.0.0', () => {
  const lan = lanAddress();
  console.log(`[beam] ready on ${scheme}://localhost:${PORT}${lan ? `  (Wi-Fi: ${scheme}://${lan}:${PORT})` : ''}`);
});

const shutdown = () => {
  io.close();
  server.close(() => process.exit(0));
  setTimeout(() => process.exit(0), 2000).unref();
};
process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);
