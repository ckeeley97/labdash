/* Password + session handling for LabDash.
   - One password for the dashboard, scrypt-hashed in data/auth.json
   - Sessions are random ids, HMAC-signed into the cookie, persisted so a
     service restart doesn't log everyone out
   - Simple per-IP rate limiting on login attempts                        */

'use strict';

const crypto = require('crypto');
const fs = require('fs');
const path = require('path');

const COOKIE = 'labdash_session';
const SESSION_DAYS = 30;
const MAX_SESSIONS = 50;
const MAX_FAILS = 5;
const LOCKOUT_MS = 60 * 1000;

class Auth {
  constructor(dataDir) {
    this.file = path.join(dataDir, 'auth.json');
    this.fails = new Map(); // ip -> {count, until}
    this.state = this.load();
    if (!this.state.secret) {
      this.state.secret = crypto.randomBytes(32).toString('hex');
      this.save();
    }
  }

  load() {
    try {
      return JSON.parse(fs.readFileSync(this.file, 'utf8'));
    } catch {
      return { hash: null, salt: null, secret: null, sessions: {} };
    }
  }

  save() {
    fs.writeFileSync(this.file, JSON.stringify(this.state), { mode: 0o600 });
  }

  isSetup() {
    return !!this.state.hash;
  }

  hashPassword(pw, salt) {
    return crypto.scryptSync(String(pw), salt, 64).toString('hex');
  }

  setPassword(pw) {
    const salt = crypto.randomBytes(16).toString('hex');
    this.state.salt = salt;
    this.state.hash = this.hashPassword(pw, salt);
    this.save();
  }

  verifyPassword(pw) {
    if (!this.isSetup()) return false;
    const h = Buffer.from(this.hashPassword(pw, this.state.salt));
    const stored = Buffer.from(this.state.hash);
    return h.length === stored.length && crypto.timingSafeEqual(h, stored);
  }

  sign(id) {
    return crypto.createHmac('sha256', this.state.secret).update(id).digest('hex').slice(0, 32);
  }

  createSession() {
    const id = crypto.randomBytes(24).toString('hex');
    this.state.sessions[id] = { exp: Date.now() + SESSION_DAYS * 864e5 };
    this.prune();
    this.save();
    return `${id}.${this.sign(id)}`;
  }

  prune() {
    const now = Date.now();
    for (const [id, s] of Object.entries(this.state.sessions)) {
      if (!s || s.exp < now) delete this.state.sessions[id];
    }
    const ids = Object.keys(this.state.sessions);
    if (ids.length > MAX_SESSIONS) {
      ids
        .sort((a, b) => this.state.sessions[a].exp - this.state.sessions[b].exp)
        .slice(0, ids.length - MAX_SESSIONS)
        .forEach((i) => delete this.state.sessions[i]);
    }
  }

  parseToken(cookieHeader) {
    const m = /(?:^|;\s*)labdash_session=([^;]+)/.exec(cookieHeader || '');
    return m ? decodeURIComponent(m[1]) : null;
  }

  /** Returns the session id when the request carries a valid session, else null. */
  check(req) {
    const token = this.parseToken(req.headers.cookie);
    if (!token) return null;
    const dot = token.indexOf('.');
    if (dot < 1) return null;
    const id = token.slice(0, dot);
    const sig = token.slice(dot + 1);
    const expect = this.sign(id);
    const a = Buffer.from(sig);
    const b = Buffer.from(expect);
    if (a.length !== b.length || !crypto.timingSafeEqual(a, b)) return null;
    const sess = this.state.sessions[id];
    if (!sess || sess.exp < Date.now()) return null;
    return id;
  }

  destroySession(req) {
    const id = this.check(req);
    if (id) {
      delete this.state.sessions[id];
      this.save();
    }
  }

  /** Drop every session except the one making the request (post password change). */
  dropOtherSessions(keepId) {
    for (const id of Object.keys(this.state.sessions)) {
      if (id !== keepId) delete this.state.sessions[id];
    }
    this.save();
  }

  cookieFor(token) {
    return `${COOKIE}=${encodeURIComponent(token)}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${SESSION_DAYS * 86400}`;
  }

  clearCookie() {
    return `${COOKIE}=; Path=/; HttpOnly; SameSite=Lax; Max-Age=0`;
  }

  /* ------- login rate limiting ------- */

  locked(ip) {
    const f = this.fails.get(ip);
    return !!(f && f.until > Date.now());
  }

  recordFail(ip) {
    const f = this.fails.get(ip) || { count: 0, until: 0 };
    f.count += 1;
    if (f.count >= MAX_FAILS) {
      f.until = Date.now() + LOCKOUT_MS;
      f.count = 0;
    }
    this.fails.set(ip, f);
  }

  clearFails(ip) {
    this.fails.delete(ip);
  }
}

module.exports = { Auth };
