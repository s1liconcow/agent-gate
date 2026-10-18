import {fail} from '../shared/protocol.mjs';

export const ADMIN_EMAIL = 'dchalloner@gmail.com';
export const googleIssuers = ['https://accounts.google.com', 'accounts.google.com'];
export const isAdminIdentity = identity => identity?.provider === 'google' && googleIssuers.includes(identity.issuer) &&
  identity.email_verified === true && typeof identity.email === 'string' && identity.email.toLowerCase() === ADMIN_EMAIL &&
  typeof identity.subject === 'string' && /^[A-Za-z0-9_-]{1,255}$/.test(identity.subject);

export function requireAdmin(identity) {
  if (!isAdminIdentity(identity)) fail('ADMIN_REQUIRED', 'This Google account does not have administration access.', 403);
}
