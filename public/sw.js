// Push notifications only. No fetch handler and no caching.
self.addEventListener('install', () => self.skipWaiting());
self.addEventListener('activate', (event) => event.waitUntil(self.clients.claim()));

self.addEventListener('push', (event) => {
  event.waitUntil(
    (async () => {
      let roomId = '';
      try {
        roomId = event.data.json().roomId || '';
      } catch {}

      const windows = await self.clients.matchAll({ type: 'window', includeUncontrolled: true });
      const watching = windows.some(
        (c) => c.visibilityState === 'visible' && new URL(c.url).pathname === `/chat/${roomId}`
      );
      // Safari revokes subscriptions that receive a push without showing anything
      const safari = /AppleWebKit/.test(navigator.userAgent) && !/Chrome|Chromium/.test(navigator.userAgent);
      if (watching && !safari) return;

      await self.registration.showNotification('ChatAf', {
        body: 'You got a message',
        tag: `room-${roomId}`,
        renotify: true,
        data: { roomId },
      });
    })()
  );
});

self.addEventListener('notificationclick', (event) => {
  event.notification.close();
  const roomId = event.notification.data?.roomId;
  const path = /^[0-9a-f-]{36}$/i.test(roomId) ? `/chat/${roomId}` : '/rooms';
  event.waitUntil(
    (async () => {
      const windows = await self.clients.matchAll({ type: 'window', includeUncontrolled: true });
      const open = windows.find((c) => new URL(c.url).pathname === path);
      if (open) return open.focus();
      return self.clients.openWindow(path);
    })()
  );
});
