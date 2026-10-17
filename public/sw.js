/* Service worker: receives the push and shows the "order ready" notification. */

self.addEventListener('install', () => self.skipWaiting());
self.addEventListener('activate', (e) => e.waitUntil(self.clients.claim()));

self.addEventListener('push', (event) => {
  let data = {};
  try { data = event.data ? event.data.json() : {}; } catch { data = { title: 'Your order is ready', body: '' }; }

  const title = data.title || 'Your order is ready';
  const options = {
    body: data.body || 'Please come to the counter.',
    icon: '/icon-192.png',
    badge: '/icon-192.png',
    vibrate: [300, 120, 300, 120, 700],
    tag: 'order-' + (data.orderNumber || 'x'),
    renotify: true,
    requireInteraction: true,
    data: { url: data.url || '/' },
  };

  event.waitUntil(
    self.registration.showNotification(title, options).then(() =>
      // Tell any open pager page so it can flip to the "ready" screen instantly.
      self.clients.matchAll({ type: 'window', includeUncontrolled: true }).then((list) =>
        list.forEach((c) => c.postMessage({ type: 'ready', orderNumber: data.orderNumber }))
      )
    )
  );
});

self.addEventListener('notificationclick', (event) => {
  event.notification.close();
  const url = (event.notification.data && event.notification.data.url) || '/';
  event.waitUntil(
    self.clients.matchAll({ type: 'window', includeUncontrolled: true }).then((list) => {
      for (const c of list) {
        if (c.url.includes(url) && 'focus' in c) return c.focus();
      }
      return self.clients.openWindow(url);
    })
  );
});
