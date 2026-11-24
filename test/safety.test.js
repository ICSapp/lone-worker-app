'use strict';

const test = require('node:test');
const assert = require('node:assert');
const { createApp } = require('../server');

const MIN = 60 * 1000;
const quiet = () => {};

async function withServer(fn) {
  const app = createApp({ log: quiet });
  await new Promise((r) => app.server.listen(0, r));
  const base = `http://127.0.0.1:${app.server.address().port}`;
  const call = async (method, path, body, token) => {
    const res = await fetch(base + path, {
      method,
      headers: { 'Content-Type': 'application/json', ...(token ? { Authorization: 'Bearer ' + token } : {}) },
      body: body ? JSON.stringify(body) : undefined,
    });
    return { status: res.status, body: await res.json() };
  };
  try {
    await fn({ app, call });
  } finally {
    app.server.close();
  }
}

async function setup(call) {
  const m = await call('POST', '/api/setup', { name: 'Office Olivia', username: 'olivia', password: 'password123', orgName: 'Test Co' });
  assert.equal(m.status, 200);
  const mt = m.body.token;
  const w = await call('POST', '/api/users', { name: 'Eng Ed', username: 'ed', secret: '1234', phone: '07700900000', role: 'worker' }, mt);
  assert.equal(w.status, 200);
  await call('POST', '/api/contacts', { name: 'On-call Sam', phone: '07700900001', group: 'on-call' }, mt);
  const login = await call('POST', '/api/login', { username: 'ed', secret: '1234' });
  assert.equal(login.status, 200);
  return { mt, wt: login.body.token };
}

test('setup can only be done once', async () => {
  await withServer(async ({ call }) => {
    await setup(call);
    const again = await call('POST', '/api/setup', { name: 'X', username: 'x2', password: 'password123' });
    assert.equal(again.status, 409);
  });
});

test('wrong PIN is rejected and workers cannot see the dashboard', async () => {
  await withServer(async ({ call }) => {
    const { wt } = await setup(call);
    const bad = await call('POST', '/api/login', { username: 'ed', secret: '9999' });
    assert.equal(bad.status, 401);
    const dash = await call('GET', '/api/dashboard', null, wt);
    assert.equal(dash.status, 403);
    const anon = await call('GET', '/api/dashboard');
    assert.equal(anon.status, 401);
  });
});

test('worker must accept privacy notice before starting', async () => {
  await withServer(async ({ call }) => {
    const { wt } = await setup(call);
    const r = await call('POST', '/api/shift/start', { intervalMin: 60 }, wt);
    assert.equal(r.status, 403);
    await call('POST', '/api/consent', null, wt);
    const ok = await call('POST', '/api/shift/start', { intervalMin: 60, locationNote: 'Plant room', position: { lat: 51.5, lng: -0.12, accuracy: 10 } }, wt);
    assert.equal(ok.status, 200);
    assert.equal(ok.body.shift.lastLocation.lat, 51.5);
  });
});

test('missed check-in alerts managers and on-call, escalates, and clears on late check-in', async () => {
  await withServer(async ({ app, call }) => {
    const { mt, wt } = await setup(call);
    await call('POST', '/api/consent', null, wt);
    await call('POST', '/api/shift/start', { intervalMin: 60 }, wt);
    const shift = app.store.db.shifts[0];
    const due = Date.parse(shift.nextDueAt);

    app.safety.tick(due + 4 * MIN); // within grace period
    assert.equal(shift.status, 'ok');

    app.safety.tick(due + 6 * MIN); // past 5 min grace
    assert.equal(shift.status, 'overdue');
    const recipients = app.store.db.notifications.map((n) => n.to);
    assert.ok(recipients.some((t) => t.startsWith('Office Olivia')), 'manager told');
    assert.ok(recipients.some((t) => t.startsWith('On-call Sam')), 'on-call told straight away');

    const before = app.store.db.notifications.length;
    app.safety.tick(due + 17 * MIN); // 10+ min unacknowledged
    assert.equal(app.store.db.alerts[0].level, 2);
    assert.ok(app.store.db.notifications.length > before, 'escalation sent');

    const dash = await call('GET', '/api/dashboard', null, mt);
    assert.equal(dash.body.openAlerts.length, 1);
    assert.equal(dash.body.active[0].displayStatus, 'overdue');

    const ci = await call('POST', '/api/shift/checkin', {}, wt);
    assert.equal(ci.body.shift.status, 'ok');
    const dash2 = await call('GET', '/api/dashboard', null, mt);
    assert.equal(dash2.body.openAlerts.length, 0);
  });
});

test('SOS alerts everyone immediately and blocks ending the shift until cleared', async () => {
  await withServer(async ({ app, call }) => {
    const { mt, wt } = await setup(call);
    await call('POST', '/api/consent', null, wt);
    await call('POST', '/api/shift/start', { intervalMin: 30 }, wt);
    const r = await call('POST', '/api/shift/sos', { position: { lat: 53.48, lng: -2.24 }, note: 'fell' }, wt);
    assert.equal(r.body.shift.status, 'sos');
    const subjects = app.store.db.notifications.map((n) => `${n.subject}|${n.to}`);
    assert.ok(subjects.some((s) => s.startsWith('SOS') && s.includes('On-call Sam')));
    assert.ok(subjects.some((s) => s.startsWith('SOS') && s.includes('Office Olivia')));

    const end = await call('POST', '/api/shift/end', null, wt);
    assert.equal(end.status, 409);

    const dash = await call('GET', '/api/dashboard', null, mt);
    const alertId = dash.body.openAlerts[0].id;
    const ack = await call('POST', `/api/alerts/${alertId}/ack`, { note: 'Phoned, ambulance not needed' }, mt);
    assert.equal(ack.status, 200);
    const shift = await call('GET', '/api/shift', null, wt);
    assert.equal(shift.body.shift.status, 'ok');
    const end2 = await call('POST', '/api/shift/end', null, wt);
    assert.equal(end2.status, 200);
  });
});

test('old location history is purged (GDPR retention)', async () => {
  await withServer(async ({ app, call }) => {
    const { wt } = await setup(call);
    await call('POST', '/api/consent', null, wt);
    await call('POST', '/api/shift/start', { intervalMin: 60, position: { lat: 51, lng: 0 } }, wt);
    await call('POST', '/api/shift/end', null, wt);
    const removed = app.safety.purgeOldData(Date.now() + 31 * 24 * 60 * MIN);
    assert.ok(removed >= 2);
    assert.equal(app.store.db.shifts[0].lastLocation, null);
  });
});

test('invalid locations and intervals are rejected', async () => {
  await withServer(async ({ call }) => {
    const { wt } = await setup(call);
    await call('POST', '/api/consent', null, wt);
    const bad = await call('POST', '/api/shift/start', { intervalMin: 7 }, wt);
    assert.equal(bad.status, 400);
    await call('POST', '/api/shift/start', { intervalMin: 60 }, wt);
    const loc = await call('POST', '/api/shift/location', { position: { lat: 200, lng: 0 } }, wt);
    assert.equal(loc.status, 400);
  });
});

test('static files are served and path traversal is blocked', async () => {
  await withServer(async ({ app }) => {
    const base = `http://127.0.0.1:${app.server.address().port}`;
    const home = await fetch(base + '/');
    assert.equal(home.status, 200);
    const mgr = await fetch(base + '/manager');
    assert.equal(mgr.status, 200);
    const evil = await fetch(base + '/..%2fserver.js');
    assert.notEqual(evil.status, 200);
  });
});
