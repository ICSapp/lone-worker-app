// The safety rules: shifts, check-ins, SOS, missed check-ins and escalation.
'use strict';

const MIN = 60 * 1000;
const DUE_SOON_MS = 5 * MIN;
const ALLOWED_INTERVALS = [1, 15, 30, 45, 60, 90, 120, 180, 240];

class SafetyError extends Error {
  constructor(message, status = 400) {
    super(message);
    this.status = status;
  }
}

function iso(ms) {
  return new Date(ms).toISOString();
}

function cleanPosition(p) {
  if (!p || typeof p !== 'object') return null;
  const lat = Number(p.lat);
  const lng = Number(p.lng);
  if (!Number.isFinite(lat) || !Number.isFinite(lng)) return null;
  if (lat < -90 || lat > 90 || lng < -180 || lng > 180) return null;
  const acc = Number(p.accuracy);
  return { lat, lng, accuracy: Number.isFinite(acc) ? Math.round(acc) : null };
}

function cleanText(s, max = 200) {
  return String(s || '').trim().slice(0, max);
}

function createSafety(store, notify) {
  const db = () => store.db;
  const settings = () => store.db.settings;

  function activeShiftFor(userId) {
    return db().shifts.find((s) => s.userId === userId && !s.endedAt) || null;
  }

  function userName(userId) {
    const u = db().users.find((x) => x.id === userId);
    return u ? u.name : 'Unknown worker';
  }

  function addEvent(shift, type, now, extra = {}) {
    const ev = {
      id: store.id(),
      shiftId: shift ? shift.id : null,
      userId: shift ? shift.userId : extra.userId || null,
      type,
      at: iso(now),
      ...extra,
    };
    db().events.unshift(ev);
    store.save();
    return ev;
  }

  function setLocation(shift, pos, now) {
    if (!pos) return;
    shift.lastLocation = { ...pos, at: iso(now) };
  }

  function mapLink(loc) {
    return loc ? `https://www.openstreetmap.org/?mlat=${loc.lat}&mlon=${loc.lng}#map=17/${loc.lat}/${loc.lng}` : 'no location shared';
  }

  function managers() {
    return db().users.filter((u) => u.role === 'manager' && u.active);
  }

  function notifyManagers(subject, body, alertId) {
    for (const m of managers()) notify({ to: m, subject, body, alertId });
  }

  function notifyContacts(subject, body, alertId) {
    for (const c of db().contacts) notify({ to: c, subject, body, alertId });
  }

  function raiseAlert(shift, type, now, note = '') {
    const alert = {
      id: store.id(),
      shiftId: shift.id,
      userId: shift.userId,
      type, // 'missed' | 'sos'
      level: 1,
      note,
      createdAt: iso(now),
      acknowledgedAt: null,
      acknowledgedBy: null,
      resolution: null,
    };
    db().alerts.unshift(alert);
    store.save();
    return alert;
  }

  function openAlertsFor(shiftId) {
    return db().alerts.filter((a) => a.shiftId === shiftId && !a.acknowledgedAt);
  }

  // ---- worker actions ------------------------------------------------------

  function startShift(user, { locationNote, intervalMin, position } = {}, now = Date.now()) {
    if (activeShiftFor(user.id)) throw new SafetyError('You already have a shift running.', 409);
    if (!user.consentAt) throw new SafetyError('Please read and accept the privacy notice first.', 403);
    let interval = Number(intervalMin) || settings().defaultIntervalMin;
    if (!ALLOWED_INTERVALS.includes(interval)) throw new SafetyError('Choose a valid check-in interval.');
    const shift = {
      id: store.id(),
      userId: user.id,
      locationNote: cleanText(locationNote),
      intervalMin: interval,
      startedAt: iso(now),
      endedAt: null,
      lastCheckinAt: iso(now),
      nextDueAt: iso(now + interval * MIN),
      status: 'ok', // ok | overdue | sos
      lastLocation: null,
    };
    setLocation(shift, cleanPosition(position), now);
    db().shifts.unshift(shift);
    addEvent(shift, 'start', now, { note: shift.locationNote, location: shift.lastLocation });
    return shift;
  }

  function requireShift(user) {
    const shift = activeShiftFor(user.id);
    if (!shift) throw new SafetyError('You do not have a shift running.', 409);
    return shift;
  }

  function checkIn(user, { position } = {}, now = Date.now()) {
    const shift = requireShift(user);
    const pos = cleanPosition(position);
    setLocation(shift, pos, now);
    shift.lastCheckinAt = iso(now);
    shift.nextDueAt = iso(now + shift.intervalMin * MIN);
    addEvent(shift, 'checkin', now, { location: pos ? shift.lastLocation : null });
    if (shift.status === 'overdue') {
      shift.status = 'ok';
      for (const a of openAlertsFor(shift.id).filter((x) => x.type === 'missed')) {
        a.acknowledgedAt = iso(now);
        a.acknowledgedBy = 'worker';
        a.resolution = 'Worker checked in late and is OK.';
      }
      notifyManagers('All clear', `${user.name} has now checked in and is OK.`);
    }
    store.save();
    return shift;
  }

  function updateLocation(user, { position } = {}, now = Date.now()) {
    const shift = requireShift(user);
    const pos = cleanPosition(position);
    if (!pos) throw new SafetyError('Location was not valid.');
    setLocation(shift, pos, now);
    addEvent(shift, 'location', now, { location: shift.lastLocation });
    return shift;
  }

  function sos(user, { position, note } = {}, now = Date.now()) {
    const shift = requireShift(user);
    setLocation(shift, cleanPosition(position), now);
    shift.status = 'sos';
    const text = cleanText(note, 300);
    addEvent(shift, 'sos', now, { location: shift.lastLocation, note: text });
    const alert = raiseAlert(shift, 'sos', now, text);
    const body = `${user.name} pressed SOS${shift.locationNote ? ` at ${shift.locationNote}` : ''}. Location: ${mapLink(shift.lastLocation)}${text ? `. Note: ${text}` : ''}`;
    // SOS goes to everyone straight away.
    notifyManagers('SOS - emergency', body, alert.id);
    notifyContacts('SOS - emergency', body, alert.id);
    store.save();
    return { shift, alert };
  }

  function endShift(user, now = Date.now()) {
    const shift = requireShift(user);
    if (shift.status === 'sos') throw new SafetyError('An SOS is active. Your manager must clear it before the shift can end.', 409);
    shift.endedAt = iso(now);
    shift.status = 'ended';
    addEvent(shift, 'end', now);
    for (const a of openAlertsFor(shift.id)) {
      a.acknowledgedAt = iso(now);
      a.acknowledgedBy = 'worker';
      a.resolution = 'Worker ended their shift safely.';
    }
    store.save();
    return shift;
  }

  // ---- manager actions -----------------------------------------------------

  function acknowledge(manager, alertId, note, now = Date.now()) {
    const alert = db().alerts.find((a) => a.id === alertId);
    if (!alert) throw new SafetyError('Alert not found.', 404);
    if (alert.acknowledgedAt) return alert;
    alert.acknowledgedAt = iso(now);
    alert.acknowledgedBy = manager.name;
    alert.resolution = cleanText(note, 500) || 'Acknowledged';
    const shift = db().shifts.find((s) => s.id === alert.shiftId);
    if (shift && !shift.endedAt && openAlertsFor(shift.id).length === 0) {
      // Manager has dealt with it: restart the worker's timer.
      shift.status = 'ok';
      shift.lastCheckinAt = iso(now);
      shift.nextDueAt = iso(now + shift.intervalMin * MIN);
    }
    addEvent(shift, 'ack', now, { note: `${manager.name}: ${alert.resolution}` });
    store.save();
    return alert;
  }

  // ---- background check, run every few seconds ----------------------------

  function tick(now = Date.now()) {
    const s = settings();
    for (const shift of db().shifts) {
      if (shift.endedAt || shift.status !== 'ok') continue;
      const due = Date.parse(shift.nextDueAt);
      if (now > due + s.graceMin * MIN) {
        shift.status = 'overdue';
        const name = userName(shift.userId);
        addEvent(shift, 'missed', now);
        const alert = raiseAlert(shift, 'missed', now);
        notifyManagers(
          'Missed check-in',
          `${name} missed their check-in (due ${new Date(due).toLocaleTimeString('en-GB', { hour: '2-digit', minute: '2-digit', timeZone: 'Europe/London' })})${shift.locationNote ? ` at ${shift.locationNote}` : ''}. Last known location: ${mapLink(shift.lastLocation)}. Please try to contact them.`,
          alert.id,
        );
        // Office staff and on-call contacts are told straight away too.
        notifyContacts(
          'Missed check-in',
          `${name} missed their check-in${shift.locationNote ? ` at ${shift.locationNote}` : ''}. Last known location: ${mapLink(shift.lastLocation)}. Please try to contact them.`,
          alert.id,
        );
      }
    }
    for (const alert of db().alerts) {
      if (alert.acknowledgedAt || alert.level >= 2) continue;
      if (now > Date.parse(alert.createdAt) + s.escalateAfterMin * MIN) {
        alert.level = 2;
        const shift = db().shifts.find((x) => x.id === alert.shiftId);
        const name = userName(alert.userId);
        addEvent(shift, 'escalated', now);
        const what = alert.type === 'sos' ? 'pressed SOS' : 'missed a check-in';
        const subject = 'ESCALATION - alert still not dealt with';
        const body = `${name} ${what} and nobody has marked it as dealt with for ${s.escalateAfterMin} minutes. Last known location: ${mapLink(shift && shift.lastLocation)}. Follow your emergency procedure.`;
        notifyManagers(subject, body, alert.id);
        notifyContacts(subject, body, alert.id);
      }
    }
    store.save();
  }

  // GDPR: delete location history older than the retention period.
  function purgeOldData(now = Date.now()) {
    const cutoff = now - settings().retentionDays * 24 * 60 * MIN;
    const before = db().events.length;
    db().events = db().events.filter((e) => Date.parse(e.at) >= cutoff);
    for (const sh of db().shifts) {
      if (sh.endedAt && Date.parse(sh.endedAt) < cutoff && sh.lastLocation) sh.lastLocation = null;
    }
    db().notifications = db().notifications.filter((n) => Date.parse(n.at) >= cutoff);
    if (db().events.length !== before) store.save();
    return before - db().events.length;
  }

  function shiftView(shift, now = Date.now()) {
    let display = shift.status;
    if (shift.status === 'ok') {
      const due = Date.parse(shift.nextDueAt);
      if (now > due) display = 'late';
      else if (due - now < DUE_SOON_MS) display = 'due_soon';
    }
    return {
      ...shift,
      workerName: userName(shift.userId),
      displayStatus: display,
      openAlerts: openAlertsFor(shift.id),
    };
  }

  return {
    activeShiftFor,
    startShift,
    checkIn,
    updateLocation,
    sos,
    endShift,
    acknowledge,
    tick,
    purgeOldData,
    shiftView,
    ALLOWED_INTERVALS,
  };
}

module.exports = { createSafety, SafetyError, ALLOWED_INTERVALS };
