self.addEventListener('install', () => self.skipWaiting());
self.addEventListener('activate', event => event.waitUntil(self.clients.claim()));
self.addEventListener('push', event => {
  // Never show server-supplied task descriptions, financial details or recipients on a lock screen.
  event.waitUntil(self.registration.showNotification('AgentGate approval requested', {body: 'Open AgentGate to review a browser task.', icon: '/icon-192.png', badge: '/icon-192.png', tag: 'agentgate-approval', data: {url: '/'}}));
});
self.addEventListener('notificationclick', event => { event.notification.close(); event.waitUntil(self.clients.matchAll({type: 'window'}).then(async clients => { if (clients.length) { await clients[0].focus(); return; } await self.clients.openWindow('/'); })); });
