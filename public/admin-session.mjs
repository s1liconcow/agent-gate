export async function existingAdminSession() {
  let csrf;
  const api = async (path, value) => {
    const response = await fetch('/api/' + path, {method: value === undefined ? 'GET' : 'POST', credentials: 'same-origin',
      headers: value === undefined ? {} : {'Content-Type': 'application/json', 'X-AgentGate-CSRF': csrf},
      ...(value === undefined ? {} : {body: JSON.stringify(value)}), cache: 'no-store', redirect: 'error', signal: AbortSignal.timeout(20000)});
    const result = await response.json();
    if (!response.ok) throw Object.assign(new Error(result.error?.message || 'Could not load administration. Use Refresh to try again.'), {status: response.status, code: result.error?.code});
    return result;
  };
  const session = await api('admin/session');
  csrf = session.csrf_token;
  return {subject: session.admin_subject, email: session.email, api};
}

export async function allAdminAccounts(api, account) {
  let data, cursor = null;
  const accounts = new Map(), seen = new Set();
  do {
    const page = await api('admin/accounts' + (cursor ? '?cursor=' + encodeURIComponent(cursor) : ''));
    if (page.admin_subject !== account) throw new Error('Admin authorization did not match this account.');
    data ||= page;
    for (const item of page.accounts) accounts.set(item.account_id, item);
    cursor = page.next_cursor;
    if (cursor && seen.has(cursor)) throw new Error('Could not load every account. Use Refresh to try again.');
    seen.add(cursor);
  } while (cursor);
  return {...data, accounts: [...accounts.values()], total_accounts: accounts.size, next_cursor: null};
}
