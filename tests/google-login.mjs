import assert from 'node:assert/strict';
export async function googleLogin(origin, {email, verified} = {}) {
  const start = await fetch(origin + '/api/auth/google/start', {redirect: 'manual'});
  assert.equal(start.status, 302, await start.clone().text());
  const binding = start.headers.getSetCookie().map(item => item.split(';')[0]).join('; '), target = new URL(start.headers.get('location'));
  if (email) target.searchParams.set('fixture_email', email);
  if (verified === false) target.searchParams.set('fixture_verified', 'false');
  const grant = await fetch(target, {redirect: 'manual'});
  const callback = grant.headers.get('location');
  const finish = await fetch(callback, {redirect: 'manual', headers: {Cookie: binding}});
  const session = finish.headers.getSetCookie().find(item => item.startsWith('__Host-agentgate-session='));
  if (!session) return {denied: finish.headers.get('location'), callback, binding};
  const cookie = session.split(';')[0];
  const identity = await (await fetch(origin + '/api/admin/session', {headers: {Cookie: cookie}})).json();
  return {cookie, csrf: identity.csrf_token, subject: identity.admin_subject, email: identity.email, callback, binding};
}
export async function installGoogleSession(context, origin, login) {
  const split = login.cookie.indexOf('=');
  await context.addCookies([{name: login.cookie.slice(0, split), value: login.cookie.slice(split + 1), url: origin.replace('http:', 'https:') + '/', httpOnly: true, secure: true, sameSite: 'Lax'}]);
}
