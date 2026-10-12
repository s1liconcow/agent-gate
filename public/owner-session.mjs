const unpaired = 'Open this page in the browser where you approved this AgentGate account.';
export const pageAccount = pathname => pathname.match(/^\/u\/([a-f0-9]{32})\/(?:admin|account)\.html$/)?.[1] || (['/admin.html', '/account.html'].includes(pathname) ? 'owner' : null);
export const accountBase = id => id === 'owner' ? '' : '/u/' + id;

export async function existingOwnerSession(indexedDB, account) {
  if (account !== 'owner' && !/^[a-f0-9]{32}$/.test(account || '')) throw new Error('Invalid account page.');
  const db = await new Promise((resolve, reject) => {
    const request = indexedDB.open('agentgate-device');
    request.onupgradeneeded = () => request.transaction.abort();
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(new Error(unpaired));
  });
  try {
    if (!db.objectStoreNames.contains('keys')) throw new Error(unpaired);
    const device = await new Promise((resolve, reject) => {
      const tx = db.transaction('keys', 'readonly'), request = tx.objectStore('keys').get(account === 'owner' ? 'device' : 'device:' + account);
      tx.oncomplete = () => resolve(request.result);
      tx.onerror = tx.onabort = () => reject(new Error(unpaired));
    });
    if (!device?.token) throw new Error(unpaired);
    return async (path, value) => {
      const response = await fetch(accountBase(account) + '/api/owner/' + path, {method: value === undefined ? 'GET' : 'POST',
        headers: {Authorization: 'Bearer ' + device.token, ...(value === undefined ? {} : {'Content-Type': 'application/json'})},
        ...(value === undefined ? {} : {body: JSON.stringify(value)}), cache: 'no-store', redirect: 'error', signal: AbortSignal.timeout(20000)});
      const result = await response.json();
      if (!response.ok) throw new Error(result.error?.message || 'Could not read account details.');
      return result;
    };
  } finally { db.close(); }
}
