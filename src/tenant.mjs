export const accountPattern = /^[a-f0-9]{32}$/;

export function tenantPath(pathname) {
  const match = pathname.match(/^\/u\/([a-f0-9]{32})(?:\/(.*))?$/);
  if (match?.[2]?.split('/').some(segment => segment === '.' || segment === '..')) return null;
  return match ? {id: match[1], path: '/' + (match[2] || '')} : null;
}

export function tenantBase(request, id) {
  if (!accountPattern.test(id)) throw new Error('Invalid account.');
  return new URL(request.url).origin + '/u/' + id;
}

export function tenantWellKnown(pathname) {
  const match = pathname.match(/^\/\.well-known\/(oauth-authorization-server|oauth-protected-resource)\/u\/([a-f0-9]{32})(?:\/mcp)?$/);
  if (!match) return null;
  if (match[1] === 'oauth-protected-resource' && !pathname.endsWith('/mcp')) return null;
  if (match[1] === 'oauth-authorization-server' && pathname.endsWith('/mcp')) return null;
  return {kind: match[1], id: match[2]};
}
