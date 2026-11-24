// Lone Worker Safety - web server.
// Run with:  node server.js   (then open http://localhost:3000)
'use strict';

const http = require('http');
const fs = require('fs');
const path = require('path');
const { Store } = require('./lib/store');
const { createNotifier } = require('./lib/notify');
const { createPush } = require('./lib/push');
const { createSafety, SafetyError } = require('./lib/safety');
const { createWellbeing } = require('./lib/wellbeing');
const auth = require('./lib/auth');

const PUBLIC_DIR = path.join(__dirname, 'public');
const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.webmanifest': 'application/manifest+json',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.ico': 'image/x-icon',
};

function createApp({ dataFile, log = console.log, pushSend } = {}) {
  const store = new Store(dataFile);
  const push = createPush(store, { log, ...(pushSend ? { send: pushSend } : {}) });
  const notify = createNotifier(store, { log, push });
  const safety = createSafety(store, notify);
  const wellbeing = createWellbeing(store, notify);

  function send(res, status, body) {
    const json = JSON.stringify(body);
    res.writeHead(status, {
      'Content-Type': 'application/json; charset=utf-8',
      'Cache-Control': 'no-store',
    });
    res.end(json);
  }

  function readBody(req) {
    return new Promise((resolve, reject) => {
      let size = 0;
      const chunks = [];
      req.on('data', (c) => {
        size += c.length;
        if (size > 100 * 1024) {
          reject(new SafetyError('Request too large.', 413));
          req.destroy();
          return;
        }
        chunks.push(c);
      });
      req.on('end', () => {
        if (!chunks.length) return resolve({});
        try {
          resolve(JSON.parse(Buffer.concat(chunks).toString('utf8')));
        } catch {
          reject(new SafetyError('Request was not valid JSON.'));
        }
      });
      req.on('error', reject);
    });
  }

  function currentUser(req) {
    const h = req.headers.authorization || '';
    const token = h.startsWith('Bearer ') ? h.slice(7) : null;
    return { token, user: auth.userForToken(store, token) };
  }

  function requireRole(user, role) {
    if (!user) throw new SafetyError('Please sign in.', 401);
    if (role && user.role !== role) throw new SafetyError('You do not have access to this.', 403);
  }

  function cleanUsername(s) {
    const u = String(s || '').trim().toLowerCase();
    if (!/^[a-z0-9._-]{2,40}$/.test(u)) throw new SafetyError('Usernames can use letters, numbers, dots, dashes and underscores (2 to 40 characters).');
    return u;
  }

  function createUser({ name, username, secret, role, phone }) {
    const uname = cleanUsername(username);
    if (store.db.users.some((u) => u.username === uname)) throw new SafetyError('That username is already taken.', 409);
    const n = String(name || '').trim().slice(0, 80);
    if (!n) throw new SafetyError('Please enter a name.');
    if (role === 'worker' && !/^\d{4,8}$/.test(String(secret))) throw new SafetyError('The PIN must be 4 to 8 digits.');
    if (role === 'manager' && String(secret || '').length < 8) throw new SafetyError('The password must be at least 8 characters.');
    const { salt, hash } = auth.hashSecret(secret);
    const user = {
      id: store.id(),
      name: n,
      username: uname,
      role,
      phone: String(phone || '').trim().slice(0, 30),
      salt,
      hash,
      active: true,
      consentAt: role === 'manager' ? new Date().toISOString() : null,
      createdAt: new Date().toISOString(),
    };
    store.db.users.push(user);
    store.save();
    return user;
  }

  // ---- API routes ----------------------------------------------------------
  // Each route: [method, pattern, handler(ctx)] where ctx = { req, body, user, params }
  const routes = [
    ['GET', '/api/setup-status', () => ({
      needsSetup: !store.db.users.some((u) => u.role === 'manager'),
      orgName: store.db.settings.orgName,
    })],

    ['POST', '/api/setup', ({ body }) => {
      if (store.db.users.some((u) => u.role === 'manager')) throw new SafetyError('Setup has already been done.', 409);
      const user = createUser({ ...body, secret: body.password, role: 'manager' });
      if (body.orgName) store.db.settings.orgName = String(body.orgName).trim().slice(0, 80) || store.db.settings.orgName;
      return { token: auth.issueToken(store, user.id), user: auth.publicUser(user) };
    }],

    ['POST', '/api/login', ({ body }) => {
      const username = String(body.username || '').trim().toLowerCase();
      if (!auth.loginAllowed(username)) throw new SafetyError('Too many wrong attempts. Please wait 5 minutes and try again.', 429);
      const user = store.db.users.find((u) => u.username === username && u.active);
      if (!user || !auth.checkSecret(body.secret || '', user.salt, user.hash)) {
        auth.recordLoginFailure(username);
        throw new SafetyError('Username or PIN/password is wrong.', 401);
      }
      auth.recordLoginSuccess(username);
      return { token: auth.issueToken(store, user.id), user: auth.publicUser(user) };
    }],

    ['POST', '/api/logout', ({ token }) => {
      if (token) delete store.db.tokens[token];
      store.save();
      return { ok: true };
    }],

    ['GET', '/api/me', ({ user }) => {
      requireRole(user);
      return { user: auth.publicUser(user), orgName: store.db.settings.orgName };
    }],

    // ---- phone/tablet notifications for dashboard users ----
    ['GET', '/api/push/key', () => ({ publicKey: push.publicKey })],

    ['POST', '/api/push/subscribe', ({ user, body }) => {
      requireRole(user, 'manager');
      if (!push.subscribe(user, body.subscription, body.label)) throw new SafetyError('This device could not be set up for alerts.');
      return { ok: true, devices: user.pushSubs.length };
    }],

    ['POST', '/api/push/unsubscribe', ({ user, body }) => {
      requireRole(user, 'manager');
      push.unsubscribe(user, String(body.endpoint || ''));
      return { ok: true };
    }],

    ['POST', '/api/push/test', async ({ user }) => {
      requireRole(user, 'manager');
      const sent = await push.sendToUser(user, { title: 'Test alert', body: 'Alerts are working on this device.', url: '/manager' });
      if (!sent) throw new SafetyError('Could not send to this device. Try turning alerts off and on again.');
      return { sent };
    }],

    // ---- wellbeing ----
    ['GET', '/api/wellbeing/status', ({ user }) => {
      requireRole(user, 'worker');
      return wellbeing.status(user);
    }],

    ['POST', '/api/wellbeing', ({ user, body }) => {
      requireRole(user, 'worker');
      const entry = wellbeing.submit(user, body);
      if (!entry) return { ok: true, flagged: false };
      const needsContact = entry.wantsChat || entry.mood <= 2 || entry.energy <= 2;
      return { ok: true, flagged: entry.flagged, level: entry.level, needsContact };
    }],

    ['GET', '/api/wellbeing', ({ user }) => {
      requireRole(user, 'manager');
      return wellbeing.overview();
    }],

    ['POST', '/api/wellbeing/:id/followup', ({ user, body, params }) => {
      requireRole(user, 'manager');
      return { entry: wellbeing.followUp(user, params.id, body.note) };
    }],

    // ---- worker ----
    ['POST', '/api/consent', ({ user }) => {
      requireRole(user, 'worker');
      user.consentAt = new Date().toISOString();
      store.save();
      return { user: auth.publicUser(user) };
    }],

    ['GET', '/api/shift', ({ user }) => {
      requireRole(user, 'worker');
      const s = safety.activeShiftFor(user.id);
      return {
        shift: s ? safety.shiftView(s) : null,
        intervals: safety.ALLOWED_INTERVALS,
        defaultIntervalMin: store.db.settings.defaultIntervalMin,
        graceMin: store.db.settings.graceMin,
        serverTime: new Date().toISOString(),
      };
    }],
    ['POST', '/api/shift/start', ({ user, body }) => { requireRole(user, 'worker'); return { shift: safety.shiftView(safety.startShift(user, body)) }; }],
    ['POST', '/api/shift/checkin', ({ user, body }) => { requireRole(user, 'worker'); return { shift: safety.shiftView(safety.checkIn(user, body)) }; }],
    ['POST', '/api/shift/location', ({ user, body }) => { requireRole(user, 'worker'); return { shift: safety.shiftView(safety.updateLocation(user, body)) }; }],
    ['POST', '/api/shift/sos', ({ user, body }) => { requireRole(user, 'worker'); return { shift: safety.shiftView(safety.sos(user, body).shift) }; }],
    ['POST', '/api/shift/end', ({ user }) => { requireRole(user, 'worker'); return { shift: safety.endShift(user) }; }],

    // ---- manager ----
    ['GET', '/api/dashboard', ({ user }) => {
      requireRole(user, 'manager');
      const now = Date.now();
      const active = store.db.shifts.filter((s) => !s.endedAt).map((s) => safety.shiftView(s, now));
      const rank = { sos: 0, overdue: 1, late: 2, due_soon: 3, ok: 4 };
      active.sort((a, b) => rank[a.displayStatus] - rank[b.displayStatus] || a.nextDueAt.localeCompare(b.nextDueAt));
      const names = Object.fromEntries(store.db.users.map((u) => [u.id, u.name]));
      return {
        orgName: store.db.settings.orgName,
        serverTime: new Date(now).toISOString(),
        active,
        openAlerts: store.db.alerts.filter((a) => !a.acknowledgedAt).map((a) => ({ ...a, workerName: names[a.userId] || 'Unknown' })),
        recentEvents: store.db.events.slice(0, 60).map((e) => ({ ...e, workerName: names[e.userId] || 'Unknown' })),
        recentAlerts: store.db.alerts.slice(0, 30).map((a) => ({ ...a, workerName: names[a.userId] || 'Unknown' })),
        notifications: store.db.notifications.slice(0, 30),
      };
    }],

    ['POST', '/api/alerts/:id/ack', ({ user, body, params }) => {
      requireRole(user, 'manager');
      return { alert: safety.acknowledge(user, params.id, body.note) };
    }],

    ['GET', '/api/users', ({ user }) => {
      requireRole(user, 'manager');
      return { users: store.db.users.map(auth.publicUser) };
    }],

    ['POST', '/api/users', ({ user, body }) => {
      requireRole(user, 'manager');
      const role = body.role === 'manager' ? 'manager' : 'worker';
      const created = createUser({ ...body, role, secret: body.secret });
      return { user: auth.publicUser(created) };
    }],

    ['POST', '/api/users/:id/secret', ({ user, body, params }) => {
      requireRole(user, 'manager');
      const target = store.db.users.find((u) => u.id === params.id);
      if (!target) throw new SafetyError('User not found.', 404);
      if (target.role === 'worker' && !/^\d{4,8}$/.test(String(body.secret))) throw new SafetyError('The PIN must be 4 to 8 digits.');
      if (target.role === 'manager' && String(body.secret || '').length < 8) throw new SafetyError('The password must be at least 8 characters.');
      Object.assign(target, auth.hashSecret(body.secret));
      auth.revokeUserTokens(store, target.id);
      store.save();
      return { ok: true };
    }],

    ['POST', '/api/users/:id/deactivate', ({ user, params }) => {
      requireRole(user, 'manager');
      const target = store.db.users.find((u) => u.id === params.id);
      if (!target) throw new SafetyError('User not found.', 404);
      if (target.id === user.id) throw new SafetyError('You cannot remove your own account.');
      if (safety.activeShiftFor(target.id)) throw new SafetyError('This person is on shift. Wait until they finish.', 409);
      target.active = false;
      auth.revokeUserTokens(store, target.id);
      store.save();
      return { ok: true };
    }],

    // GDPR: give a person a copy of everything held about them.
    ['GET', '/api/users/:id/export', ({ user, params }) => {
      requireRole(user, 'manager');
      const target = store.db.users.find((u) => u.id === params.id);
      if (!target) throw new SafetyError('User not found.', 404);
      return {
        exportedAt: new Date().toISOString(),
        person: auth.publicUser(target),
        shifts: store.db.shifts.filter((s) => s.userId === target.id),
        events: store.db.events.filter((e) => e.userId === target.id),
        alerts: store.db.alerts.filter((a) => a.userId === target.id),
        wellbeing: store.db.wellbeing.filter((e) => e.userId === target.id),
      };
    }],

    // GDPR: erase a former worker's data.
    ['POST', '/api/users/:id/erase', ({ user, params }) => {
      requireRole(user, 'manager');
      const target = store.db.users.find((u) => u.id === params.id);
      if (!target) throw new SafetyError('User not found.', 404);
      if (target.active) throw new SafetyError('Remove the person first, then erase their data.', 409);
      store.db.shifts = store.db.shifts.filter((s) => s.userId !== target.id);
      store.db.events = store.db.events.filter((e) => e.userId !== target.id);
      store.db.alerts = store.db.alerts.filter((a) => a.userId !== target.id);
      store.db.wellbeing = store.db.wellbeing.filter((e) => e.userId !== target.id);
      store.db.users = store.db.users.filter((u) => u.id !== target.id);
      store.save();
      return { ok: true };
    }],

    ['GET', '/api/contacts', ({ user }) => {
      requireRole(user, 'manager');
      return { contacts: store.db.contacts };
    }],

    ['POST', '/api/contacts', ({ user, body }) => {
      requireRole(user, 'manager');
      const name = String(body.name || '').trim().slice(0, 80);
      const phone = String(body.phone || '').trim().slice(0, 30);
      const email = String(body.email || '').trim().slice(0, 120);
      if (!name || (!phone && !email)) throw new SafetyError('Enter a name and a phone number or email.');
      const group = body.group === 'office' ? 'office' : 'on-call';
      const c = { id: store.id(), name, phone, email, group };
      store.db.contacts.push(c);
      store.save();
      return { contact: c };
    }],

    ['DELETE', '/api/contacts/:id', ({ user, params }) => {
      requireRole(user, 'manager');
      store.db.contacts = store.db.contacts.filter((c) => c.id !== params.id);
      store.save();
      return { ok: true };
    }],

    ['GET', '/api/settings', ({ user }) => {
      requireRole(user, 'manager');
      return { settings: store.db.settings };
    }],

    ['PUT', '/api/settings', ({ user, body }) => {
      requireRole(user, 'manager');
      const s = store.db.settings;
      const num = (v, min, max, fallback) => {
        const n = Number(v);
        return Number.isFinite(n) && n >= min && n <= max ? Math.round(n) : fallback;
      };
      if (body.orgName !== undefined) s.orgName = String(body.orgName).trim().slice(0, 80) || s.orgName;
      if (body.defaultIntervalMin !== undefined && safety.ALLOWED_INTERVALS.includes(Number(body.defaultIntervalMin))) s.defaultIntervalMin = Number(body.defaultIntervalMin);
      s.graceMin = num(body.graceMin, 1, 60, s.graceMin);
      s.escalateAfterMin = num(body.escalateAfterMin, 1, 120, s.escalateAfterMin);
      s.retentionDays = num(body.retentionDays, 1, 365, s.retentionDays);
      s.wellbeingRetentionDays = num(body.wellbeingRetentionDays, 7, 365, s.wellbeingRetentionDays);
      if (body.wellbeingEnabled !== undefined) s.wellbeingEnabled = body.wellbeingEnabled === true || body.wellbeingEnabled === 'on' || body.wellbeingEnabled === 'true';
      store.save();
      return { settings: s };
    }],
  ];

  const compiled = routes.map(([method, pattern, handler]) => {
    const keys = [];
    const re = new RegExp('^' + pattern.replace(/:(\w+)/g, (_, k) => { keys.push(k); return '([^/]+)'; }) + '$');
    return { method, re, keys, handler };
  });

  async function handleApi(req, res, pathname) {
    try {
      for (const r of compiled) {
        if (r.method !== req.method) continue;
        const m = pathname.match(r.re);
        if (!m) continue;
        const params = Object.fromEntries(r.keys.map((k, i) => [k, decodeURIComponent(m[i + 1])]));
        const body = req.method === 'GET' ? {} : await readBody(req);
        const { token, user } = currentUser(req);
        const result = await r.handler({ req, body, user, token, params });
        return send(res, 200, result);
      }
      return send(res, 404, { error: 'Not found.' });
    } catch (err) {
      if (err instanceof SafetyError) return send(res, err.status, { error: err.message });
      log('[error]', err);
      return send(res, 500, { error: 'Something went wrong on the server.' });
    }
  }

  function serveStatic(req, res, pathname) {
    if (pathname === '/') pathname = '/index.html';
    if (pathname === '/manager') pathname = '/manager.html';
    const file = path.normalize(path.join(PUBLIC_DIR, pathname));
    if (!file.startsWith(PUBLIC_DIR + path.sep)) {
      res.writeHead(403);
      return res.end();
    }
    fs.readFile(file, (err, data) => {
      if (err) {
        res.writeHead(404, { 'Content-Type': 'text/plain' });
        return res.end('Not found');
      }
      res.writeHead(200, {
        'Content-Type': MIME[path.extname(file)] || 'application/octet-stream',
        'Cache-Control': pathname === '/sw.js' ? 'no-cache' : 'public, max-age=300',
      });
      res.end(data);
    });
  }

  const server = http.createServer((req, res) => {
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader('Referrer-Policy', 'no-referrer');
    res.setHeader('X-Frame-Options', 'DENY');
    res.setHeader('Permissions-Policy', 'geolocation=(self), camera=(), microphone=()');
    const { pathname } = new URL(req.url, 'http://localhost');
    if (pathname.startsWith('/api/')) return handleApi(req, res, pathname);
    if (req.method !== 'GET' && req.method !== 'HEAD') {
      res.writeHead(405);
      return res.end();
    }
    return serveStatic(req, res, pathname);
  });

  // Background safety check every 15 seconds, data clean-up every hour.
  let tickTimer = null;
  let purgeTimer = null;
  function startBackground() {
    tickTimer = setInterval(() => safety.tick(), 15 * 1000);
    purgeTimer = setInterval(() => { safety.purgeOldData(); wellbeing.purge(); }, 60 * 60 * 1000);
    safety.tick();
    safety.purgeOldData();
    wellbeing.purge();
  }
  function stopBackground() {
    clearInterval(tickTimer);
    clearInterval(purgeTimer);
    store.flush();
  }

  return { server, store, safety, wellbeing, startBackground, stopBackground };
}

if (require.main === module) {
  const port = Number(process.env.PORT) || 3000;
  const dataFile = process.env.DATA_FILE || path.join(__dirname, 'data', 'db.json');
  const app = createApp({ dataFile });
  app.startBackground();
  app.server.listen(port, () => {
    console.log(`Lone Worker Safety is running at http://localhost:${port}`);
    console.log(`Manager dashboard: http://localhost:${port}/manager`);
  });
  const shutdown = () => {
    app.stopBackground();
    process.exit(0);
  };
  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);
}

module.exports = { createApp };
