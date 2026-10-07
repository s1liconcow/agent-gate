self.addEventListener('install', () => self.skipWaiting());
self.addEventListener('activate', event => event.waitUntil(self.clients.claim()));
self.addEventListener('push', event => {
  // Never show server-supplied task descriptions, financial details or recipients on a lock screen.
  let url = '/';
  try { const requested = event.data?.json()?.url; if (requested === '/' || /^\/u\/[a-f0-9]{32}\/$/.test(requested)) url = requested; } catch {}
  event.waitUntil(self.registration.showNotification('AgentGate approval requested', {body: 'Open AgentGate to review a browser task.', icon: '/icon-192.png', badge: '/icon-192.png', tag: 'agentgate-approval', data: {url}}));
});
self.addEventListener('notificationclick', event => { event.notification.close(); event.waitUntil(self.clients.matchAll({type: 'window'}).then(async clients => { const url = event.notification.data?.url || '/', matching = clients.find(client => url === '/' ? new URL(client.url).pathname === '/' : new URL(client.url).pathname.startsWith(url)); if (matching) { await matching.focus(); return; } await self.clients.openWindow(url); })); });
