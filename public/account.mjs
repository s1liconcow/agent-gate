import {existingOwnerSession, pageAccount, accountBase} from './owner-session.mjs';
const $ = id => document.getElementById(id), account = pageAccount(location.pathname);
$('home').href = accountBase(account) + '/'; $('admin').href = '/admin.html';
let api;
function show(profile) {
  if (profile.account_id !== account) throw new Error('Account authorization did not match this page.');
  $('name').value = profile.name; $('email').value = profile.email || ''; $('accountId').textContent = profile.account_id;
  $('admin').hidden = !profile.admin; $('profile').hidden = false;
}
try { api = await existingOwnerSession(indexedDB, account); show(await api('profile')); $('status').textContent = ''; }
catch (error) { $('status').textContent = error.message; }
$('profile').addEventListener('submit', async event => {
  event.preventDefault(); $('save').disabled = true;
  try { show(await api('profile', {name: $('name').value, email: $('email').value})); $('status').textContent = 'Account details saved.'; }
  catch (error) { $('status').textContent = error.message; }
  finally { $('save').disabled = false; }
});
