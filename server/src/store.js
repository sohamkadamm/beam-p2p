import mysql from 'mysql2/promise';

/**
 * Session and transfer logs.
 *
 * Only metadata is stored (counts, sizes, speeds, device names).
 * File names and file contents never reach the server.
 *
 * Uses MySQL when DB_HOST is set; otherwise keeps logs in memory so the app
 * still runs with zero setup (for example on a free hosting tier).
 */

const SCHEMA = [
  `CREATE TABLE IF NOT EXISTS sessions (
     id CHAR(36) PRIMARY KEY,
     started_at DATETIME NOT NULL,
     ended_at DATETIME NULL,
     host_device VARCHAR(120) NOT NULL,
     guest_device VARCHAR(120) NOT NULL,
     end_reason VARCHAR(40) NULL
   )`,
  `CREATE TABLE IF NOT EXISTS transfers (
     id INT AUTO_INCREMENT PRIMARY KEY,
     session_id CHAR(36) NOT NULL,
     created_at DATETIME NOT NULL,
     direction ENUM('host_to_guest','guest_to_host') NOT NULL,
     file_count INT NOT NULL,
     total_bytes BIGINT NOT NULL,
     duration_ms INT NOT NULL,
     avg_speed_bps BIGINT NOT NULL,
     all_verified TINYINT(1) NOT NULL,
     INDEX idx_transfers_session (session_id),
     FOREIGN KEY (session_id) REFERENCES sessions(id) ON DELETE CASCADE
   )`,
];

class MemoryStore {
  kind = 'memory';
  sessions = [];
  transfers = [];

  async init() {}

  async startSession(s) {
    this.sessions.push({ ...s, ended_at: null, end_reason: null });
    if (this.sessions.length > 1000) this.sessions.shift();
  }

  async endSession(id, reason) {
    const s = this.sessions.find((x) => x.id === id);
    if (s && !s.ended_at) {
      s.ended_at = new Date();
      s.end_reason = reason;
    }
  }

  async addTransfer(t) {
    this.transfers.push({ id: this.transfers.length + 1, ...t });
    if (this.transfers.length > 5000) this.transfers.shift();
  }

  async stats() {
    const t = this.transfers;
    const bytes = t.reduce((a, x) => a + x.total_bytes, 0);
    const files = t.reduce((a, x) => a + x.file_count, 0);
    // Overall speed = all bytes / all time, so tiny files don't skew it.
    const ms = t.reduce((a, x) => a + x.duration_ms, 0);
    const avg = ms > 0 ? (bytes / ms) * 1000 : 0;
    const recent = [...t].reverse().slice(0, 20).map((x) => ({
      ...x,
      ...pickDevices(this.sessions.find((s) => s.id === x.session_id), x.direction),
    }));
    return {
      sessions: this.sessions.length,
      transfers: t.length,
      files,
      bytes,
      avgSpeedBps: Math.round(avg),
      verifiedRate: t.length ? t.filter((x) => x.all_verified).length / t.length : 1,
      recent,
    };
  }
}

function pickDevices(session, direction) {
  if (!session) return { from_device: 'Unknown', to_device: 'Unknown' };
  return direction === 'host_to_guest'
    ? { from_device: session.host_device, to_device: session.guest_device }
    : { from_device: session.guest_device, to_device: session.host_device };
}

class MySqlStore {
  kind = 'mysql';

  constructor(env) {
    this.pool = mysql.createPool({
      host: env.DB_HOST,
      port: Number(env.DB_PORT || 3306),
      user: env.DB_USER || 'root',
      password: env.DB_PASSWORD || '',
      database: env.DB_NAME || 'beam',
      waitForConnections: true,
      connectionLimit: 5,
      connectTimeout: 4000,
      ssl: env.DB_SSL === 'true' ? { rejectUnauthorized: true } : undefined,
    });
  }

  async init() {
    for (const sql of SCHEMA) await this.pool.query(sql);
  }

  async startSession(s) {
    await this.pool.execute(
      'INSERT INTO sessions (id, started_at, host_device, guest_device) VALUES (?, ?, ?, ?)',
      [s.id, s.started_at, s.host_device, s.guest_device],
    );
  }

  async endSession(id, reason) {
    await this.pool.execute(
      'UPDATE sessions SET ended_at = ?, end_reason = ? WHERE id = ? AND ended_at IS NULL',
      [new Date(), reason, id],
    );
  }

  async addTransfer(t) {
    await this.pool.execute(
      `INSERT INTO transfers
         (session_id, created_at, direction, file_count, total_bytes, duration_ms, avg_speed_bps, all_verified)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      [t.session_id, t.created_at, t.direction, t.file_count, t.total_bytes, t.duration_ms, t.avg_speed_bps, t.all_verified ? 1 : 0],
    );
  }

  async stats() {
    const [[s]] = await this.pool.query('SELECT COUNT(*) AS n FROM sessions');
    const [[t]] = await this.pool.query(
      `SELECT COUNT(*) AS n, COALESCE(SUM(file_count),0) AS files, COALESCE(SUM(total_bytes),0) AS bytes,
              COALESCE(SUM(total_bytes) / NULLIF(SUM(duration_ms),0) * 1000, 0) AS speed, COALESCE(AVG(all_verified),1) AS verified
       FROM transfers`,
    );
    const [recent] = await this.pool.query(
      `SELECT t.*,
              IF(t.direction='host_to_guest', s.host_device, s.guest_device) AS from_device,
              IF(t.direction='host_to_guest', s.guest_device, s.host_device) AS to_device
       FROM transfers t JOIN sessions s ON s.id = t.session_id
       ORDER BY t.id DESC LIMIT 20`,
    );
    return {
      sessions: Number(s.n),
      transfers: Number(t.n),
      files: Number(t.files),
      bytes: Number(t.bytes),
      avgSpeedBps: Math.round(Number(t.speed)),
      verifiedRate: Number(t.verified),
      recent: recent.map((r) => ({ ...r, total_bytes: Number(r.total_bytes), avg_speed_bps: Number(r.avg_speed_bps), all_verified: !!r.all_verified })),
    };
  }
}

export async function createStore(env) {
  if (env.DB_HOST) {
    const store = new MySqlStore(env);
    try {
      await store.init();
      console.log(`[beam] logging to MySQL at ${env.DB_HOST}/${env.DB_NAME || 'beam'}`);
      return store;
    } catch (err) {
      console.warn(`[beam] could not reach MySQL (${err.message}); falling back to in-memory logs`);
    }
  } else {
    console.log('[beam] DB_HOST not set; logging to memory');
  }
  const mem = new MemoryStore();
  await mem.init();
  return mem;
}
