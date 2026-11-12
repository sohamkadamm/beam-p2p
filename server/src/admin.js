import { createHmac, randomBytes, timingSafeEqual } from 'node:crypto';

/**
 * Password login for the usage page.
 * The password comes from ADMIN_PASSWORD. If it isn't set, a random one is
 * generated and printed in the server console, so the page is never left open.
 * A successful login sets a signed, HttpOnly cookie valid for 8 hours.
 */
const COOKIE = 'beam_admin';
const MAX_AGE_SECONDS = 8 * 60 * 60;

export function createAdmin(env) {
  const password = env.ADMIN_PASSWORD || randomBytes(6).toString('base64url');
  const secret = env.SESSION_SECRET || randomBytes(32).toString('hex');
  if (!env.ADMIN_PASSWORD) {
    console.log(`[beam] usage page password for this run: ${password}  (set ADMIN_PASSWORD to choose your own)`);
  }

  const attempts = new Map(); // ip -> { count, resetAt }

  const sign = (exp) => `${exp}.${createHmac('sha256', secret).update(String(exp)).digest('base64url')}`;

  function isAdmin(req) {
    const value = parseCookies(req.get('cookie'))[COOKIE];
    if (!value) return false;
    const [exp] = value.split('.');
    if (!/^\d+$/.test(exp) || Number(exp) < Date.now()) return false;
    return safeEqual(value, sign(exp));
  }

  function setCookie(req, res, value, maxAge) {
    const secure = req.secure ? '; Secure' : '';
    res.setHeader('Set-Cookie', `${COOKIE}=${value}; HttpOnly; SameSite=Strict; Path=/; Max-Age=${maxAge}${secure}`);
  }

  return {
    requireAdmin(req, res, next) {
      if (isAdmin(req)) return next();
      res.status(401).json({ error: 'Sign in to see usage.' });
    },

    me(req, res) {
      res.json({ signedIn: isAdmin(req) });
    },

    login(req, res) {
      const now = Date.now();
      const key = req.ip || 'unknown';
      const a = attempts.get(key);
      const entry = a && a.resetAt > now ? a : { count: 0, resetAt: now + 10 * 60 * 1000 };
      if (entry.count >= 8) {
        const minutes = Math.ceil((entry.resetAt - now) / 60000);
        return res.status(429).json({ error: `Too many attempts. Try again in ${minutes} min.` });
      }
      const given = typeof req.body?.password === 'string' ? req.body.password : '';
      if (!safeEqual(given, password)) {
        entry.count += 1;
        attempts.set(key, entry);
        return res.status(401).json({ error: 'Wrong password.' });
      }
      attempts.delete(key);
      setCookie(req, res, sign(now + MAX_AGE_SECONDS * 1000), MAX_AGE_SECONDS);
      res.json({ signedIn: true });
    },

    logout(req, res) {
      setCookie(req, res, '', 0);
      res.json({ signedIn: false });
    },
  };
}

function safeEqual(a, b) {
  const x = Buffer.from(String(a));
  const y = Buffer.from(String(b));
  return x.length === y.length && timingSafeEqual(x, y);
}

function parseCookies(header = '') {
  const out = {};
  for (const part of header.split(';')) {
    const i = part.indexOf('=');
    if (i > 0) out[part.slice(0, i).trim()] = decodeURIComponent(part.slice(i + 1).trim());
  }
  return out;
}
