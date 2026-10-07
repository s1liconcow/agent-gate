const invite = document.getElementById('invite');
const message = document.getElementById('message');
const join = document.getElementById('join');
invite.value = new URLSearchParams(location.hash.slice(1)).get('invite') || '';
if (location.hash) history.replaceState(null, '', '/join.html');
join.addEventListener('click', async () => {
  join.disabled = true;
  try {
    const response = await fetch('/api/signup', {method: 'POST', headers: {'Content-Type': 'application/json'}, body: JSON.stringify({invite: invite.value.trim()}), cache: 'no-store', redirect: 'error'});
    const result = await response.json();
    if (!response.ok || !/^[a-f0-9]{32}$/.test(result.account_id || '') || !/^[A-Za-z0-9_-]{43}$/.test(result.pairing_token || '') || result.account_url !== location.origin + '/u/' + result.account_id) throw new Error(result.error || 'Unable to create your space.');
    invite.value = '';
    location.assign(result.account_url + '/try.html#invite=' + encodeURIComponent(result.pairing_token));
  } catch (error) { message.hidden = false; message.textContent = error.message; message.classList.add('error'); join.disabled = false; }
});
