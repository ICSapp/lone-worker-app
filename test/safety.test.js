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

test('dashboard users with alerts turned on get a phone notification on missed check-in', async () => {
  const sent = [];
  const pushSend = async (sub, body) => { sent.push({ endpoint: sub.endpoint, body: JSON.parse(body) }); };
  const app = createApp({ log: quiet, pushSend });
  await new Promise((r) => app.server.listen(0, r));
  const base = `http://127.0.0.1:${app.server.address().port}`;
  const call = async (method, path, body, token) => {
    const res = await fetch(base + path, { method, headers: { 'Content-Type': 'application/json', ...(token ? { Authorization: 'Bearer ' + token } : {}) }, body: body ? JSON.stringify(body) : undefined });
    return { status: res.status, body: await res.json() };
  };
  try {
    const { mt, wt } = await setup(call);
    const key = await call('GET', '/api/push/key');
    assert.ok(key.body.publicKey.length > 40);
    const sub = { endpoint: 'https://push.example.com/abc', keys: { p256dh: 'p', auth: 'a' } };
    const bad = await call('POST', '/api/push/subscribe', { subscription: sub }, wt);
    assert.equal(bad.status, 403, 'engineers cannot subscribe');
    const ok = await call('POST', '/api/push/subscribe', { subscription: sub, label: 'iPhone' }, mt);
    assert.equal(ok.status, 200);
    const test1 = await call('POST', '/api/push/test', null, mt);
    assert.equal(test1.body.sent, 1);

    await call('POST', '/api/consent', null, wt);
    await call('POST', '/api/shift/start', { intervalMin: 60 }, wt);
    const shift = app.store.db.shifts[0];
    app.safety.tick(Date.parse(shift.nextDueAt) + 6 * MIN);
    await new Promise((r) => setTimeout(r, 20));
    const alert = sent.find((s) => s.body.title === 'Missed check-in');
    assert.ok(alert, 'push sent for missed check-in');
    const rec = app.store.db.notifications.find((n) => n.channel === 'push');
    assert.equal(rec.delivered, true);

    const users = await call('GET', '/api/users', null, mt);
    assert.equal(users.body.users.find((u) => u.username === 'olivia').alertDevices, 1);
    assert.ok(!JSON.stringify(users.body).includes('push.example.com'), 'device details not exposed');
  } finally {
    app.server.close();
  }
});

test('a device that has gone away is forgotten', async () => {
  const pushSend = async () => { const e = new Error('gone'); e.statusCode = 410; throw e; };
  const app = createApp({ log: quiet, pushSend });
  const user = { id: 'u1', name: 'X', role: 'manager', active: true, pushSubs: [{ endpoint: 'https://push.example.com/x', keys: { p256dh: 'p', auth: 'a' } }] };
  app.store.db.users.push(user);
  const { createPush } = require('../lib/push');
  const push = createPush(app.store, { log: quiet, send: pushSend });
  const n = await push.sendToUser(user, { title: 't' });
  assert.equal(n, 0);
  assert.equal(user.pushSubs.length, 0);
});

test('weekly wellbeing check: due, flags low scores, follow-up, retention, privacy in push', async () => {
  await withServer(async ({ app, call }) => {
    const { mt, wt } = await setup(call);
    let st = await call('GET', '/api/wellbeing/status', null, wt);
    assert.equal(st.body.due, true);

    const bad = await call('POST', '/api/wellbeing', { mood: 9, energy: 3 }, wt);
    assert.equal(bad.status, 400);

    const ok = await call('POST', '/api/wellbeing', { mood: 4, energy: 4 }, wt);
    assert.equal(ok.body.flagged, false);
    st = await call('GET', '/api/wellbeing/status', null, wt);
    assert.equal(st.body.due, false, 'not asked again this week');

    const low = await call('POST', '/api/wellbeing', { mood: 2, energy: 3, wantsChat: true, comment: 'rough week' }, wt);
    assert.equal(low.body.flagged, true);
    const n = app.store.db.notifications.find((x) => x.subject === 'Wellbeing check-in');
    assert.ok(n, 'office told');
    assert.ok(!n.body.includes('rough week'), 'comment not put in notification');

    const forbidden = await call('GET', '/api/wellbeing', null, wt);
    assert.equal(forbidden.status, 403, 'engineers cannot see others');

    const ov = await call('GET', '/api/wellbeing', null, mt);
    assert.equal(ov.body.needsFollowUp.length, 1);
    assert.equal(ov.body.people[0].recent.length, 2);
    await call('POST', `/api/wellbeing/${ov.body.needsFollowUp[0].id}/followup`, { note: 'Had a chat' }, mt);
    const ov2 = await call('GET', '/api/wellbeing', null, mt);
    assert.equal(ov2.body.needsFollowUp.length, 0);

    const removed = app.wellbeing.purge(Date.now() + 91 * 24 * 60 * MIN);
    assert.equal(removed, 2);
  });
});

test('wellbeing can be skipped and switched off', async () => {
  await withServer(async ({ call }) => {
    const { mt, wt } = await setup(call);
    await call('POST', '/api/wellbeing', { skip: true }, wt);
    let st = await call('GET', '/api/wellbeing/status', null, wt);
    assert.equal(st.body.due, false);
    await call('PUT', '/api/settings', { wellbeingEnabled: false }, mt);
    st = await call('GET', '/api/wellbeing/status', null, wt);
    assert.equal(st.body.enabled, false);
  });
});

test('wellbeing guidance levels follow the response procedure', () => {
  const { assess } = require('../lib/wellbeing');
  assert.equal(assess({ mood: 1, energy: 4 }).level, 'amber');
  assert.equal(assess({ mood: 2, energy: 4 }).level, 'yellow');
  assert.equal(assess({ mood: 2, energy: 2 }).level, 'amber');
  assert.equal(assess({ mood: 5, energy: 1 }).level, 'amber');
  assert.equal(assess({ mood: 5, energy: 1 }).fatigue, 'stand-down');
  assert.equal(assess({ mood: 4, energy: 2 }).level, 'yellow');
  assert.equal(assess({ mood: 4, energy: 2 }).fatigue, 'check');
  assert.equal(assess({ mood: 3, energy: 3 }).level, 'green');
  assert.equal(assess({ mood: 4, energy: 4, wantsChat: true }).level, 'yellow');
  assert.equal(assess({ mood: 2, energy: 4, wantsChat: true }).level, 'amber');
  assert.equal(assess({ mood: 2, energy: 4 }, { mood: 2, energy: 4 }).level, 'amber', 'low two weeks running goes up');
  assert.equal(assess({ mood: 3, energy: 4 }, { mood: 5, energy: 4 }).level, 'yellow', 'big drop goes up');
});

test('wellbeing: comment with good scores reaches the office, skips are shown', async () => {
  await withServer(async ({ app, call }) => {
    const { mt, wt } = await setup(call);
    await call('POST', '/api/wellbeing', { skip: true }, wt);
    let ov = await call('GET', '/api/wellbeing', null, mt);
    assert.equal(ov.body.people[0].thisWeek, 'skipped');
    assert.equal(ov.body.people[0].skipStreak, 1);

    const r = await call('POST', '/api/wellbeing', { mood: 4, energy: 4, comment: 'Site in Leeds has no welfare facilities' }, wt);
    assert.equal(r.body.flagged, true);
    assert.equal(r.body.level, 'green');
    const n = app.store.db.notifications.find((x) => x.subject === 'Wellbeing check-in');
    assert.ok(n.body.includes('left a comment'));
    assert.ok(!n.body.includes('Leeds'), 'comment kept out of the notification');
    ov = await call('GET', '/api/wellbeing', null, mt);
    assert.equal(ov.body.needsFollowUp.length, 1);
    assert.equal(ov.body.people[0].thisWeek, 'answered');
    assert.equal(ov.body.people[0].skipStreak, 0);
  });
});
