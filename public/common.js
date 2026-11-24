// Shared helpers for the worker and manager pages.
'use strict';

const TOKEN_KEY = 'lws_token';

function getToken() {
  try { return localStorage.getItem(TOKEN_KEY); } catch { return null; }
}
function setToken(t) {
  try { t ? localStorage.setItem(TOKEN_KEY, t) : localStorage.removeItem(TOKEN_KEY); } catch { /* ignore */ }
}

async function api(method, path, body) {
  const headers = { 'Content-Type': 'application/json' };
  const t = getToken();
  if (t) headers.Authorization = 'Bearer ' + t;
  let res;
  try {
    res = await fetch(path, { method, headers, body: body ? JSON.stringify(body) : undefined });
  } catch {
    const e = new Error('No connection. Check your signal and try again.');
    e.offline = true;
    throw e;
  }
  const data = await res.json().catch(() => ({}));
  if (!res.ok) {
    const e = new Error(data.error || 'Something went wrong.');
    e.status = res.status;
    throw e;
  }
  return data;
}

// Build DOM safely: h('div', {class: 'x', onclick: fn}, 'text', child)
function h(tag, attrs, ...children) {
  const el = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs || {})) {
    if (v === false || v == null) continue;
    if (k.startsWith('on')) el.addEventListener(k.slice(2), v);
    else if (k === 'class') el.className = v;
    else if (k === 'html') throw new Error('no raw html');
    else el.setAttribute(k, v === true ? '' : v);
  }
  for (const c of children.flat()) {
    if (c == null || c === false) continue;
    el.append(c instanceof Node ? c : document.createTextNode(String(c)));
  }
  return el;
}

function fmtTime(isoStr) {
  if (!isoStr) return '-';
  return new Date(isoStr).toLocaleTimeString('en-GB', { hour: '2-digit', minute: '2-digit' });
}
function fmtDateTime(isoStr) {
  if (!isoStr) return '-';
  return new Date(isoStr).toLocaleString('en-GB', { day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' });
}
function fmtCountdown(ms) {
  const neg = ms < 0;
  const s = Math.floor(Math.abs(ms) / 1000);
  const hh = Math.floor(s / 3600);
  const mm = Math.floor((s % 3600) / 60);
  const ss = s % 60;
  const body = (hh ? hh + ':' + String(mm).padStart(2, '0') : mm) + ':' + String(ss).padStart(2, '0');
  return (neg ? '-' : '') + body;
}
function ago(isoStr) {
  if (!isoStr) return 'never';
  const m = Math.round((Date.now() - Date.parse(isoStr)) / 60000);
  if (m < 1) return 'just now';
  if (m < 60) return m + ' min ago';
  const hrs = Math.floor(m / 60);
  return hrs + ' h ' + (m % 60) + ' min ago';
}
function mapUrl(loc) {
  return `https://www.openstreetmap.org/?mlat=${loc.lat}&mlon=${loc.lng}#map=17/${loc.lat}/${loc.lng}`;
}

function toast(msg, kind) {
  let box = document.getElementById('toast');
  if (!box) {
    box = h('div', { id: 'toast', role: 'status', 'aria-live': 'polite' });
    document.body.append(box);
  }
  box.textContent = msg;
  box.className = 'show ' + (kind || '');
  clearTimeout(toast._t);
  toast._t = setTimeout(() => { box.className = ''; }, 4000);
}

if ('serviceWorker' in navigator) {
  window.addEventListener('load', () => navigator.serviceWorker.register('/sw.js').catch(() => {}));
}
