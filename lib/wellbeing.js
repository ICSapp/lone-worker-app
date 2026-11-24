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

// Response level from the wellbeing response procedure.
// red is never set automatically: only a person reading a comment can judge risk of harm.
const LEVELS = ['green', 'yellow', 'amber'];

function assess(e, prev) {
  const reasons = [];
  let lvl = 0;
  const raise = (to, why) => { if (to > lvl) lvl = to; if (why) reasons.push(why); };
  if (e.mood === 1) raise(2, 'Feeling very low');
  else if (e.mood === 2) raise(e.energy <= 2 ? 2 : 1, 'Feeling low');
  if (e.energy === 1) raise(2, 'Exhausted: fatigue stand-down check');
  else if (e.energy === 2) raise(1, 'Very tired: fatigue check');
  if (e.wantsChat) raise(e.mood <= 2 ? 2 : 1, 'Asked for a chat');
  if (e.comment) reasons.push('Left a comment');
  if (prev) {
    const prevLow = prev.mood <= 2 || prev.energy <= 2;
    if (lvl >= 1 && prevLow) { lvl = Math.min(lvl + 1, 2); reasons.push('Low two weeks running: moved up a level'); }
    else if (prev.mood - e.mood >= 2) { lvl = Math.min(lvl + 1, 2); reasons.push('Feeling dropped 2 or more steps since last time'); }
  }
  return { level: LEVELS[lvl], reasons, fatigue: e.energy === 1 ? 'stand-down' : e.energy === 2 ? 'check' : null };
}

function createWellbeing(store, notify) {
  const db = () => store.db;
  if (!db().wellbeing) db().wellbeing = [];

  function isFlagged(e) {
    return e.mood <= 2 || e.energy <= 2 || e.wantsChat || Boolean(e.comment);
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
      user.wellbeingSkipStreak = (user.wellbeingSkipStreak || 0) + 1;
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
    Object.assign(entry, assess(entry, lastFor(user.id)));
    user.wellbeingSkipStreak = 0;
    db().wellbeing.unshift(entry);
    store.save();
    if (entry.flagged) {
      // Keep the details off phone lock screens: just say someone needs a look.
      const low = entry.mood <= 2 || entry.energy <= 2;
      const why = entry.wantsChat ? 'would like a chat'
        : low ? 'may need some support'
        : 'left a comment on their wellbeing check-in';
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
      const st = status(u, now);
      const lastAt = entries[0] ? Date.parse(entries[0].at) : 0;
      const skippedAt = u.wellbeingSkippedAt ? Date.parse(u.wellbeingSkippedAt) : 0;
      return {
        userId: u.id,
        name: u.name,
        latest: entries[0] || null,
        recent: entries.slice(0, 8).reverse().map((e) => ({ at: e.at, mood: e.mood, energy: e.energy })),
        overdue: st.due,
        thisWeek: st.due ? 'due' : skippedAt > lastAt ? 'skipped' : 'answered',
        skipStreak: u.wellbeingSkipStreak || 0,
        daysSinceAnswer: lastAt ? Math.floor((now - lastAt) / DAY) : null,
      };
    });
    const needsFollowUp = db().wellbeing
      .filter((e) => e.flagged && !e.followedUpAt)
      .map((e) => ({ ...(e.level ? {} : assess(e, null)), ...e, workerName: names[e.userId] || 'Unknown' }))
      .sort((a, b) => LEVELS.indexOf(b.level) - LEVELS.indexOf(a.level));
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

module.exports = { createWellbeing, assess };
