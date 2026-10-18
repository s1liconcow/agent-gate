import {pathToFileURL} from 'node:url';

export async function verifyCoordinator(url, fetcher = fetch, {deploymentId, workerName} = {}) {
  if (deploymentId && (!/^[a-f0-9-]{36}$/.test(deploymentId) || !/^[a-z0-9][a-z0-9_-]*$/.test(workerName || ''))) throw new Error('Provide a valid deployment ID and Worker name.');
  const base = url.replace(/\/$/, ''), endpoint = new URL(base + '/api/health');
  endpoint.searchParams.set('deployment_check', String(Date.now()));
  const response = await fetcher(endpoint.href, {cache: 'no-store', redirect: 'error', signal: AbortSignal.timeout(30000),
    ...(deploymentId ? {headers: {'Cloudflare-Workers-Version-Overrides': workerName + '=' + JSON.stringify(deploymentId)}} : {})});
  if (!response.ok) throw new Error('The coordinator health check failed: HTTP ' + response.status);
  const health = await response.json(), cloud = health.cloud_browser;
  if (!cloud || cloud.readiness_source !== 'browser_dom_events') throw new Error('The account backend is still running an older coordinator version.');
  if (deploymentId && health.deployment_id !== deploymentId) throw new Error('The account backend is not serving the expected deployment.');
  if (!cloud.browser_binding || !cloud.assets_binding || !cloud.model_installed || !cloud.available) throw new Error('The account backend is missing a cloud browser deployment dependency.');
  if (health.paired && !cloud.configured) throw new Error('This paired account has no configured cloud browser.');
  return {version: health.version, deployment_id: health.deployment_id, paired: health.paired, cloud_available: cloud.available, cloud_configured: cloud.configured};
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  if (![3, 5].includes(process.argv.length)) throw new Error('Usage: node scripts/verify-coordinator.mjs COORDINATOR_URL [DEPLOYMENT_ID WORKER_NAME]');
  console.log(JSON.stringify(await verifyCoordinator(process.argv[2], fetch, {deploymentId: process.argv[3], workerName: process.argv[4]})));
}
