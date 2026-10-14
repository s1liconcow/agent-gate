import test from 'node:test';
import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import {localCredentials, LocalCloudflare, deployRelease, verifySettings} from '../scripts/deploy-release.mjs';
const source = Buffer.from('export default {};'), identity = {commit: 'a'.repeat(40), bytes: source.length, sha256: createHash('sha256').update(source).digest('hex')};
const settings = {bindings: [{name: 'GATE', type: 'durable_object_namespace', namespace_id: 'original', class_name: 'Gate'}, {name: 'SECRET', type: 'secret_text'}], compatibility_date: '2026-10-01'};
const approved = {...settings, bindings: [...settings.bindings, {name: 'ADMIN_ACCOUNT_ID', type: 'plain_text', text: 'owner'}]};
const release = {commit: identity.commit, deployment_approval: 'approved', rollback: {deployment_id: 'baseline', version_id: 'old'}};
const active = {id: 'baseline', versions: [{version_id: 'old', percentage: 100}]}, matching = {id: 'approved', annotations: {'workers/commit_sha': identity.commit, 'workers/message': 'Bundle ' + identity.sha256}};

test('credential capture disables disk logging and hides credential subprocess failures', async () => {
  await assert.rejects(localCredentials({env: {}, execute: async () => {throw Error('sensitive-subprocess-output');}}), error => error.code === 'LOCAL_CLOUDFLARE_AUTH_REQUIRED' && !error.message.includes('sensitive'));
  let options;
  const auth = await localCredentials({env: {}, execute: async (_, args, value) => {options = value;return {stdout: JSON.stringify({type: 'oauth', token: 'synthetic-secret'})};}});
  assert.equal(auth.Authorization, 'Bearer synthetic-secret');assert.equal(options.env.WRANGLER_WRITE_LOGS, 'false');
});
test('API failures expose codes while withholding echoed credential data', async () => {
  const client = new LocalCloudflare('a'.repeat(32), 'test-worker', {Authorization: 'Bearer synthetic-secret'}, async () => Response.json({success: false, errors: [{code: 1000, message: 'synthetic-secret'}]}, {status: 403}));
  await assert.rejects(client.request('GET', 'settings'), error => error.message.includes('403') && !error.message.includes('synthetic-secret'));
  await assert.rejects(client.request('DELETE', 'settings'), {code: 'INVALID_OPERATION'});
});
test('deployment validation preserves namespaces, secrets, settings and the exact admin', () => {
  verifySettings(approved, settings);
  for (const candidate of [{...approved, compatibility_date: 'changed'}, {...approved, bindings: approved.bindings.slice(1)}, {...approved, bindings: [...settings.bindings, {name: 'ADMIN_ACCOUNT_ID', type: 'plain_text', text: 'other'}]}]) assert.throws(() => verifySettings(candidate, settings));
});
test('an already-deployed matching release causes no writes', async () => {
  const writes = [], client = {request: async (method, resource) => {if (method !== 'GET') writes.push(method);return resource === 'settings' ? approved : resource === 'deployments' ? {deployments: [{id: 'live', versions: [{version_id: matching.id, percentage: 100}]}]} : {items: [matching]};}};
  assert.equal((await deployRelease({client, release, identity, source, baseline: {settings}})).status, 'already_deployed');assert.deepEqual(writes, []);
});
test('an interrupted upload is inspected and reused without a duplicate upload', async () => {
  let uploads = 0, deployments = 0, inspections = 0;
  const client = {request: async (method, resource, body) => {
    if (method === 'POST' && resource.startsWith('versions')) {uploads++;throw Error('network interruption');}
    if (method === 'POST') {assert.deepEqual(body.code_update_strategy, {mode: 'immediate'}); deployments++;return {id: 'live'};}
    if (resource === 'settings') return uploads ? approved : settings;
    if (resource.startsWith('versions')) {inspections++;return {items: uploads ? [matching] : []};}
    return {deployments: [deployments ? {id: 'live', versions: [{version_id: matching.id, percentage: 100}]} : active]};
  }};
  assert.equal((await deployRelease({client, release, identity, source, baseline: {settings}})).status, 'deployed');assert.equal(uploads, 1);assert.equal(deployments, 1);assert.equal(inspections, 2);
});
test('an unconfirmed upload stops without a deployment or blind retry', async () => {
  let uploads = 0;
  const client = {request: async (method, resource) => {if (method === 'POST') {uploads++;throw Error('network interruption');}return resource === 'settings' ? settings : resource === 'deployments' ? {deployments: [active]} : {items: []};}};
  await assert.rejects(deployRelease({client, release, identity, source, baseline: {settings}}), {code: 'UPLOAD_OUTCOME_UNCERTAIN'});assert.equal(uploads, 1);
});
