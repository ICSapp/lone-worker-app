// Service worker: lets the app be "installed" on a phone home screen and
// load its screens quickly. Safety data (check-ins, SOS) always goes live to
// the server and is never cached.
const CACHE = 'lws-v2';
const SHELL = ['/', '/index.html', '/manager.html', '/styles.css', '/common.js', '/worker.js', '/manager.js', '/icon.svg', '/manifest.webmanifest', '/manager.webmanifest'];

self.addEventListener('install', (e) => {
  e.waitUntil(caches.open(CACHE).then((c) => c.addAll(SHELL)).then(() => self.skipWaiting()));
});

self.addEventListener('activate', (e) => {
  e.waitUntil(caches.keys().then((keys) => Promise.all(keys.filter((k) => k !== CACHE).map((k) => caches.delete(k)))).then(() => self.clients.claim()));
});

self.addEventListener('fetch', (e) => {
  const url = new URL(e.request.url);
  if (e.request.method !== 'GET' || url.pathname.startsWith('/api/') || url.origin !== location.origin) return;
  // Network first so updates arrive straight away; fall back to cache offline.
  e.respondWith(
    fetch(e.request)
      .then((res) => {
        const copy = res.clone();
        caches.open(CACHE).then((c) => c.put(e.request, copy));
        return res;
      })
      .catch(() => caches.match(e.request).then((r) => r || caches.match('/index.html'))),
  );
});

// Alert sent from the server (missed check-in, SOS, escalation).
self.addEventListener('push', (e) => {
  let data = {};
  try { data = e.data ? e.data.json() : {}; } catch { data = { title: 'Safety alert', body: e.data ? e.data.text() : '' }; }
  e.waitUntil(self.registration.showNotification(data.title || 'Safety alert', {
    body: data.body || 'Open the dashboard.',
    icon: '/icon.svg',
    badge: '/icon.svg',
    tag: data.alertId || 'safety-alert',
    renotify: true,
    requireInteraction: true,
    vibrate: [400, 200, 400, 200, 400],
    data: { url: data.url || '/manager' },
  }));
});

self.addEventListener('notificationclick', (e) => {
  e.notification.close();
  const url = (e.notification.data && e.notification.data.url) || '/';
  e.waitUntil(self.clients.matchAll({ type: 'window', includeUncontrolled: true }).then((list) => {
    const existing = list.find((c) => new URL(c.url).pathname === url) || list[0];
    if (existing) {
      if (new URL(existing.url).pathname !== url && existing.navigate) existing.navigate(url);
      return existing.focus();
    }
    return self.clients.openWindow(url);
  }));
});
