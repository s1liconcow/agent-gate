import test from 'node:test';
import assert from 'node:assert/strict';
import {coordinatorDeploymentMetadata} from '../scripts/coordinator-deployment.mjs';
import {verifyCoordinator} from '../scripts/verify-coordinator.mjs';

test('API deployments update the account classes immediately and preserve infrastructure and secrets', () => {
  const settings = {compatibility_date: '2026-10-01', compatibility_flags: ['nodejs_compat'], usage_model: 'standard', logpush: false,
    observability: {enabled: false}, bindings: [
      {name: 'GATE', type: 'durable_object_namespace', class_name: 'Gate', namespace_id: 'a'.repeat(32)},
      {name: 'REGISTRY', type: 'durable_object_namespace', class_name: 'Registry', namespace_id: 'b'.repeat(32)},
      {name: 'EXTERNAL', type: 'durable_object_namespace', class_name: 'Other', script_name: 'another-worker', namespace_id: 'c'.repeat(32)},
      {name: 'BROWSER', type: 'browser', version: 2},
      {name: 'HOSTED_MODELS', type: 'r2_bucket', bucket_name: 'existing-models'},
      {name: 'OWNER_SECRET', type: 'secret_text', text: 'never-copy-this-secret'}
    ]};
  const metadata = coordinatorDeploymentMetadata(settings, 'Automatic cloud fix');
  assert.deepEqual(metadata.bindings, [
    {name: 'GATE', type: 'durable_object_namespace', class_name: 'Gate'},
    {name: 'REGISTRY', type: 'durable_object_namespace', class_name: 'Registry'},
    {name: 'EXTERNAL', type: 'inherit'}, {name: 'BROWSER', type: 'inherit'}, {name: 'HOSTED_MODELS', type: 'inherit'}
  ]);
  assert.deepEqual(metadata.code_update_strategy, {mode: 'immediate'});
  assert.deepEqual(metadata.keep_bindings, ['secret_text']);
  assert.ok(!JSON.stringify(metadata).includes('never-copy-this-secret'));
  assert.deepEqual(metadata.observability, settings.observability);
  assert.equal(metadata.migrations, undefined);
});

test('deployment verification rejects a stale account backend even when HTTP health succeeds', async () => {
  const request = async (url, options) => {
    assert.equal(new URL(url).pathname, '/api/health');
    assert.equal(options.cache, 'no-store');
    return Response.json({version: '0.7.1', paired: true});
  };
  await assert.rejects(verifyCoordinator('https://gate.example/', request), /older coordinator version/);
});

test('deployment verification requires working cloud dependencies and provisioning for paired accounts', async () => {
  const ready = {version: '0.7.1', paired: true, cloud_browser: {readiness_source: 'browser_dom_events', browser_binding: true, assets_binding: true, model_installed: true, available: true, configured: true}};
  const fetcher = value => async () => Response.json(value);
  assert.equal((await verifyCoordinator('https://gate.example', fetcher(ready))).cloud_configured, true);
  for (const key of ['browser_binding', 'assets_binding', 'model_installed', 'available']) {
    await assert.rejects(verifyCoordinator('https://gate.example', fetcher({...ready, cloud_browser: {...ready.cloud_browser, [key]: false}})), /deployment dependency/);
  }
  await assert.rejects(verifyCoordinator('https://gate.example', fetcher({...ready, cloud_browser: {...ready.cloud_browser, configured: false}})), /no configured cloud browser/);
  assert.equal((await verifyCoordinator('https://gate.example/u/' + 'a'.repeat(32), fetcher({...ready, paired: false, cloud_browser: {...ready.cloud_browser, configured: false}}))).paired, false);
  await assert.rejects(verifyCoordinator('https://gate.example', fetcher({...ready, cloud_browser: {...ready.cloud_browser, readiness_source: undefined}})), /older coordinator version/);
});

test('version-specific health checks target an active release and reject a stale account backend', async () => {
  const deploymentId = 'e33071d3-fc53-4203-adbd-d7659f80df1b', workerName = 'agentgate-control';
  const ready = {deployment_id: deploymentId, cloud_browser: {readiness_source: 'browser_dom_events', browser_binding: true, assets_binding: true, model_installed: true, available: true}};
  const fetcher = async (_, options) => {
    assert.equal(options.headers['Cloudflare-Workers-Version-Overrides'], workerName + '=' + JSON.stringify(deploymentId));
    return Response.json(ready);
  };
  assert.equal((await verifyCoordinator('https://gate.example', fetcher, {deploymentId, workerName})).deployment_id, deploymentId);
  await assert.rejects(verifyCoordinator('https://gate.example', async () => Response.json({...ready, deployment_id: 'old'}), {deploymentId, workerName}), /expected deployment/);
});
