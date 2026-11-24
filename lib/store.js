// Tiny JSON-file database. Good enough for a small team; swap for a real
// database (e.g. Postgres) when the app grows.
'use strict';

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const DEFAULT_SETTINGS = {
  orgName: 'Lone Worker Safety',
  defaultIntervalMin: 60,     // how often workers must check in
  graceMin: 5,                // extra time after a missed check-in before raising an alert
  escalateAfterMin: 10,       // unacknowledged alert -> remind managers + office/on-call again
  retentionDays: 30,          // location history is deleted after this many days (GDPR)
};

function emptyDb() {
  return {
    users: [],
    tokens: {},
    shifts: [],
    events: [],
    alerts: [],
    contacts: [],
    notifications: [],
    settings: { ...DEFAULT_SETTINGS },
  };
}

class Store {
  constructor(file) {
    this.file = file;
    this.db = emptyDb();
    this._timer = null;
    if (file && fs.existsSync(file)) {
      const loaded = JSON.parse(fs.readFileSync(file, 'utf8'));
      this.db = { ...emptyDb(), ...loaded, settings: { ...DEFAULT_SETTINGS, ...(loaded.settings || {}) } };
    }
  }

  id() {
    return crypto.randomUUID();
  }

  // Debounced write so many quick changes become one disk write.
  save() {
    if (!this.file) return;
    if (this._timer) return;
    this._timer = setTimeout(() => this.flush(), 200);
  }

  flush() {
    if (this._timer) clearTimeout(this._timer);
    this._timer = null;
    if (!this.file) return;
    fs.mkdirSync(path.dirname(this.file), { recursive: true });
    const tmp = this.file + '.tmp';
    fs.writeFileSync(tmp, JSON.stringify(this.db, null, 2));
    fs.renameSync(tmp, this.file);
  }
}

module.exports = { Store, DEFAULT_SETTINGS };
