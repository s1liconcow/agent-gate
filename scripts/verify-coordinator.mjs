import {pathToFileURL} from 'node:url';

export async function verifyCoordinator(url, fetcher = fetch) {
  const base = url.replace(/\/$/, ''), endpoint = new URL(base + '/api/health');
  endpoint.searchParams.set('deployment_check', String(Date.now()));
  const response = await fetcher(endpoint.href, {cache: 'no-store', redirect: 'error', signal: AbortSignal.timeout(30000)});
  if (!response.ok) throw new Error('The coordinator health check failed: HTTP ' + response.status);
  const health = await response.json(), cloud = health.cloud_browser;
  if (!cloud) throw new Error('The account backend is still running an older coordinator version.');
  if (!cloud.browser_binding || !cloud.assets_binding || !cloud.model_installed || !cloud.available) throw new Error('The account backend is missing a cloud browser deployment dependency.');
  if (health.paired && !cloud.configured) throw new Error('This paired account has no configured cloud browser.');
  return {version: health.version, paired: health.paired, cloud_available: cloud.available, cloud_configured: cloud.configured};
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  if (process.argv.length !== 3) throw new Error('Usage: node scripts/verify-coordinator.mjs COORDINATOR_URL');
  console.log(JSON.stringify(await verifyCoordinator(process.argv[2])));
}
