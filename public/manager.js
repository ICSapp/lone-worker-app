// Manager / office dashboard.
'use strict';

const app = document.getElementById('app');
const tabsEl = document.getElementById('tabs');
const STATUS_TEXT = {
  sos: 'SOS',
  overdue: 'Missed check-in',
  late: 'Check-in late',
  due_soon: 'Due soon',
  ok: 'OK',
};
const ui = { tab: 'live', me: null, dash: null, seenAlerts: new Set(), pollTimer: null, firstLoad: true };

function setScreen(...nodes) { app.replaceChildren(...nodes); }

// ------------------------------------------------------------------- sound

let audioCtx = null;
function alarm() {
  try {
    audioCtx = audioCtx || new (window.AudioContext || window.webkitAudioContext)();
    const t = audioCtx.currentTime;
    for (let i = 0; i < 3; i++) {
      const o = audioCtx.createOscillator();
      const g = audioCtx.createGain();
      o.frequency.value = i % 2 ? 660 : 880;
      g.gain.setValueAtTime(0.25, t + i * 0.35);
      g.gain.exponentialRampToValueAtTime(0.001, t + i * 0.35 + 0.3);
      o.connect(g).connect(audioCtx.destination);
      o.start(t + i * 0.35);
      o.stop(t + i * 0.35 + 0.3);
    }
  } catch { /* no audio */ }
}

// ------------------------------------------------------------ setup/login

async function renderAuth() {
  tabsEl.classList.add('hidden');
  document.getElementById('signout').classList.add('hidden');
  let status = { needsSetup: false };
  try { status = await api('GET', '/api/setup-status'); } catch { /* ignore */ }
  const err = h('p', { class: 'error', role: 'alert' });
  let form;
  if (status.needsSetup) {
    form = h('form', { class: 'card stack narrow' },
      h('h1', {}, 'Set up your safety dashboard'),
      h('p', {}, 'Create the first manager account. You can add engineers and other office staff afterwards.'),
      h('label', {}, 'Company name', h('input', { name: 'orgName', placeholder: 'e.g. Smith Engineering Ltd' })),
      h('label', {}, 'Your name', h('input', { name: 'name', required: true, autocomplete: 'name' })),
      h('label', {}, 'Username', h('input', { name: 'username', required: true, autocapitalize: 'none', autocomplete: 'username' })),
      h('label', {}, 'Password (8+ characters)', h('input', { name: 'password', type: 'password', minlength: 8, required: true, autocomplete: 'new-password' })),
      err,
      h('button', { class: 'btn primary big', type: 'submit' }, 'Create account'),
    );
  } else {
    form = h('form', { class: 'card stack narrow' },
      h('h1', {}, 'Dashboard sign in'),
      h('label', {}, 'Username', h('input', { name: 'username', required: true, autocapitalize: 'none', autocomplete: 'username' })),
      h('label', {}, 'Password', h('input', { name: 'password', type: 'password', required: true, autocomplete: 'current-password' })),
      err,
      h('button', { class: 'btn primary big', type: 'submit' }, 'Sign in'),
      h('p', { class: 'muted small' }, 'Engineer? ', h('a', { href: '/' }, 'Open the engineer app')),
    );
  }
  form.addEventListener('submit', async (e) => {
    e.preventDefault();
    err.textContent = '';
    const fd = Object.fromEntries(new FormData(form));
    try {
      const r = status.needsSetup
        ? await api('POST', '/api/setup', fd)
        : await api('POST', '/api/login', { username: fd.username, secret: fd.password });
      if (r.user.role !== 'manager') { setToken(r.token); location.href = '/'; return; }
      setToken(r.token);
      await start();
    } catch (ex) { err.textContent = ex.message; }
  });
  setScreen(form);
}

// ------------------------------------------------- alerts on this device

function b64ToBytes(b64) {
  const pad = '='.repeat((4 - (b64.length % 4)) % 4);
  const raw = atob((b64 + pad).replace(/-/g, '+').replace(/_/g, '/'));
  return Uint8Array.from(raw, (c) => c.charCodeAt(0));
}

function deviceLabel() {
  const ua = navigator.userAgent;
  if (/iPad|Macintosh/.test(ua) && 'ontouchend' in document) return 'iPad';
  if (/iPhone/.test(ua)) return 'iPhone';
  if (/Android/.test(ua)) return 'Android';
  if (/Windows/.test(ua)) return 'Windows computer';
  if (/Mac/.test(ua)) return 'Mac';
  return 'Device';
}

const isIos = () => /iPhone|iPad|iPod/.test(navigator.userAgent) || (/Macintosh/.test(navigator.userAgent) && 'ontouchend' in document);
const isStandalone = () => window.matchMedia('(display-mode: standalone)').matches || navigator.standalone === true;
const pushSupported = () => 'serviceWorker' in navigator && 'PushManager' in window && 'Notification' in window;

ui.pushCard = h('section', { class: 'push-card' });

async function currentSubscription() {
  const reg = await navigator.serviceWorker.ready;
  return reg.pushManager.getSubscription();
}

async function refreshPushCard() {
  const card = ui.pushCard;
  const set = (...nodes) => card.replaceChildren(...nodes);
  if (isIos() && !isStandalone()) {
    card.className = 'push-card off';
    return set(
      h('strong', {}, 'Get alerts on this ' + deviceLabel()),
      h('p', {}, 'Tap the Share button, then "Add to Home Screen". Open the dashboard from your home screen, sign in, and tap "Turn on alerts" there.'),
    );
  }
  if (!pushSupported()) {
    card.className = 'push-card off';
    return set(h('strong', {}, 'This browser cannot show alerts.'), h('p', {}, 'Use Chrome, Edge, Firefox or Safari (on iPhone, add to home screen first).'));
  }
  if (Notification.permission === 'denied') {
    card.className = 'push-card off';
    return set(h('strong', {}, 'Alerts are blocked on this device.'), h('p', {}, 'Allow notifications for this site in your browser or phone settings, then reload this page.'));
  }
  let sub = null;
  try { sub = await currentSubscription(); } catch { /* ignore */ }
  if (sub && Notification.permission === 'granted') {
    // Make sure the server knows about it (e.g. after signing in again).
    api('POST', '/api/push/subscribe', { subscription: sub.toJSON(), label: deviceLabel() }).catch(() => {});
    card.className = 'push-card on';
    return set(
      h('span', {}, h('strong', {}, '\u2713 Alerts are on for this ' + deviceLabel()), h('span', { class: 'muted' }, ' \u2013 you\u2019ll be notified of missed check-ins and SOS even when this page is closed.')),
      h('span', { class: 'push-actions' },
        h('button', { class: 'btn small', type: 'button', onclick: testPush }, 'Send a test'),
        h('button', { class: 'btn small', type: 'button', onclick: disablePush }, 'Turn off'),
      ),
    );
  }
  card.className = 'push-card off';
  return set(
    h('span', {}, h('strong', {}, 'Alerts are off on this ' + deviceLabel() + '.'), ' Turn them on to be notified of missed check-ins and SOS when this page is closed.'),
    h('button', { class: 'btn primary', type: 'button', onclick: enablePush }, 'Turn on alerts'),
  );
}

async function enablePush() {
  try {
    const perm = await Notification.requestPermission();
    if (perm !== 'granted') { toast('Alerts were not allowed.', 'bad'); return refreshPushCard(); }
    const { publicKey } = await api('GET', '/api/push/key');
    const reg = await navigator.serviceWorker.ready;
    let sub = await reg.pushManager.getSubscription();
    if (!sub) sub = await reg.pushManager.subscribe({ userVisibleOnly: true, applicationServerKey: b64ToBytes(publicKey) });
    await api('POST', '/api/push/subscribe', { subscription: sub.toJSON(), label: deviceLabel() });
    toast('Alerts turned on.', 'good');
  } catch (ex) {
    toast(ex.message || 'Could not turn on alerts.', 'bad');
  }
  refreshPushCard();
}

async function disablePush() {
  try {
    const sub = await currentSubscription();
    if (sub) {
      await api('POST', '/api/push/unsubscribe', { endpoint: sub.endpoint }).catch(() => {});
      await sub.unsubscribe();
    }
    toast('Alerts turned off on this device.');
  } catch (ex) { toast(ex.message, 'bad'); }
  refreshPushCard();
}

async function testPush() {
  try {
    await api('POST', '/api/push/test');
    toast('Test sent. It should pop up in a few seconds.', 'good');
  } catch (ex) { toast(ex.message, 'bad'); }
}

// --------------------------------------------------------------------- live

function statusPill(st) {
  return h('span', { class: 'pill ' + st }, STATUS_TEXT[st] || st);
}

function locLink(loc) {
  if (!loc) return h('span', { class: 'muted' }, 'No location yet');
  return h('span', {},
    h('a', { href: mapUrl(loc), target: '_blank', rel: 'noopener' }, 'Open map'),
    h('span', { class: 'muted' }, ` · ±${loc.accuracy ?? '?'} m · ${ago(loc.at)}`),
  );
}

function ackForm(alert) {
  const input = h('input', { placeholder: 'What did you do? e.g. Phoned, they are fine', maxlength: 500 });
  const form = h('form', { class: 'ack' }, input, h('button', { class: 'btn primary', type: 'submit' }, 'Mark as dealt with'));
  form.addEventListener('submit', async (e) => {
    e.preventDefault();
    try {
      await api('POST', `/api/alerts/${alert.id}/ack`, { note: input.value });
      toast('Alert closed.', 'good');
      poll();
    } catch (ex) { toast(ex.message, 'bad'); }
  });
  return form;
}

function renderLive() {
  const d = ui.dash;
  if (!d) return setScreen(h('p', { class: 'muted' }, 'Loading...'));
  const phoneFor = (userId) => (ui.users || []).find((u) => u.id === userId)?.phone;

  const alerts = d.openAlerts.length
    ? h('section', { class: 'stack' },
        d.openAlerts.map((a) => {
          const sh = d.active.find((s) => s.id === a.shiftId);
          const phone = phoneFor(a.userId);
          return h('article', { class: 'alert-card ' + a.type, role: 'alert' },
            h('div', { class: 'alert-head' },
              h('strong', {}, a.type === 'sos' ? `SOS – ${a.workerName}` : `Missed check-in – ${a.workerName}`),
              h('span', { class: 'muted' }, `${fmtTime(a.createdAt)} (${ago(a.createdAt)})${a.level >= 2 ? ' · escalated' : ''}`),
            ),
            sh ? h('p', {}, sh.locationNote ? `Site: ${sh.locationNote} · ` : '', locLink(sh.lastLocation)) : null,
            a.note ? h('p', {}, `Note from engineer: ${a.note}`) : null,
            phone ? h('p', {}, 'Call: ', h('a', { href: 'tel:' + phone }, phone)) : null,
            h('p', { class: 'small muted' }, 'Try to reach them. If you cannot, follow your emergency procedure and call 999 if needed.'),
            ackForm(a),
          );
        }),
      )
    : h('p', { class: 'allclear' }, 'No open alerts.');

  const rows = d.active.map((s) => {
    const left = Date.parse(s.nextDueAt) - Date.now();
    return h('tr', { class: 'row-' + s.displayStatus },
      h('td', {}, h('strong', {}, s.workerName)),
      h('td', {}, statusPill(s.displayStatus)),
      h('td', {}, s.locationNote || h('span', { class: 'muted' }, '-')),
      h('td', {}, s.status === 'sos' ? '-' : h('span', { 'data-due': s.nextDueAt }, fmtCountdown(left)), h('div', { class: 'muted small' }, 'at ' + fmtTime(s.nextDueAt))),
      h('td', {}, fmtTime(s.lastCheckinAt), h('div', { class: 'muted small' }, ago(s.lastCheckinAt))),
      h('td', {}, locLink(s.lastLocation)),
      h('td', {}, fmtTime(s.startedAt)),
    );
  });

  setScreen(
    ui.pushCard,
    h('h2', {}, 'Alerts'),
    alerts,
    h('h2', {}, `On shift now (${d.active.length})`),
    d.active.length
      ? h('div', { class: 'table-wrap' }, h('table', {},
          h('thead', {}, h('tr', {}, ['Engineer', 'Status', 'Site', 'Next check-in', 'Last check-in', 'Location', 'Started'].map((t) => h('th', {}, t)))),
          h('tbody', {}, rows),
        ))
      : h('p', { class: 'muted' }, 'Nobody is on a lone-working shift right now.'),
    h('p', { class: 'muted small' }, `Updated ${fmtTime(d.serverTime)}. This page refreshes every few seconds. Keep it open in the office.`),
  );
}

// Update countdowns every second without rebuilding the page.
setInterval(() => {
  document.querySelectorAll('[data-due]').forEach((el) => {
    el.textContent = fmtCountdown(Date.parse(el.dataset.due) - Date.now());
  });
}, 1000);

async function poll() {
  try {
    ui.dash = await api('GET', '/api/dashboard');
    const fresh = ui.dash.openAlerts.filter((a) => !ui.seenAlerts.has(a.id));
    fresh.forEach((a) => ui.seenAlerts.add(a.id));
    if (fresh.length && !ui.firstLoad) {
      alarm();
      document.title = '⚠ ALERT – Safety Dashboard';
    }
    if (!ui.dash.openAlerts.length) document.title = 'Safety Dashboard';
    ui.firstLoad = false;
    if (ui.tab === 'live') {
      // Don't wipe a note someone is typing.
      const a = document.activeElement;
      const typing = a && a.tagName === 'INPUT' && a.closest('.ack') && a.value;
      if (!typing) renderLive();
    }
  } catch (ex) {
    if (ex.status === 401 || ex.status === 403) { setToken(null); clearInterval(ui.pollTimer); renderAuth(); }
    else toast(ex.message, 'bad');
  }
}

// ------------------------------------------------------------------- people

async function loadUsers() {
  const r = await api('GET', '/api/users');
  ui.users = r.users;
}

async function renderPeople() {
  await loadUsers();
  const err = h('p', { class: 'error', role: 'alert' });
  const roleSel = h('select', { name: 'role' }, h('option', { value: 'worker' }, 'Engineer (uses the app on site)'), h('option', { value: 'manager' }, 'Office / manager (uses this dashboard)'));
  const secretLabel = h('span', {}, 'PIN (4 to 8 digits)');
  roleSel.addEventListener('change', () => { secretLabel.textContent = roleSel.value === 'worker' ? 'PIN (4 to 8 digits)' : 'Password (8+ characters)'; });
  const form = h('form', { class: 'card grid-form' },
    h('h3', { class: 'full' }, 'Add a person'),
    h('label', {}, 'Name', h('input', { name: 'name', required: true })),
    h('label', {}, 'Username', h('input', { name: 'username', required: true, autocapitalize: 'none' })),
    h('label', {}, 'Phone to call them on (optional)', h('input', { name: 'phone', type: 'tel', placeholder: 'Used by the office in an emergency' })),
    h('label', {}, 'Type', roleSel),
    h('label', {}, secretLabel, h('input', { name: 'secret', type: 'password', required: true, autocomplete: 'new-password' })),
    h('div', { class: 'full' }, err, h('button', { class: 'btn primary', type: 'submit' }, 'Add')),
  );
  form.addEventListener('submit', async (e) => {
    e.preventDefault();
    err.textContent = '';
    try {
      await api('POST', '/api/users', Object.fromEntries(new FormData(form)));
      toast('Added. Give them their username and PIN/password.', 'good');
      renderPeople();
    } catch (ex) { err.textContent = ex.message; }
  });

  const list = ui.users.filter((u) => u.active).map((u) => h('tr', {},
    h('td', {}, h('strong', {}, u.name), u.id === ui.me.id ? h('span', { class: 'muted' }, ' (you)') : null),
    h('td', {}, u.username),
    h('td', {}, u.role === 'worker' ? 'Engineer' : 'Office / manager'),
    h('td', {}, u.phone || h('span', { class: 'muted' }, '-')),
    h('td', {}, u.role === 'worker' ? h('span', { class: 'muted' }, '-') : u.alertDevices ? `On (${u.alertDevices} device${u.alertDevices > 1 ? 's' : ''})` : h('span', { class: 'warn-text' }, 'Not turned on')),
    h('td', { class: 'actions' },
      h('button', { class: 'btn small', type: 'button', onclick: () => resetSecret(u) }, u.role === 'worker' ? 'New PIN' : 'New password'),
      h('button', { class: 'btn small', type: 'button', onclick: () => exportUser(u) }, 'Download data'),
      u.id !== ui.me.id ? h('button', { class: 'btn small danger', type: 'button', onclick: (e) => removeUser(u, e.currentTarget) }, 'Remove') : null,
    ),
  ));
  const former = ui.users.filter((u) => !u.active).map((u) => h('li', {},
    `${u.name} (${u.username}) `,
    h('button', { class: 'btn small', type: 'button', onclick: () => exportUser(u) }, 'Download data'),
    h('button', { class: 'btn small danger', type: 'button', onclick: (e) => eraseUser(u, e.currentTarget) }, 'Erase all their data'),
  ));

  setScreen(
    h('h2', {}, 'Engineers & staff'),
    form,
    h('div', { class: 'table-wrap' }, h('table', {},
      h('thead', {}, h('tr', {}, ['Name', 'Username', 'Type', 'Phone', 'Phone alerts', ''].map((t) => h('th', {}, t)))),
      h('tbody', {}, list),
    )),
    former.length ? h('section', {}, h('h3', {}, 'Former staff'), h('p', { class: 'muted small' }, 'Under GDPR, delete their data once you no longer need it.'), h('ul', { class: 'plain-list' }, former)) : null,
  );
}

function twoTap(btn, label, fn) {
  if (btn.dataset.armed) return fn();
  btn.dataset.armed = '1';
  const old = btn.textContent;
  btn.textContent = label;
  setTimeout(() => { delete btn.dataset.armed; btn.textContent = old; }, 4000);
}

async function resetSecret(u) {
  const isWorker = u.role === 'worker';
  const secret = window.prompt(isWorker ? `New PIN for ${u.name} (4 to 8 digits)` : `New password for ${u.name} (8+ characters)`);
  if (!secret) return;
  try {
    await api('POST', `/api/users/${u.id}/secret`, { secret });
    toast('Updated. They will need to sign in again.', 'good');
  } catch (ex) { toast(ex.message, 'bad'); }
}

function removeUser(u, btn) {
  twoTap(btn, 'Tap again to remove', async () => {
    try { await api('POST', `/api/users/${u.id}/deactivate`); toast(`${u.name} removed.`, 'good'); renderPeople(); } catch (ex) { toast(ex.message, 'bad'); }
  });
}

function eraseUser(u, btn) {
  twoTap(btn, 'Tap again: this cannot be undone', async () => {
    try { await api('POST', `/api/users/${u.id}/erase`); toast('Data erased.', 'good'); renderPeople(); } catch (ex) { toast(ex.message, 'bad'); }
  });
}

async function exportUser(u) {
  try {
    const data = await api('GET', `/api/users/${u.id}/export`);
    const blob = new Blob([JSON.stringify(data, null, 2)], { type: 'application/json' });
    const a = h('a', { href: URL.createObjectURL(blob), download: `${u.username}-data.json` });
    document.body.append(a);
    a.click();
    a.remove();
  } catch (ex) { toast(ex.message, 'bad'); }
}

// ----------------------------------------------------------------- contacts

async function renderContacts() {
  const { contacts } = await api('GET', '/api/contacts');
  const err = h('p', { class: 'error', role: 'alert' });
  const form = h('form', { class: 'card grid-form' },
    h('h3', { class: 'full' }, 'Add someone to alert'),
    h('label', {}, 'Name', h('input', { name: 'name', required: true })),
    h('label', {}, 'Mobile number', h('input', { name: 'phone', type: 'tel' })),
    h('label', {}, 'Email', h('input', { name: 'email', type: 'email' })),
    h('label', {}, 'Group', h('select', { name: 'group' }, h('option', { value: 'on-call' }, 'On-call'), h('option', { value: 'office' }, 'Office'))),
    h('div', { class: 'full' }, err, h('button', { class: 'btn primary', type: 'submit' }, 'Add')),
  );
  form.addEventListener('submit', async (e) => {
    e.preventDefault();
    err.textContent = '';
    try { await api('POST', '/api/contacts', Object.fromEntries(new FormData(form))); renderContacts(); } catch (ex) { err.textContent = ex.message; }
  });
  setScreen(
    h('h2', {}, 'Office & on-call contacts'),
    h('p', {}, h('strong', {}, 'Best option: phone notifications (free). '), 'Give each office and on-call person their own login on the Engineers & staff tab (type "Office / manager"). They sign in to the dashboard on their phone and tap "Turn on alerts". They are then notified straight away of missed check-ins and SOS.'),
    h('p', { class: 'banner warn' }, 'Text messages are not switched on yet. People added below (without a login) will only get alerts once a text message service is connected. Until then, what would have been sent is listed under History \u2192 Messages.'),
    form,
    contacts.length
      ? h('div', { class: 'table-wrap' }, h('table', {},
          h('thead', {}, h('tr', {}, ['Name', 'Group', 'Mobile', 'Email', ''].map((t) => h('th', {}, t)))),
          h('tbody', {}, contacts.map((c) => h('tr', {},
            h('td', {}, c.name), h('td', {}, c.group || 'on-call'), h('td', {}, c.phone || '-'), h('td', {}, c.email || '-'),
            h('td', {}, h('button', { class: 'btn small danger', type: 'button', onclick: async () => { await api('DELETE', `/api/contacts/${c.id}`); renderContacts(); } }, 'Remove')),
          ))),
        ))
      : h('p', { class: 'muted' }, 'No contacts added yet.'),
  );
}

// ---------------------------------------------------------------- wellbeing

const MOOD_TEXT = { 1: 'Very low', 2: 'Low', 3: 'OK', 4: 'Good', 5: 'Great' };
const ENERGY_TEXT = { 1: 'Exhausted', 2: 'Very tired', 3: 'A bit tired', 4: 'Fine', 5: 'Full of energy' };

// Matches the wellbeing response procedure document.
const LEVEL_INFO = {
  amber: { label: 'Amber: same day', steps: ['Line manager phones them today (cover: wellbeing lead). If they are due to start work or drive sooner, call before that.', 'Listen first. Ask what is making things hard, at work and outside it, and agree one next step.', 'If you have any worry about their safety, ask directly whether they are thinking of harming themselves.'] },
  yellow: { label: 'Yellow: next working day', steps: ['Line manager speaks to them within 1 working day, by phone or in person.', 'Ask what is behind it, using the HSE headings: workload, control, support, relationships, role, change. Agree any practical change.', 'Check back in 1 to 2 weeks.'] },
  green: { label: 'Green: read and note', steps: ['No call needed unless the comment asks for something. Read it and reply if useful.'] },
};
const FATIGUE_STEPS = {
  'stand-down': 'Fatigue stand-down check: speak to them before their next shift or work drive. If they have had under 5 hours\u2019 sleep in 24, don\u2019t feel safe, or you are not sure, stand them down from lone working and driving until rested, on full pay.',
  check: 'Fatigue check: ask about sleep and whether they feel safe to drive and work alone. Reduce risk this week: fewer or nearer jobs, no extra hours or call-outs, regular breaks.',
};
const URGENT_TEXT = 'If anything suggests a risk of harm, act now: call them; 999 if they are in danger; otherwise help them contact Samaritans (116 123), Shout (text 85258) or NHS 111. Tell the wellbeing lead.';

function wellbeingGuidance(e) {
  const info = LEVEL_INFO[e.level] || LEVEL_INFO.yellow;
  // The direct safety question is for low mood, not tiredness alone.
  const steps = info.steps.filter((t) => e.mood <= 2 || !t.startsWith('If you have any worry'));
  if (e.fatigue && FATIGUE_STEPS[e.fatigue]) steps.splice(1, 0, FATIGUE_STEPS[e.fatigue]);
  if (e.wantsChat) steps.push('They asked for a chat: ask who they would like to talk to and when. Only mark as followed up once the chat has happened.');
  return h('details', { class: 'wb-guide', open: true },
    h('summary', {}, 'What to do'),
    h('ul', {}, steps.map((t) => h('li', {}, t))),
    e.comment ? h('p', { class: 'wb-urgent' }, URGENT_TEXT) : null,
    h('p', { class: 'muted small' }, 'Note when you spoke, what was agreed and the next contact. No medical details.'),
  );
}

function scoreCell(v, labels) {
  return h('span', { class: v <= 2 ? 'warn-text' : '' }, labels[v] || '-');
}

function thisWeekCell(p) {
  if (p.thisWeek === 'due' || (p.thisWeek === undefined && p.overdue)) return h('span', { class: 'muted' }, 'Due');
  if (p.thisWeek === 'skipped') {
    const txt = p.skipStreak > 1 ? `Skipped (${p.skipStreak} in a row)` : 'Skipped';
    return h('span', { class: p.skipStreak >= 3 ? 'warn-text' : 'muted' }, txt);
  }
  return 'Answered';
}

async function renderWellbeing() {
  const d = await api('GET', '/api/wellbeing');
  if (!d.enabled) {
    return setScreen(h('h2', {}, 'Wellbeing'), h('p', {}, 'Weekly wellbeing check-ins are switched off. You can switch them on in Settings.'));
  }
  const follow = d.needsFollowUp.length
    ? h('section', { class: 'stack' }, d.needsFollowUp.map((e) => {
        const input = h('input', { placeholder: 'What did you do? e.g. Had a chat, all OK', maxlength: 500 });
        const form = h('form', { class: 'ack' }, input, h('button', { class: 'btn primary', type: 'submit' }, 'Mark as followed up'));
        form.addEventListener('submit', async (ev) => {
          ev.preventDefault();
          try { await api('POST', `/api/wellbeing/${e.id}/followup`, { note: input.value }); toast('Saved.', 'good'); renderWellbeing(); } catch (ex) { toast(ex.message, 'bad'); }
        });
        const phone = (ui.users || []).find((u) => u.id === e.userId)?.phone;
        const low = e.mood <= 2 || e.energy <= 2;
        const what = e.wantsChat ? ' would like a chat' : low ? ' may need some support' : ' left a comment';
        const level = LEVEL_INFO[e.level] ? e.level : 'yellow';
        return h('article', { class: 'wb-card wb-level-' + level },
          h('div', { class: 'alert-head' }, h('strong', {}, e.workerName + what), h('span', { class: 'muted' }, fmtDateTime(e.at))),
          h('p', {}, h('span', { class: 'wb-badge wb-badge-' + level }, LEVEL_INFO[level].label)),
          h('p', {}, 'Feeling: ', scoreCell(e.mood, MOOD_TEXT), ' \u00b7 Tiredness: ', scoreCell(e.energy, ENERGY_TEXT)),
          (e.reasons || []).length ? h('p', { class: 'muted small' }, e.reasons.join(' \u00b7 ')) : null,
          e.comment ? h('p', {}, '\u201c' + e.comment + '\u201d') : null,
          phone ? h('p', {}, 'Call: ', h('a', { href: 'tel:' + phone }, phone)) : null,
          wellbeingGuidance(e),
          form,
        );
      }))
    : h('p', { class: 'allclear' }, 'Nobody needs a follow-up right now.');

  const rows = d.people.map((p) => h('tr', {},
    h('td', {}, h('strong', {}, p.name)),
    h('td', {}, p.latest ? fmtDateTime(p.latest.at) : h('span', { class: 'muted' }, 'Never')),
    h('td', {}, p.latest ? scoreCell(p.latest.mood, MOOD_TEXT) : '-'),
    h('td', {}, p.latest ? scoreCell(p.latest.energy, ENERGY_TEXT) : '-'),
    h('td', {}, p.recent.length
      ? h('span', { class: 'wb-dots', title: 'Feeling over recent weeks, oldest first' }, p.recent.map((r) => h('span', { class: 'wb-dot wb-' + r.mood, title: `${fmtDateTime(r.at)}: ${MOOD_TEXT[r.mood]}` })))
      : h('span', { class: 'muted' }, '-')),
    h('td', {}, thisWeekCell(p)),
  ));

  const quiet = d.people.filter((p) => p.skipStreak >= 3 || (p.daysSinceAnswer !== null && p.daysSinceAnswer > 14 && p.skipStreak >= 2));
  const skipNote = quiet.length
    ? h('div', { class: 'wb-card wb-level-yellow' },
        h('strong', {}, 'Skipping the check-in'),
        h('p', {}, quiet.map((p) => `${p.name} (${p.skipStreak} weeks in a row)`).join(', ')),
        h('p', { class: 'small' }, 'Skipping is allowed and is never a disciplinary matter. Line manager: make a light, general check-in within the week, without mentioning the app ("Just checking in, how are things?"). If the skipping started after a low answer or a change at work, treat it as Yellow. If most of the team skips, ask the team why.'))
    : null;

  setScreen(
    h('h2', {}, 'Needs a follow-up'),
    follow,
    h('h2', {}, 'Engineers'),
    skipNote,
    h('div', { class: 'table-wrap' }, h('table', {},
      h('thead', {}, h('tr', {}, ['Engineer', 'Last check-in', 'Feeling', 'Tiredness', 'Recent weeks', 'This week'].map((t) => h('th', {}, t)))),
      h('tbody', {}, rows),
    )),
    h('p', { class: 'muted small' }, 'Engineers are asked once a week, on the app\u2019s start screen. Answering is optional. Answers are health information: only share them with people who need to know. They are deleted automatically (see Settings).'),
  );
}

// ------------------------------------------------------------------ history

const EVENT_TEXT = {
  start: 'Started shift', checkin: 'Checked in', location: 'Location update', sos: 'SOS pressed',
  missed: 'Missed check-in', escalated: 'Alert escalated', end: 'Ended shift', ack: 'Alert dealt with',
};

async function renderHistory() {
  const d = await api('GET', '/api/dashboard');
  const events = d.recentEvents.filter((e) => e.type !== 'location');
  setScreen(
    h('h2', {}, 'Recent activity'),
    h('div', { class: 'table-wrap' }, h('table', {},
      h('thead', {}, h('tr', {}, ['When', 'Engineer', 'What', 'Details'].map((t) => h('th', {}, t)))),
      h('tbody', {}, events.map((e) => h('tr', { class: ['sos', 'missed', 'escalated'].includes(e.type) ? 'row-overdue' : '' },
        h('td', {}, fmtDateTime(e.at)), h('td', {}, e.workerName), h('td', {}, EVENT_TEXT[e.type] || e.type),
        h('td', {}, e.note || '', e.location ? h('span', {}, ' ', h('a', { href: mapUrl(e.location), target: '_blank', rel: 'noopener' }, 'map')) : ''),
      ))),
    )),
    h('h2', {}, 'Alerts sent'),
    d.notifications.length
      ? h('div', { class: 'table-wrap' }, h('table', {},
          h('thead', {}, h('tr', {}, ['When', 'To', 'How', 'Subject', 'Message', 'Result'].map((t) => h('th', {}, t)))),
          h('tbody', {}, d.notifications.map((n) => h('tr', {}, h('td', {}, fmtDateTime(n.at)), h('td', {}, n.to), h('td', {}, { push: 'Phone alert', sms: 'Text', dashboard: 'Dashboard only' }[n.channel] || n.channel), h('td', {}, n.subject), h('td', { class: 'small' }, n.body), h('td', { class: 'small' }, n.status || '')))),
        ))
      : h('p', { class: 'muted' }, 'No messages yet.'),
  );
}

// ----------------------------------------------------------------- settings

async function renderSettings() {
  const { settings: s } = await api('GET', '/api/settings');
  const msg = h('p', { role: 'status' });
  const intervals = [15, 30, 45, 60, 90, 120, 180, 240];
  const form = h('form', { class: 'card grid-form' },
    h('label', { class: 'full' }, 'Company name', h('input', { name: 'orgName', value: s.orgName })),
    h('label', {}, 'Default check-in interval', h('select', { name: 'defaultIntervalMin' }, intervals.map((m) => h('option', { value: m, selected: m === s.defaultIntervalMin }, `${m} minutes`)))),
    h('label', {}, 'Grace period after a missed check-in (minutes)', h('input', { name: 'graceMin', type: 'number', min: 1, max: 60, value: s.graceMin })),
    h('label', {}, 'Escalate again if not dealt with after (minutes)', h('input', { name: 'escalateAfterMin', type: 'number', min: 1, max: 120, value: s.escalateAfterMin })),
    h('label', {}, 'Delete location history after (days)', h('input', { name: 'retentionDays', type: 'number', min: 1, max: 365, value: s.retentionDays })),
    h('label', { class: 'check' }, h('input', { type: 'checkbox', name: 'wellbeingEnabled', checked: s.wellbeingEnabled }), 'Ask engineers a weekly wellbeing check'),
    h('label', {}, 'Delete wellbeing answers after (days)', h('input', { name: 'wellbeingRetentionDays', type: 'number', min: 7, max: 365, value: s.wellbeingRetentionDays })),
    h('div', { class: 'full' }, msg, h('button', { class: 'btn primary', type: 'submit' }, 'Save')),
  );
  form.addEventListener('submit', async (e) => {
    e.preventDefault();
    try {
      const r = await api('PUT', '/api/settings', { ...Object.fromEntries(new FormData(form)), wellbeingEnabled: form.elements.wellbeingEnabled.checked });
      document.getElementById('org').textContent = r.settings.orgName;
      toast('Saved.', 'good');
    } catch (ex) { msg.textContent = ex.message; }
  });
  setScreen(h('h2', {}, 'Settings'), form);
}

// --------------------------------------------------------------------- tabs

const RENDER = { live: renderLive, people: renderPeople, contacts: renderContacts, wellbeing: renderWellbeing, history: renderHistory, settings: renderSettings };

tabsEl.addEventListener('click', async (e) => {
  const b = e.target.closest('button[data-tab]');
  if (!b) return;
  ui.tab = b.dataset.tab;
  tabsEl.querySelectorAll('button').forEach((x) => x.classList.toggle('active', x === b));
  try { await RENDER[ui.tab](); } catch (ex) { toast(ex.message, 'bad'); }
});

document.getElementById('signout').addEventListener('click', async () => {
  await api('POST', '/api/logout').catch(() => {});
  setToken(null);
  clearInterval(ui.pollTimer);
  renderAuth();
});

async function start() {
  const r = await api('GET', '/api/me');
  if (r.user.role !== 'manager') { location.href = '/'; return; }
  ui.me = r.user;
  document.getElementById('org').textContent = r.orgName;
  tabsEl.classList.remove('hidden');
  document.getElementById('signout').classList.remove('hidden');
  await loadUsers().catch(() => {});
  refreshPushCard();
  await poll();
  clearInterval(ui.pollTimer);
  ui.pollTimer = setInterval(poll, 5000);
}

(async function boot() {
  if (!getToken()) return renderAuth();
  try { await start(); } catch { setToken(null); renderAuth(); }
})();
