import {existingOwnerSession, pageAccount, accountBase} from './owner-session.mjs';
const $ = id => document.getElementById(id), account = pageAccount(location.pathname);
$('home').href = accountBase(account) + '/'; $('profileLink').href = accountBase(account) + '/account.html';
const el = (tag, text, className) => { const node = document.createElement(tag); if (text !== undefined) node.textContent = String(text); if (className) node.className = className; return node; };
const date = value => Number.isSafeInteger(value) ? new Date(value).toLocaleString() : 'No activity recorded';
let api, data, loading = false, cursors = [null], page = 0, capacity;
function browserDetails(items) {
  const details = el('details'), list = el('ul'); details.append(el('summary', 'View browsers'));
  for (const item of items) { const row = el('li', item.name); row.append(el('span', item.id), el('span', item.kind === 'cloud' ? 'Cloud · ' + (item.authorized ? 'Enabled' : item.status) : (item.connected ? 'Online' : item.authorized ? 'Offline' : item.status))); list.append(row); }
  details.append(list); return details;
}
function renderAccounts() {
  const query = $('search').value.trim().toLowerCase();
  const items = data.accounts.filter(item => [item.name, item.email, item.account_id].some(value => value?.toLowerCase().includes(query)));
  $('accounts').replaceChildren(...items.map(item => {
    const row = el('tr'), identity = el('td'); identity.append(el('strong', item.name));
    if (item.email) identity.append(el('p', item.email), el('p', 'Owner-entered · unverified', 'hint'));
    const link = el('a', 'Open account'); link.href = item.account_id === 'owner' ? '/' : '/u/' + item.account_id + '/';
    identity.append(el('code', item.account_id), link); row.append(identity);
    if (item.unavailable) { const unavailable = el('td', 'Account details unavailable. Refresh to retry.'); unavailable.colSpan = 4; row.append(unavailable); return row; }
    const local = item.browsers.filter(browser => browser.kind === 'local'), online = local.filter(browser => browser.connected).length;
    const localCell = el('td'); localCell.append(el('span', online + ' online / ' + local.length + ' paired', 'admin-state ' + (online ? 'online' : '')));
    if (item.browsers.length) localCell.append(browserDetails(item.browsers));
    const cloudCell = el('td'); cloudCell.append(el('span', item.cloud.enabled ? 'Enabled' : 'Disabled', 'admin-state ' + (item.cloud.enabled ? 'online' : '')),
      el('p', item.cloud.metadata_unavailable ? 'Metadata unavailable' : item.cloud.connection_recorded ? 'Connection recorded' : 'No saved connection'), el('p', date(item.cloud.last_activity_at), 'hint'));
    if (item.cloud.cooldown_until) cloudCell.append(el('p', 'Waiting until ' + date(item.cloud.cooldown_until), 'admin-state waiting'));
    const usage = el('td'); usage.append(el('span', item.usage.cloud_tasks_24h + ' cloud tasks'), el('p', item.usage.cloud_actions_24h + ' action results'), el('p', item.usage.running_cloud + ' cloud tasks open', 'hint'));
    if (item.usage.coverage === 'bounded_sample') usage.append(el('p', 'Counts cover up to 2,000 stored tasks.', 'hint'));
    const assistants = el('td'); assistants.append(el('span', item.connectors.filter(c => c.status === 'connected').length + ' connected'));
    if (item.connectors.length) { const details = el('details'), list = el('ul'); details.append(el('summary', 'View assistants')); for (const c of item.connectors) {const li = el('li', c.client_name); li.append(el('span', c.status), el('span', c.id)); list.append(li);} details.append(list); assistants.append(details); }
    for (const [cell, label] of [[localCell, 'Local browsers'], [cloudCell, 'Cloud browser'], [usage, 'Last 24 hours'], [assistants, 'Assistants']]) cell.dataset.label = label;
    row.append(localCell, cloudCell, usage, assistants); return row;
  }));
  $('empty').hidden = items.length > 0;
}
async function refresh(reset = false) {
  if (loading) return; if (reset) {cursors = [null]; page = 0;}
  loading = true; $('refresh').disabled = $('next').disabled = $('previous').disabled = true;
  try {
    api ||= await existingOwnerSession(indexedDB, account);
    const response = await api('admin/accounts' + (cursors[page] ? '?cursor=' + encodeURIComponent(cursors[page]) : ''));
    if (response.admin_account_id !== account) throw new Error('Admin authorization did not match this account.');
    data = response; if (!cursors[page]) capacity = data.cloud_capacity;
    $('total').textContent = data.total_accounts;
    $('online').textContent = data.accounts.reduce((n, item) => n + (item.browsers || []).filter(b => b.connected).length, 0);
    $('running').textContent = data.accounts.reduce((n, item) => n + (item.usage?.running_cloud || 0), 0);
    const limits = capacity?.limits?.limits;
    $('capacity').textContent = limits ? (limits.active_sessions ?? 'Unknown') + ' active browser sessions · ' + (limits.max_concurrent_sessions ?? 'Unknown') + ' concurrent limit · ' + (limits.allowed_browser_acquisitions ?? 'Unknown') + ' new browsers currently allowed' : 'Cloudflare capacity unavailable.';
    const history = capacity?.history?.summary;
    $('history').textContent = history ? Math.round(history.browser_lifetime_today_ms / 60000) + ' browser minutes today (UTC), across ' + history.sample_sessions + ' sessions in the provider’s recent sample.' : 'No provider history available.';
    $('updated').textContent = 'Updated ' + date(data.observed_at); $('pageLabel').textContent = 'Page ' + (page + 1);
    $('dashboard').hidden = false; $('status').textContent = ''; renderAccounts();
  } catch (error) { $('dashboard').hidden = true; $('status').textContent = error.message; }
  finally {loading = false; $('refresh').disabled = false; $('next').disabled = !data?.next_cursor; $('previous').disabled = page === 0;}
}
$('search').addEventListener('input', () => {if (data) renderAccounts();});
$('refresh').addEventListener('click', () => refresh(true));
$('next').addEventListener('click', () => {if (!loading && data?.next_cursor) {cursors[++page] = data.next_cursor; refresh();}});
$('previous').addEventListener('click', () => {if (!loading && page) {page--; refresh();}});
await refresh();
