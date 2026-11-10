// Service worker: guarda la "cáscara" de la app, y recibe las notificaciones de llamada.
const CACHE = 'escuchame-v2';
const SHELL = ['/', '/index.html', '/styles.css', '/app.js', '/manifest.json', '/icon.svg', '/icon-192.png', '/icon-512.png', '/legal.html'];

self.addEventListener('install', (e) => {
  e.waitUntil(caches.open(CACHE).then((c) => c.addAll(SHELL)).then(() => self.skipWaiting()));
});
self.addEventListener('activate', (e) => {
  e.waitUntil(caches.keys().then((ks) => Promise.all(ks.filter((k) => k !== CACHE).map((k) => caches.delete(k)))).then(() => self.clients.claim()));
});
self.addEventListener('fetch', (e) => {
  if (e.request.method !== 'GET') return;
  const url = new URL(e.request.url);
  if (url.origin !== location.origin || url.pathname === '/ws' || url.pathname.startsWith('/admin')) return;
  // red primero (para recibir actualizaciones), caché como respaldo sin conexión
  e.respondWith(
    fetch(e.request).then((r) => {
      if (r.ok) { const copy = r.clone(); caches.open(CACHE).then((c) => c.put(e.request, copy)).catch(() => {}); }
      return r;
    }).catch(() => caches.match(e.request).then((m) => m || caches.match('/index.html')))
  );
});

// Llegó una llamada y la app estaba cerrada o en segundo plano
self.addEventListener('push', (e) => {
  let d = {};
  try { d = e.data ? e.data.json() : {}; } catch (_) {}
  e.waitUntil(self.registration.showNotification(d.title || 'Escúchame', {
    body: d.body || 'Alguien necesita ser escuchado/a. Tocá para atender.',
    icon: '/icon-192.png', badge: '/icon-192.png', tag: 'llamada', renotify: true,
    requireInteraction: true, vibrate: [300, 150, 300, 150, 600],
    data: { url: d.url || '/?call=1' },
  }));
});

self.addEventListener('notificationclick', (e) => {
  e.notification.close();
  const url = (e.notification.data && e.notification.data.url) || '/';
  e.waitUntil(self.clients.matchAll({ type: 'window', includeUncontrolled: true }).then((list) => {
    for (const c of list) { if ('focus' in c) return c.focus(); }
    return self.clients.openWindow(url);
  }));
});
