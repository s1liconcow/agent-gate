import {accountBase} from './owner-session.mjs';

const unpaired = 'Open this page in the browser where you approved the administrator’s AgentGate account.';

export async function existingAdminSession(indexedDB) {
  const db = await new Promise((resolve, reject) => {
    const request = indexedDB.open('agentgate-device');
    request.onupgradeneeded = () => request.transaction.abort();
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(new Error(unpaired));
  });
  let devices;
  try {
    if (!db.objectStoreNames.contains('keys')) throw new Error(unpaired);
    devices = await new Promise((resolve, reject) => {
      const items = [], tx = db.transaction('keys', 'readonly'), request = tx.objectStore('keys').openCursor();
      request.onsuccess = () => {
        const cursor = request.result;
        if (!cursor) return;
        if ((cursor.key === 'device' || /^device:[a-f0-9]{32}$/.test(cursor.key)) && typeof cursor.value?.token === 'string' && cursor.value.token) {
          items.push({account: cursor.key === 'device' ? 'owner' : cursor.key.slice(7), token: cursor.value.token});
        }
        cursor.continue();
      };
      tx.oncomplete = () => resolve(items);
      tx.onerror = tx.onabort = () => reject(new Error(unpaired));
    });
  } finally { db.close(); }
  for (const device of devices) {
    const api = async (path, value) => {
      const response = await fetch('/api/' + path, {method: value === undefined ? 'GET' : 'POST',
        headers: {Authorization: 'Bearer ' + device.token, ...(value === undefined ? {} : {'Content-Type': 'application/json'})},
        ...(value === undefined ? {} : {body: JSON.stringify(value)}), cache: 'no-store', redirect: 'error', signal: AbortSignal.timeout(20000)});
      const result = await response.json();
      if (!response.ok) throw Object.assign(new Error(result.error?.message || 'Could not load administration. Use Refresh to try again.'), {status: response.status});
      return result;
    };
    try {
      const session = await api('admin/session');
      if (session.admin_account_id !== device.account) throw new Error('Admin authorization did not match this device.');
      return {account: device.account, account_url: accountBase(device.account) + '/', api};
    } catch (error) { if (error.status !== 403) throw error; }
  }
  throw new Error(unpaired);
}

export async function allAdminAccounts(api, account) {
  let data, cursor = null;
  const accounts = new Map(), seen = new Set();
  do {
    const page = await api('admin/accounts' + (cursor ? '?cursor=' + encodeURIComponent(cursor) : ''));
    if (page.admin_account_id !== account) throw new Error('Admin authorization did not match this account.');
    data ||= page;
    for (const item of page.accounts) accounts.set(item.account_id, item);
    cursor = page.next_cursor;
    if (cursor && seen.has(cursor)) throw new Error('Could not load every account. Use Refresh to try again.');
    seen.add(cursor);
  } while (cursor);
  return {...data, accounts: [...accounts.values()], total_accounts: accounts.size, next_cursor: null};
}
