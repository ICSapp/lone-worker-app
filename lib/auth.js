'use strict';

const crypto = require('crypto');

const TOKEN_TTL_MS = 1000 * 60 * 60 * 24 * 14; // stay signed in for 14 days

function hashSecret(secret, salt = crypto.randomBytes(16).toString('hex')) {
  const hash = crypto.scryptSync(String(secret), salt, 64).toString('hex');
  return { salt, hash };
}

function checkSecret(secret, salt, hash) {
  const candidate = crypto.scryptSync(String(secret), salt, 64);
  const stored = Buffer.from(hash, 'hex');
  return stored.length === candidate.length && crypto.timingSafeEqual(stored, candidate);
}

function issueToken(store, userId, now = Date.now()) {
  const token = crypto.randomBytes(32).toString('hex');
  store.db.tokens[token] = { userId, expiresAt: now + TOKEN_TTL_MS };
  store.save();
  return token;
}

function userForToken(store, token, now = Date.now()) {
  if (!token) return null;
  const t = store.db.tokens[token];
  if (!t) return null;
  if (t.expiresAt < now) {
    delete store.db.tokens[token];
    store.save();
    return null;
  }
  const user = store.db.users.find((u) => u.id === t.userId && u.active);
  return user || null;
}

function revokeUserTokens(store, userId) {
  for (const [tok, t] of Object.entries(store.db.tokens)) {
    if (t.userId === userId) delete store.db.tokens[tok];
  }
  store.save();
}

// Simple brute-force protection: 5 wrong tries locks that username for 5 minutes.
const attempts = new Map();
function loginAllowed(username, now = Date.now()) {
  const a = attempts.get(username);
  return !a || a.lockedUntil < now;
}
function recordLoginFailure(username, now = Date.now()) {
  const a = attempts.get(username) || { count: 0, lockedUntil: 0 };
  a.count += 1;
  if (a.count >= 5) {
    a.lockedUntil = now + 5 * 60 * 1000;
    a.count = 0;
  }
  attempts.set(username, a);
}
function recordLoginSuccess(username) {
  attempts.delete(username);
}

function publicUser(u) {
  return {
    id: u.id,
    name: u.name,
    username: u.username,
    role: u.role,
    phone: u.phone || '',
    active: u.active,
    consentAt: u.consentAt || null,
    alertDevices: (u.pushSubs || []).length,
    createdAt: u.createdAt,
  };
}

module.exports = {
  hashSecret,
  checkSecret,
  issueToken,
  userForToken,
  revokeUserTokens,
  loginAllowed,
  recordLoginFailure,
  recordLoginSuccess,
  publicUser,
};
