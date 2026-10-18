import {exact, fail} from '../shared/protocol.mjs';

export const validAccountId = id => id === 'owner' || /^[a-f0-9]{32}$/.test(id || '');

export function accountProfile(input) {
  exact(input, ['name', 'email']);
  if (typeof input.name !== 'string' || typeof input.email !== 'string') fail('INVALID_PROFILE', 'Enter an account name and optional email.');
  const name = input.name.normalize('NFKC').trim(), email = input.email.trim();
  if (name.length > 80 || /[\u0000-\u001f\u007f]/u.test(name) || email.length > 254 || email && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/u.test(email)) fail('INVALID_PROFILE', 'Use a name of up to 80 characters and a valid email.');
  return {name, email, email_verified: false, email_source: email ? 'owner_entered' : null};
}

export async function readAccountProfile(storage, id) {
  const saved = await storage.get('account:profile');
  const profile = accountProfile({name: saved?.name || '', email: saved?.email || ''});
  return {account_id: id, ...profile, name: profile.name || (id === 'owner' ? 'Original owner' : 'Account ' + id.slice(0, 8)), updated_at: saved?.updated_at || null};
}
