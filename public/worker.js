// Worker (engineer) screen.
'use strict';

const app = document.getElementById('app');
const state = {
  user: null,
  shift: null,
  intervals: [15, 30, 45, 60, 90, 120],
  defaultIntervalMin: 60,
  graceMin: 5,
  position: null,       // latest GPS fix
  geoError: null,
  watchId: null,
  lastSentAt: 0,
  warned: { soon: null, due: null },
};

const LOCATION_SEND_MS = 2 * 60 * 1000;

// ---------------------------------------------------------------- location

function currentPos() {
  return state.position ? { ...state.position } : null;
}

function startLocation() {
  if (!('geolocation' in navigator) || state.watchId != null) return;
  state.watchId = navigator.geolocation.watchPosition(
    (p) => {
      state.position = { lat: p.coords.latitude, lng: p.coords.longitude, accuracy: p.coords.accuracy };
      state.geoError = null;
      updateLocationLine();
      if (state.shift && Date.now() - state.lastSentAt > LOCATION_SEND_MS) {
        state.lastSentAt = Date.now();
        api('POST', '/api/shift/location', { position: currentPos() }).catch(() => {});
      }
    },
    (err) => {
      state.geoError = err.code === 1 ? 'Location is blocked. Allow location for this site in your phone settings.' : 'Could not get your location right now.';
      updateLocationLine();
    },
    { enableHighAccuracy: true, maximumAge: 30000, timeout: 20000 },
  );
}

function stopLocation() {
  if (state.watchId != null) navigator.geolocation.clearWatch(state.watchId);
  state.watchId = null;
  state.position = null;
}

// Ask once for a fresh fix, but never wait more than a few seconds.
function freshPosition(timeoutMs = 6000) {
  return new Promise((resolve) => {
    if (!('geolocation' in navigator)) return resolve(currentPos());
    let done = false;
    const finish = (v) => { if (!done) { done = true; resolve(v); } };
    setTimeout(() => finish(currentPos()), timeoutMs);
    navigator.geolocation.getCurrentPosition(
      (p) => {
        state.position = { lat: p.coords.latitude, lng: p.coords.longitude, accuracy: p.coords.accuracy };
        finish(currentPos());
      },
      () => finish(currentPos()),
      { enableHighAccuracy: true, maximumAge: 10000, timeout: timeoutMs },
    );
  });
}

function updateLocationLine() {
  const el = document.getElementById('locline');
  if (!el) return;
  if (state.geoError) {
    el.textContent = state.geoError;
    el.className = 'muted warn-text';
  } else if (state.position) {
    el.textContent = `Location shared with your team (accurate to about ${Math.round(state.position.accuracy || 0)} m).`;
    el.className = 'muted';
  } else {
    el.textContent = 'Finding your location...';
    el.className = 'muted';
  }
}

// ----------------------------------------------------------- local warnings

function buzz(pattern) {
  if (navigator.vibrate) navigator.vibrate(pattern);
}

async function localNotify(title, body) {
  try {
    if (!('Notification' in window) || Notification.permission !== 'granted') return;
    const reg = await navigator.serviceWorker?.getRegistration();
    if (reg) reg.showNotification(title, { body, icon: '/icon.svg', tag: 'checkin', renotify: true, requireInteraction: true });
    else new Notification(title, { body });
  } catch { /* not supported */ }
}

// ------------------------------------------------------------------ screens

function setScreen(...nodes) {
  app.replaceChildren(...nodes);
}

function renderLogin() {
  document.getElementById('signout').classList.add('hidden');
  const err = h('p', { class: 'error', role: 'alert' });
  const form = h('form', { class: 'card stack', autocomplete: 'on' },
    h('h1', {}, 'Sign in'),
    h('label', {}, 'Username', h('input', { name: 'username', autocomplete: 'username', autocapitalize: 'none', required: true })),
    h('label', {}, 'PIN', h('input', { name: 'secret', type: 'password', inputmode: 'numeric', autocomplete: 'current-password', required: true })),
    err,
    h('button', { class: 'btn primary big', type: 'submit' }, 'Sign in'),
    h('p', { class: 'muted small' }, 'Office or manager? ', h('a', { href: '/manager' }, 'Open the dashboard')),
  );
  form.addEventListener('submit', async (e) => {
    e.preventDefault();
    err.textContent = '';
    const fd = new FormData(form);
    try {
      const r = await api('POST', '/api/login', { username: fd.get('username'), secret: fd.get('secret') });
      if (r.user.role !== 'worker') {
        setToken(r.token);
        location.href = '/manager';
        return;
      }
      setToken(r.token);
      state.user = r.user;
      await load();
    } catch (ex) {
      err.textContent = ex.message;
    }
  });
  setScreen(form);
}

function renderConsent() {
  const box = h('section', { class: 'card stack' },
    h('h1', {}, 'Before you start'),
    h('p', {}, 'This app is here to keep you safe when you work alone. Please read how it uses your information.'),
    h('ul', { class: 'plain-list' },
      h('li', {}, 'Your location is shared with the office and on-call team ', h('strong', {}, 'only while a shift is running'), '. It stops when you end your shift.'),
      h('li', {}, 'If you miss a check-in or press SOS, the office and on-call team are alerted with your last known location.'),
      h('li', {}, 'Location history is deleted automatically after a set number of days.'),
      h('li', {}, 'You can ask your manager for a copy of the information held about you, or ask for it to be corrected or deleted.'),
    ),
    h('p', { class: 'muted small' }, 'The lawful basis is your employer’s legal duty to protect lone workers and its legitimate interest in your safety. Ask your manager for the full privacy notice.'),
    h('button', { class: 'btn primary big', type: 'button', onclick: async () => {
      try {
        const r = await api('POST', '/api/consent');
        state.user = r.user;
        await load();
      } catch (ex) { toast(ex.message, 'bad'); }
    } }, 'I understand'),
  );
  setScreen(box);
}

// ------------------------------------------------------ wellbeing check-in

const MOOD = [[1, '\u{1F61E}', 'Very low'], [2, '\u{1F641}', 'Low'], [3, '\u{1F610}', 'OK'], [4, '\u{1F642}', 'Good'], [5, '\u{1F604}', 'Great']];
const ENERGY = [[1, '\u{1F635}', 'Exhausted'], [2, '\u{1F62B}', 'Very tired'], [3, '\u{1F971}', 'A bit tired'], [4, '\u{1F642}', 'Fine'], [5, '\u{26A1}', 'Full of energy']];

function scaleField(name, legend, options) {
  return h('fieldset', { class: 'scale' },
    h('legend', {}, legend),
    h('div', { class: 'scale-row' }, options.map(([v, icon, text]) => h('label', { class: 'scale-opt' },
      h('input', { type: 'radio', name, value: v, required: true }),
      h('span', { class: 'scale-icon', 'aria-hidden': 'true' }, icon),
      h('span', { class: 'scale-text' }, text),
    ))),
  );
}

function wellbeingCard() {
  const err = h('p', { class: 'error', role: 'alert' });
  const form = h('form', { class: 'card stack wellbeing' },
    h('h2', {}, 'Weekly wellbeing check'),
    h('p', { class: 'muted small' }, 'Optional and takes 30 seconds. Working alone can be tough, and this helps the office know if you need support. Only managers see your answers, and they are deleted after a few months.'),
    scaleField('mood', 'How are you feeling this week?', MOOD),
    scaleField('energy', 'How tired are you?', ENERGY),
    h('label', { class: 'check' }, h('input', { type: 'checkbox', name: 'wantsChat' }), 'I\u2019d like a chat with someone'),
    h('label', {}, 'Anything you\u2019d like to add? (optional)', h('textarea', { name: 'comment', rows: 2, maxlength: 500 })),
    err,
    h('div', { class: 'row-buttons' },
      h('button', { class: 'btn primary', type: 'submit' }, 'Send'),
      h('button', { class: 'btn ghost', type: 'button', onclick: async () => {
        await api('POST', '/api/wellbeing', { skip: true }).catch(() => {});
        form.remove();
      } }, 'Skip this week'),
    ),
  );
  form.addEventListener('submit', async (e) => {
    e.preventDefault();
    err.textContent = '';
    const fd = new FormData(form);
    try {
      const r = await api('POST', '/api/wellbeing', { mood: Number(fd.get('mood')), energy: Number(fd.get('energy')), wantsChat: fd.get('wantsChat') === 'on', comment: fd.get('comment') });
      form.replaceChildren(h('p', {}, r.flagged
        ? 'Thank you. Someone from the office will be in touch. If you need to talk to someone right now, call the office or Samaritans on 116 123 (free, any time).'
        : 'Thank you for checking in. See you next week.'));
    } catch (ex) { err.textContent = ex.message; }
  });
  return form;
}

async function maybeShowWellbeing() {
  try {
    const st = await api('GET', '/api/wellbeing/status');
    if (st.due && !state.shift && !document.querySelector('.wellbeing')) app.append(wellbeingCard());
  } catch { /* not important */ }
}

function renderStart() {
  stopLocation();
  const select = h('select', { name: 'intervalMin' },
    state.intervals.map((m) => h('option', { value: m, selected: m === state.defaultIntervalMin }, m === 1 ? '1 minute (testing only)' : m < 60 ? `${m} minutes` : m % 60 === 0 ? `${m / 60} hour${m > 60 ? 's' : ''}` : `${Math.floor(m / 60)} h ${m % 60} min`)),
  );
  const err = h('p', { class: 'error', role: 'alert' });
  const form = h('form', { class: 'card stack' },
    h('h1', {}, `Hi ${state.user.name.split(' ')[0]}`),
    h('p', {}, 'Start a shift when you arrive on site and are working alone.'),
    h('label', {}, 'Site or job', h('input', { name: 'locationNote', placeholder: 'e.g. Unit 4, Riverside Estate', maxlength: 200 })),
    h('label', {}, 'Check in every', select),
    h('p', { class: 'muted small' }, 'Your location will be shared with the office and on-call team until you end the shift.'),
    err,
    h('button', { class: 'btn go big', type: 'submit' }, 'Start shift'),
  );
  form.addEventListener('submit', async (e) => {
    e.preventDefault();
    err.textContent = '';
    const btn = form.querySelector('button[type=submit]');
    btn.disabled = true;
    btn.textContent = 'Starting...';
    try {
      if ('Notification' in window && Notification.permission === 'default') Notification.requestPermission().catch(() => {});
      startLocation();
      const position = await freshPosition(5000);
      const fd = new FormData(form);
      const r = await api('POST', '/api/shift/start', { locationNote: fd.get('locationNote'), intervalMin: Number(fd.get('intervalMin')), position });
      state.shift = r.shift;
      state.lastSentAt = Date.now();
      renderShift();
    } catch (ex) {
      err.textContent = ex.message;
      btn.disabled = false;
      btn.textContent = 'Start shift';
    }
  });
  setScreen(form);
  maybeShowWellbeing();
}

function renderShift() {
  startLocation();
  const s = state.shift;
  const isSos = s.status === 'sos';

  const sosBtn = h('button', { class: 'sos-btn', type: 'button', id: 'sos', 'aria-label': 'SOS. Press and hold for 3 seconds to call for help.' },
    h('span', { class: 'sos-label' }, 'SOS'),
    h('span', { class: 'sos-sub' }, 'Hold 3 seconds'),
    h('span', { class: 'sos-fill', id: 'sosfill' }),
  );
  setupHold(sosBtn);

  const top = isSos
    ? h('section', { class: 'banner sos-active', role: 'alert' },
        h('strong', {}, 'SOS sent. Help is being alerted.'),
        h('p', {}, 'The office and on-call team have your location. Stay where it is safe. Your manager will clear the alert once you are safe.'),
      )
    : h('section', { class: 'card center' },
        h('p', { class: 'muted' }, 'Next check-in due'),
        h('div', { class: 'countdown', id: 'countdown' }, '--:--'),
        h('p', { class: 'muted', id: 'dueat' }, ''),
        h('div', { id: 'statusmsg' }),
        h('button', { class: 'btn go huge', type: 'button', id: 'checkin', onclick: doCheckIn }, "I'm OK – check in"),
      );

  setScreen(
    top,
    h('section', { class: 'center' }, sosBtn),
    h('section', { class: 'card stack small-gap' },
      h('div', {}, h('span', { class: 'muted' }, 'Site: '), s.locationNote || 'Not given'),
      h('div', {}, h('span', { class: 'muted' }, 'Started: '), fmtTime(s.startedAt), h('span', { class: 'muted' }, ` · checking in every ${s.intervalMin} min`)),
      h('p', { id: 'locline', class: 'muted' }),
      h('button', { class: 'btn ghost', type: 'button', onclick: doEnd, disabled: isSos }, 'End shift – I’m finished and safe'),
    ),
  );
  updateLocationLine();
  tickUi();
}

function setupHold(btn) {
  let timer = null;
  let start = 0;
  let raf = null;
  const HOLD_MS = 3000;
  const fill = () => btn.querySelector('.sos-fill');
  const cancel = () => {
    clearTimeout(timer);
    cancelAnimationFrame(raf);
    timer = null;
    btn.classList.remove('holding');
    if (fill()) fill().style.transform = 'scaleY(0)';
  };
  const frame = () => {
    const p = Math.min(1, (Date.now() - start) / HOLD_MS);
    if (fill()) fill().style.transform = `scaleY(${p})`;
    if (timer) raf = requestAnimationFrame(frame);
  };
  const begin = (e) => {
    e.preventDefault();
    if (timer) return;
    start = Date.now();
    btn.classList.add('holding');
    buzz(50);
    timer = setTimeout(() => { cancel(); doSos(); }, HOLD_MS);
    raf = requestAnimationFrame(frame);
  };
  btn.addEventListener('pointerdown', begin);
  btn.addEventListener('pointerup', cancel);
  btn.addEventListener('pointerleave', cancel);
  btn.addEventListener('pointercancel', cancel);
  btn.addEventListener('contextmenu', (e) => e.preventDefault());
  // Keyboard: hold Space/Enter.
  btn.addEventListener('keydown', (e) => { if ((e.key === ' ' || e.key === 'Enter') && !e.repeat) begin(e); });
  btn.addEventListener('keyup', (e) => { if (e.key === ' ' || e.key === 'Enter') cancel(); });
}

// ------------------------------------------------------------------ actions

async function doCheckIn() {
  const btn = document.getElementById('checkin');
  if (btn) { btn.disabled = true; btn.textContent = 'Sending...'; }
  try {
    const position = await freshPosition(4000);
    const r = await api('POST', '/api/shift/checkin', { position });
    state.shift = r.shift;
    state.lastSentAt = Date.now();
    state.warned = { soon: null, due: null };
    buzz(80);
    toast('Checked in. Thanks, stay safe.', 'good');
    renderShift();
  } catch (ex) {
    toast(ex.offline ? 'Check-in NOT sent: no signal. Try again or phone the office.' : ex.message, 'bad');
    if (btn) { btn.disabled = false; btn.textContent = "I'm OK – check in"; }
  }
}

async function doSos() {
  buzz([200, 100, 200, 100, 400]);
  toast('Sending SOS...', 'bad');
  try {
    const position = await freshPosition(4000);
    const r = await api('POST', '/api/shift/sos', { position });
    state.shift = r.shift;
    renderShift();
  } catch (ex) {
    // Retry a few times: SOS must get through.
    toast((ex.offline ? 'SOS not sent yet, retrying. ' : ex.message + ' ') + 'If you can, call 999.', 'bad');
    doSos.retries = (doSos.retries || 0) + 1;
    if (doSos.retries <= 5) setTimeout(doSos, 5000);
    return;
  }
  doSos.retries = 0;
  toast('SOS sent.', 'bad');
}

async function doEnd() {
  if (!confirmInline('Tap again to end your shift')) return;
  try {
    await api('POST', '/api/shift/end');
    state.shift = null;
    stopLocation();
    toast('Shift ended. Location sharing has stopped.', 'good');
    renderStart();
  } catch (ex) { toast(ex.message, 'bad'); }
}

// Two-tap confirm without a blocking dialog.
function confirmInline(msg) {
  const now = Date.now();
  if (confirmInline.at && now - confirmInline.at < 4000) {
    confirmInline.at = 0;
    return true;
  }
  confirmInline.at = now;
  toast(msg);
  return false;
}

// -------------------------------------------------------------- clock / sync

function tickUi() {
  const s = state.shift;
  if (!s || s.status === 'sos') return;
  const cd = document.getElementById('countdown');
  if (!cd) return;
  const due = Date.parse(s.nextDueAt);
  const left = due - Date.now();
  cd.textContent = fmtCountdown(left);
  document.getElementById('dueat').textContent = 'at ' + fmtTime(s.nextDueAt);
  const msg = document.getElementById('statusmsg');
  let cls = 'ok';
  let text = '';
  if (s.status === 'overdue') {
    cls = 'bad';
    text = 'You missed your check-in. The office has been alerted. Check in now if you are OK.';
  } else if (left < 0) {
    cls = 'bad';
    text = `Check-in overdue. The office will be alerted in ${Math.max(0, Math.ceil((due + state.graceMin * 60000 - Date.now()) / 60000))} min.`;
    if (state.warned.due !== s.nextDueAt) {
      state.warned.due = s.nextDueAt;
      buzz([400, 200, 400, 200, 400]);
      localNotify('Check-in overdue', 'Open the app and tap "I\'m OK" now.');
    }
  } else if (left < 5 * 60000) {
    cls = 'warn';
    text = 'Check-in due soon.';
    if (state.warned.soon !== s.nextDueAt) {
      state.warned.soon = s.nextDueAt;
      buzz([200, 100, 200]);
      localNotify('Check-in due soon', 'Tap "I\'m OK" in the app to check in.');
    }
  }
  cd.className = 'countdown ' + cls;
  msg.className = text ? 'banner ' + cls : '';
  msg.textContent = text;
}
setInterval(tickUi, 1000);

async function sync() {
  if (!state.user || state.user.role !== 'worker') return;
  try {
    const r = await api('GET', '/api/shift');
    const before = state.shift ? state.shift.status + state.shift.nextDueAt : null;
    state.shift = r.shift;
    const after = state.shift ? state.shift.status + state.shift.nextDueAt : null;
    if (before !== after) state.shift ? renderShift() : renderStart();
  } catch (ex) {
    if (ex.status === 401) { setToken(null); state.user = null; renderLogin(); }
  }
}
setInterval(sync, 30000);
document.addEventListener('visibilitychange', () => { if (!document.hidden) sync(); });

// --------------------------------------------------------------------- boot

async function load() {
  document.getElementById('signout').classList.remove('hidden');
  if (!state.user.consentAt) return renderConsent();
  const r = await api('GET', '/api/shift');
  state.intervals = r.intervals;
  state.defaultIntervalMin = r.defaultIntervalMin;
  state.graceMin = r.graceMin;
  state.shift = r.shift;
  return state.shift ? renderShift() : renderStart();
}

document.getElementById('signout').addEventListener('click', async () => {
  if (state.shift) { toast('End your shift before signing out.', 'bad'); return; }
  await api('POST', '/api/logout').catch(() => {});
  setToken(null);
  state.user = null;
  renderLogin();
});

(async function boot() {
  if (!getToken()) return renderLogin();
  try {
    const r = await api('GET', '/api/me');
    document.getElementById('org').textContent = r.orgName;
    if (r.user.role !== 'worker') { location.href = '/manager'; return; }
    state.user = r.user;
    await load();
  } catch (ex) {
    if (ex.status === 401) setToken(null);
    if (ex.offline) {
      setScreen(h('section', { class: 'card' }, h('p', {}, 'No connection. The app needs signal to keep you safe. If you are in danger call 999.')));
      setTimeout(boot, 10000);
      return;
    }
    renderLogin();
  }
})();
