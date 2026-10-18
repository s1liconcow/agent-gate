import {readFile, writeFile} from 'node:fs/promises';
import {execFile} from 'node:child_process';
import {promisify} from 'node:util';
import {createHash} from 'node:crypto';
import {resolve} from 'node:path';
import {pathToFileURL} from 'node:url';
import {coordinatorDeploymentMetadata} from './coordinator-deployment.mjs';

const root = resolve(import.meta.dirname, '..');
const fail = (code, message) => Object.assign(new Error(message), {code});
const stable = value => JSON.stringify(value, (_, item) => item && typeof item === 'object' && !Array.isArray(item) ? Object.fromEntries(Object.entries(item).sort(([a], [b]) => a.localeCompare(b))) : item);

export async function localCredentials({env = process.env, execute = promisify(execFile)} = {}) {
  if (env.CLOUDFLARE_API_TOKEN) return {Authorization: 'Bearer ' + env.CLOUDFLARE_API_TOKEN};
  if (env.CLOUDFLARE_API_KEY && env.CLOUDFLARE_EMAIL) return {'X-Auth-Key': env.CLOUDFLARE_API_KEY, 'X-Auth-Email': env.CLOUDFLARE_EMAIL};
  try {
    // Capture credentials in memory and disable Wrangler's disk logging.
    const {stdout} = await execute(process.execPath, [resolve(root, 'node_modules/wrangler/bin/wrangler.js'), 'auth', 'token', '--json'], {
      cwd: root, env: {...env, WRANGLER_WRITE_LOGS: 'false', WRANGLER_SEND_METRICS: 'false'}, timeout: 20000, maxBuffer: 64000
    });
    const auth = JSON.parse(stdout);
    if (['oauth', 'api_token'].includes(auth.type) && auth.token) return {Authorization: 'Bearer ' + auth.token};
    if (auth.type === 'api_key' && auth.key && auth.email) return {'X-Auth-Key': auth.key, 'X-Auth-Email': auth.email};
  } catch { /* Never include credential subprocess output in an error. */ }
  throw fail('LOCAL_CLOUDFLARE_AUTH_REQUIRED', 'Authorize Wrangler locally, then run --inspect before --deploy.');
}

export class LocalCloudflare {
  #credentials;
  constructor(account, worker, credentials, fetcher = fetch) {
    if (!/^[a-f0-9]{32}$/.test(account) || !/^[a-z0-9][a-z0-9_-]*$/.test(worker)) throw fail('INVALID_TARGET', 'Invalid deployment target.');
    this.base = '/accounts/' + account + '/workers/scripts/' + worker; this.#credentials = credentials; this.fetcher = fetcher;
  }
  async request(method, resource, body, contentType = 'application/json') {
    if (!(method === 'GET' && ['settings', 'deployments', 'versions?per_page=100'].includes(resource) || method === 'POST' && ['versions?bindings_inherit=strict', 'deployments'].includes(resource))) throw fail('INVALID_OPERATION', 'Unsupported Worker release operation.');
    const response = await this.fetcher('https://api.cloudflare.com/client/v4' + this.base + '/' + resource, {
      method, headers: {...this.#credentials, ...(body === undefined ? {} : {'Content-Type': contentType})},
      ...(body === undefined ? {} : {body: typeof body === 'string' ? body : JSON.stringify(body)}),
      redirect: 'error', signal: AbortSignal.timeout(method === 'POST' ? 45000 : 20000)
    });
    const value = await response.json();
    if (!response.ok || value.success !== true) throw fail('CLOUDFLARE_API_ERROR', 'Cloudflare HTTP ' + response.status + '; error codes: ' + (value.errors || []).map(error => error.code).join(', '));
    return value.result;
  }
}

export function verifySettings(actual, original, requireAdmin = true) {
  const google = new Set(['GOOGLE_CLIENT_ID', 'GOOGLE_CLIENT_SECRET']);
  const before = new Map(original.bindings.filter(item => item.name !== 'ADMIN_ACCOUNT_ID').map(item => [item.name, item]));
  const after = new Map(actual.bindings.map(item => [item.name, item]));
  for (const [name, binding] of before) if (stable(after.get(name)) !== stable(binding)) throw fail('BINDINGS_CHANGED', 'Existing binding changed: ' + name);
  if ([...after.keys()].some(name => name !== 'ADMIN_ACCOUNT_ID' && !google.has(name) && !before.has(name))) throw fail('BINDINGS_CHANGED', 'An unexpected binding appeared.');
  const admin = after.get('ADMIN_ACCOUNT_ID');
  if (requireAdmin && (admin || [...google].some(name => after.get(name)?.type !== 'secret_text'))) throw fail('ADMIN_BINDING_CHANGED', 'Administration requires Google sign-in credentials and no account-based administrator.');
  for (const key of ['compatibility_date', 'compatibility_flags', 'usage_model', 'logpush', 'observability', 'placement', 'tags', 'tail_consumers']) if (stable(actual[key]) !== stable(original[key])) throw fail('SETTINGS_CHANGED', 'Existing Worker setting changed: ' + key);
}

const serves = (deployment, id) => deployment?.versions?.length === 1 && deployment.versions[0].version_id === id && deployment.versions[0].percentage === 100;
export async function inspectRelease(client, release, identity) {
  const [settings, deployments, versions] = await Promise.all([client.request('GET', 'settings'), client.request('GET', 'deployments'), client.request('GET', 'versions?per_page=100')]);
  return {settings, active: deployments.deployments[0], matching: versions.items.find(version => version.annotations?.['workers/commit_sha'] === release.commit && version.annotations?.['workers/message']?.includes(identity.sha256))};
}

export async function deployRelease({client, release, identity, source, baseline, inspectOnly = false, progress = () => {}}) {
  if (identity.commit !== release.commit || source.length !== identity.bytes || createHash('sha256').update(source).digest('hex') !== identity.sha256) throw fail('RELEASE_INTEGRITY_FAILED', 'The approved bundle changed.');
  progress('Inspecting the active deployment and recent uploaded versions.');
  const state = await inspectRelease(client, release, identity);
  verifySettings(state.settings, baseline.settings, false);
  if (inspectOnly) return {status: 'inspected', active: state.active, matching_version: state.matching?.id || null, admin_enabled: !state.settings.bindings.some(binding => binding.name === 'ADMIN_ACCOUNT_ID') && ['GOOGLE_CLIENT_ID', 'GOOGLE_CLIENT_SECRET'].every(name => state.settings.bindings.some(binding => binding.name === name && binding.type === 'secret_text')), bundle_sha256: identity.sha256};
  if (release.deployment_approval !== 'approved') throw fail('APPROVAL_REQUIRED', 'Deployment approval is missing from the release manifest.');
  if (state.matching && serves(state.active, state.matching.id)) {
    verifySettings(state.settings, baseline.settings);return {status: 'already_deployed', commit: release.commit, version_id: state.matching.id, deployment_id: state.active.id};
  }
  if (state.active.id !== release.rollback.deployment_id) throw fail('DEPLOYMENT_BASELINE_CHANGED', 'The active deployment changed. Inspect before continuing.');
  let version = state.matching;
  if (!version) {
    const metadata = coordinatorDeploymentMetadata(state.settings, 'Verified Google administration; bundle ' + identity.sha256);
    metadata.bindings = metadata.bindings.filter(binding => binding.name !== 'ADMIN_ACCOUNT_ID');
    Object.assign(metadata.annotations, {'workers/commit_sha': release.commit, 'workers/tag': release.commit.slice(0, 12)});
    const boundary = 'AgentGateRelease' + release.commit;
    if (source.includes(Buffer.from(boundary))) throw fail('RELEASE_INTEGRITY_FAILED', 'Multipart boundary conflicts with the source.');
    const body = ['--' + boundary, 'Content-Disposition: form-data; name="metadata"', 'Content-Type: application/json', '', JSON.stringify(metadata), '--' + boundary, 'Content-Disposition: form-data; name="worker.mjs"; filename="worker.mjs"', 'Content-Type: application/javascript+module', '', source.toString('utf8'), '--' + boundary + '--', ''].join('\r\n');
    progress('Uploading the verified Worker bundle from this computer.');
    try {version = await client.request('POST', 'versions?bindings_inherit=strict', body, 'multipart/form-data; boundary=' + boundary);}
    catch (error) {
      if (error.code === 'CLOUDFLARE_API_ERROR') throw error;
      try {version = (await inspectRelease(client, release, identity)).matching;} catch { /* Preserve uncertain outcome. */ }
      if (!version) throw fail('UPLOAD_OUTCOME_UNCERTAIN', 'Run --inspect before retrying. No second upload was attempted.');
    }
  } else progress('Reusing the matching uploaded version.');
  verifySettings(await client.request('GET', 'settings'), baseline.settings, false);
  const current = (await client.request('GET', 'deployments')).deployments[0];
  if (current.id !== release.rollback.deployment_id && !serves(current, version.id)) throw fail('DEPLOYMENT_BASELINE_CHANGED', 'Another deployment completed during upload. Inspect before continuing.');
  if (!serves(current, version.id)) {
    progress('Deploying the approved version at 100% traffic.');
    try {await client.request('POST', 'deployments', {strategy: 'percentage', code_update_strategy: {mode: 'immediate'}, versions: [{version_id: version.id, percentage: 100}], annotations: {'workers/message': 'Deploy approved ' + release.commit + '; verified Google administration; preserve resources and consent.'}});}
    catch (error) {
      if (error.code === 'CLOUDFLARE_API_ERROR') throw error;
      let observed;try {observed = (await client.request('GET', 'deployments')).deployments[0];} catch { /* Preserve uncertain outcome. */ }
      if (!serves(observed, version.id)) throw fail('DEPLOYMENT_OUTCOME_UNCERTAIN', 'Run --inspect before retrying. No second deployment was attempted.');
    }
  }
  const active = (await client.request('GET', 'deployments')).deployments[0];
  if (!serves(active, version.id)) throw fail('DEPLOYMENT_NOT_CONFIRMED', 'The approved version is not confirmed at 100% traffic.');
  verifySettings(await client.request('GET', 'settings'), baseline.settings);
  return {status: 'deployed', commit: release.commit, version_id: version.id, deployment_id: active.id, percentage: 100, bundle_sha256: identity.sha256, rollback: release.rollback};
}

async function main(args) {
  if (!['--inspect', '--deploy', '--check-bundle'].includes(args[0]) || args.length > 3 || args.length === 2 || args.length > 1 && args[1] !== '--manifest') throw fail('USAGE', 'Usage: node scripts/deploy-release.mjs --check-bundle|--inspect|--deploy [--manifest PATH]');
  const release = JSON.parse(await readFile(resolve(root, args[2] || 'artifacts/admin-release-manifest.json'), 'utf8'));
  const identity = JSON.parse(await readFile(resolve(root, release.evidence.bundle), 'utf8'));
  const source = await readFile(resolve(root, release.bundle_file));
  if (identity.commit !== release.commit || source.length !== identity.bytes || createHash('sha256').update(source).digest('hex') !== identity.sha256) throw fail('RELEASE_INTEGRITY_FAILED', 'The prepared bundle changed.');
  if (args[0] === '--check-bundle') {console.log(JSON.stringify({status: 'bundle_verified', ...identity}));return;}
  const baseline = JSON.parse(await readFile(resolve(root, release.baseline_file), 'utf8'));
  const client = new LocalCloudflare(release.cloudflare_account_id, release.target, await localCredentials());
  const receipt = await deployRelease({client, release, identity, source, baseline, inspectOnly: args[0] === '--inspect', progress: message => console.error(message)});
  await writeFile(resolve(root, 'artifacts/admin-local-release-receipt.json'), JSON.stringify(receipt, null, 2) + '\n');
  console.log(JSON.stringify(receipt));
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) main(process.argv.slice(2)).catch(error => {console.error(JSON.stringify({status: 'blocked', code: error.code || 'LOCAL_DEPLOY_ERROR', message: error.message}));process.exitCode = 1;});
