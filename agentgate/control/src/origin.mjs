const defaultOrigin = 'https://agentgate-control.dchalloner.workers.dev';

export function publicOrigin(request, env = {}) {
  const incoming = new URL(request.url);
  if (incoming.protocol === 'http:' && ['127.0.0.1', 'localhost'].includes(incoming.hostname)) return incoming.origin;
  const configured = env.PUBLIC_ORIGIN || defaultOrigin;
  const url = new URL(configured);
  if (url.protocol !== 'https:' || configured !== url.origin) throw new Error('PUBLIC_ORIGIN must be an exact HTTPS origin.');
  return url.origin;
}
