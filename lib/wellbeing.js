// Weekly wellbeing check-ins for engineers.
//
// This is health-related information (special category data under UK GDPR),
// so: it is optional, push notifications never include the answers, and it
// is deleted after a short period (wellbeingRetentionDays, default 90 days).
'use strict';

const { SafetyError } = require('./safety');

const DAY = 24 * 60 * 60 * 1000;
const EVERY_DAYS = 7;

function scale(v, name) {
  const n = Number(v);
  if (!Number.isInteger(n) || n < 1 || n > 5) throw new SafetyError(`Please choose an answer for ${name}.`);
  return n;
}

function createWellbeing(store, notify) {
  const db = () => store.db;
  if (!db().wellbeing) db().wellbeing = [];

  function isFlagged(e) {
    return e.mood <= 2 || e.energy <= 2 || e.wantsChat;
  }

  function lastFor(userId) {
    return db().wellbeing.find((e) => e.userId === userId) || null;
  }

  function status(user, now = Date.now()) {
    if (!db().settings.wellbeingEnabled) return { enabled: false, due: false };
    const last = lastFor(user.id);
    const lastAsked = Math.max(last ? Date.parse(last.at) : 0, user.wellbeingSkippedAt ? Date.parse(user.wellbeingSkippedAt) : 0);
    return { enabled: true, due: now - lastAsked >= EVERY_DAYS * DAY, lastAt: last ? last.at : null };
  }

  function submit(user, body = {}, now = Date.now()) {
    if (!db().settings.wellbeingEnabled) throw new SafetyError('Wellbeing check-ins are switched off.', 409);
    if (body.skip) {
      user.wellbeingSkippedAt = new Date(now).toISOString();
      store.save();
      return null;
    }
    const entry = {
      id: store.id(),
      userId: user.id,
      at: new Date(now).toISOString(),
      mood: scale(body.mood, 'how you are feeling'),
      energy: scale(body.energy, 'how tired you are'),
      wantsChat: Boolean(body.wantsChat),
      comment: String(body.comment || '').trim().slice(0, 500),
      followedUpAt: null,
      followedUpBy: null,
      followUpNote: null,
    };
    entry.flagged = isFlagged(entry);
    db().wellbeing.unshift(entry);
    store.save();
    if (entry.flagged) {
      // Keep the details off phone lock screens: just say someone needs a look.
      const why = entry.wantsChat ? 'would like a chat' : 'may need some support';
      for (const m of db().users.filter((u) => u.role === 'manager' && u.active)) {
        notify({ to: m, subject: 'Wellbeing check-in', body: `${user.name} ${why}. Open the Wellbeing tab on the dashboard.` });
      }
    }
    return entry;
  }

  function followUp(manager, id, note, now = Date.now()) {
    const e = db().wellbeing.find((x) => x.id === id);
    if (!e) throw new SafetyError('Check-in not found.', 404);
    e.followedUpAt = new Date(now).toISOString();
    e.followedUpBy = manager.name;
    e.followUpNote = String(note || '').trim().slice(0, 500) || 'Followed up';
    store.save();
    return e;
  }

  function overview(now = Date.now()) {
    const names = Object.fromEntries(db().users.map((u) => [u.id, u.name]));
    const engineers = db().users.filter((u) => u.role === 'worker' && u.active);
    const people = engineers.map((u) => {
      const entries = db().wellbeing.filter((e) => e.userId === u.id);
      return {
        userId: u.id,
        name: u.name,
        latest: entries[0] || null,
        recent: entries.slice(0, 8).reverse().map((e) => ({ at: e.at, mood: e.mood, energy: e.energy })),
        overdue: status(u, now).due,
      };
    });
    const needsFollowUp = db().wellbeing
      .filter((e) => e.flagged && !e.followedUpAt)
      .map((e) => ({ ...e, workerName: names[e.userId] || 'Unknown' }));
    return { enabled: Boolean(db().settings.wellbeingEnabled), people, needsFollowUp };
  }

  function purge(now = Date.now()) {
    const cutoff = now - db().settings.wellbeingRetentionDays * DAY;
    const before = db().wellbeing.length;
    db().wellbeing = db().wellbeing.filter((e) => Date.parse(e.at) >= cutoff);
    if (db().wellbeing.length !== before) store.save();
    return before - db().wellbeing.length;
  }

  return { status, submit, followUp, overview, purge };
}

module.exports = { createWellbeing };
