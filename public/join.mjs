const invite = document.getElementById('invite');
const message = document.getElementById('message');
const join = document.getElementById('join');
function readInvite() {
  if (!location.hash) return;
  invite.value = new URLSearchParams(location.hash.slice(1)).get('invite') || '';
  history.replaceState(null, '', '/join.html'); message.hidden = true;
}
readInvite();
window.addEventListener('hashchange', readInvite);
document.getElementById('joinForm').addEventListener('submit', async event => {
  event.preventDefault();
  if (join.disabled) return;
  join.disabled = true;
  join.textContent = 'Creating your space…'; message.hidden = true;
  try {
    const response = await fetch('/api/signup', {method: 'POST', headers: {'Content-Type': 'application/json'}, body: JSON.stringify({invite: invite.value.trim()}), cache: 'no-store', redirect: 'error'});
    const result = await response.json();
    if (!response.ok || !/^[a-f0-9]{32}$/.test(result.account_id || '') || !/^[A-Za-z0-9_-]{43}$/.test(result.pairing_token || '') || result.account_url !== location.origin + '/u/' + result.account_id) throw Object.assign(new Error(result.error || 'Unable to create your space.'), {status: response.status});
    invite.value = '';
    location.assign(result.account_url + '/try.html#invite=' + encodeURIComponent(result.pairing_token));
  } catch (error) {
    const recovery = [403, 410].includes(error.status) ? 'Ask the person who invited you for a new link.' : error.status === 409 ? 'Contact the person who invited you about available space.' : 'Try again when your connection is available.';
    message.hidden = false; message.textContent = error.message + ' ' + recovery; message.classList.add('error'); join.disabled = false; join.textContent = 'Create my space';
  }
});
