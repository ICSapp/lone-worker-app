// Phone/tablet notifications ("web push") for office and on-call staff.
// Free: goes through Apple/Google's own notification services. The signing
// keys are created automatically on first run and kept with the app's data.
'use strict';

const webpush = require('web-push');

function createPush(store, { log = console.log, subject = 'mailto:alerts@example.invalid', send = webpush.sendNotification } = {}) {
  if (!store.db.vapid) {
    store.db.vapid = webpush.generateVAPIDKeys();
    store.save();
  }
  const { publicKey, privateKey } = store.db.vapid;
  const options = { vapidDetails: { subject, publicKey, privateKey }, TTL: 60 * 60, urgency: 'high' };

  function cleanSubscription(sub) {
    if (!sub || typeof sub !== 'object') return null;
    const endpoint = String(sub.endpoint || '');
    if (!/^https:\/\//.test(endpoint) || endpoint.length > 1000) return null;
    const keys = sub.keys || {};
    if (typeof keys.p256dh !== 'string' || typeof keys.auth !== 'string') return null;
    return { endpoint, keys: { p256dh: keys.p256dh.slice(0, 200), auth: keys.auth.slice(0, 100) } };
  }

  function subscribe(user, sub, label) {
    const clean = cleanSubscription(sub);
    if (!clean) return null;
    // A device belongs to one person at a time.
    for (const u of store.db.users) {
      if (u.pushSubs) u.pushSubs = u.pushSubs.filter((s) => s.endpoint !== clean.endpoint);
    }
    user.pushSubs = user.pushSubs || [];
    user.pushSubs.push({ ...clean, label: String(label || '').slice(0, 120), createdAt: new Date().toISOString() });
    user.pushSubs = user.pushSubs.slice(-5);
    store.save();
    return clean;
  }

  function unsubscribe(user, endpoint) {
    user.pushSubs = (user.pushSubs || []).filter((s) => s.endpoint !== endpoint);
    store.save();
  }

  // Send to every device this person has turned alerts on for.
  // Returns how many devices it was sent to.
  async function sendToUser(user, payload) {
    const subs = user.pushSubs || [];
    if (!subs.length) return 0;
    const body = JSON.stringify(payload);
    let ok = 0;
    await Promise.all(subs.map(async (s) => {
      try {
        await send({ endpoint: s.endpoint, keys: s.keys }, body, options);
        ok += 1;
      } catch (err) {
        if (err && (err.statusCode === 404 || err.statusCode === 410)) {
          // Device has turned alerts off or been reset: forget it.
          user.pushSubs = (user.pushSubs || []).filter((x) => x.endpoint !== s.endpoint);
          store.save();
        } else {
          log('[push] failed', err && (err.statusCode || err.message));
        }
      }
    }));
    return ok;
  }

  return { publicKey, subscribe, unsubscribe, sendToUser };
}

module.exports = { createPush };
