import {existingAdminSession, allAdminAccounts} from './admin-session.mjs';
import {InvitePanel} from './admin-invites.mjs';
const $ = id => document.getElementById(id);
const el = (tag, text, className) => { const node = document.createElement(tag); if (text !== undefined) node.textContent = String(text); if (className) node.className = className; return node; };
const date = value => Number.isSafeInteger(value) ? new Date(value).toLocaleString() : 'No activity recorded';
let session, data, loading = false, invitePanel;
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
  $('accountCount').textContent = items.length + ' of ' + data.total_accounts + ' accounts';
}
async function refresh() {
  if (loading) return;
  loading = true; $('refresh').disabled = true;
  $('status').textContent = 'Loading all AgentGate accounts…';
  try {
    session ||= await existingAdminSession();
    data = await allAdminAccounts(session.api, session.subject);
    $('adminEmail').textContent = session.email; $('signedIn').hidden = false; $('signIn').hidden = true;
    $('total').textContent = data.total_accounts;
    $('online').textContent = data.accounts.reduce((n, item) => n + (item.browsers || []).filter(b => b.connected).length, 0);
    $('running').textContent = data.accounts.reduce((n, item) => n + (item.usage?.running_cloud || 0), 0);
    const limits = data.cloud_capacity?.limits?.limits;
    $('capacity').textContent = limits ? (limits.active_sessions ?? 'Unknown') + ' active browser sessions · ' + (limits.max_concurrent_sessions ?? 'Unknown') + ' concurrent limit · ' + (limits.allowed_browser_acquisitions ?? 'Unknown') + ' new browsers currently allowed' : 'Cloudflare capacity unavailable.';
    const history = data.cloud_capacity?.history?.summary;
    $('history').textContent = history ? Math.round(history.browser_lifetime_today_ms / 60000) + ' browser minutes today (UTC), across ' + history.sample_sessions + ' sessions in the provider’s recent sample.' : 'No provider history available.';
    $('updated').textContent = 'Updated ' + date(data.observed_at);
    $('dashboard').hidden = false; $('status').textContent = ''; renderAccounts();
    invitePanel ||= new InvitePanel((...args) => session.api(...args)); await invitePanel.refresh();
  } catch (error) {
    if ([401, 403].includes(error.status)) {session = null; $('signIn').hidden = false; $('signedIn').hidden = true;}
    $('dashboard').hidden = true; $('status').textContent = error.status === 401 ? '' : error.message;
  }
  finally {loading = false; $('refresh').disabled = false;}
}
$('search').addEventListener('input', () => {if (data) renderAccounts();});
$('refresh').addEventListener('click', refresh);
$('signOut').addEventListener('click', async () => {
  $('signOut').disabled = true;
  try { await session.api('auth/logout', {}); location.assign('/admin.html'); }
  catch (error) { $('status').textContent = error.message; $('signOut').disabled = false; }
});
const outcome = new URLSearchParams(location.search).get('signin');
if (outcome) history.replaceState(null, '', '/admin.html');
await refresh();
if (outcome && !session) $('status').textContent = {denied: 'This Google account does not have administration access. Sign in with your administrator account.', cancelled: 'Sign-in was cancelled. You can try again.', failed: 'Google sign-in failed or expired. Start again.'}[outcome] || $('status').textContent;
