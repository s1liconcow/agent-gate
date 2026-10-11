import test from 'node:test';
import assert from 'node:assert/strict';
import {initializeBrowser} from '../extension/browser-setup.mjs';
import {inferenceDefaults} from '../shared/protocol.mjs';

const defaults = {...inferenceDefaults, purpose_browser: {...inferenceDefaults.purpose_browser, model: 'agentgate-purpose-browser-' + 'a'.repeat(16)}};
function fixture(t, initial = {}) {
  const data = structuredClone(initial), registered = [];
  const previous = globalThis.chrome;
  globalThis.chrome = {storage: {local: {
    get: async keys => Object.fromEntries(keys.map(key => [key, structuredClone(data[key])])),
    set: async values => Object.assign(data, structuredClone(values)),
    remove: async key => { delete data[key]; }
  }}};
  t.after(() => { globalThis.chrome = previous; });
  return {data, registered, register: async value => { registered.push(structuredClone(value)); }};
}

test('a newly paired browser registers and warms the bundled model before enabling tasks', async t => {
  const f = fixture(t);
  let prepared = false;
  const result = await initializeBrowser(f.register, {defaults, prepare: async settings => {
    assert.equal(f.registered.length, 1);
    assert.equal(settings.profile.model, defaults.purpose_browser.model);
    assert.equal(f.data.automation, undefined);
    prepared = true;
  }});
  assert.ok(prepared);
  assert.equal(result.profile.provider, 'purpose_browser');
  assert.equal(result.has_key, false);
  assert.deepEqual(f.data.automation, {enabled: true, grants_enabled: true, setup_version: 1});
  assert.deepEqual(f.registered, [{inference: result.profile}]);
  const restored = await initializeBrowser(f.register, {defaults});
  assert.deepEqual(restored, result, 'Worker restarts must preserve the phone-approved profile identity.');
});

test('reload migrates old activation settings and refreshes an updated bundled model', async t => {
  const old = {profile: {id: 'b'.repeat(32), provider: 'purpose_browser', ...defaults.purpose_browser, model: 'agentgate-purpose-browser-' + 'c'.repeat(16)}, api_key: ''};
  const f = fixture(t, {inference_settings: old, automation: {enabled: false}});
  const result = await initializeBrowser(f.register, {defaults});
  assert.equal(result.profile.model, defaults.purpose_browser.model);
  assert.notEqual(result.profile.id, old.profile.id);
  assert.equal(f.data.automation.enabled, true);
});

test('reload preserves explicit remote providers, desktop-only keys and an intentional pause', async t => {
  const settings = {profile: {id: 'b'.repeat(32), provider: 'openai', ...inferenceDefaults.openai}, api_key: 'synthetic-private-key'};
  const automation = {enabled: false, grants_enabled: false, setup_version: 1};
  const f = fixture(t, {inference_settings: settings, automation});
  await initializeBrowser(f.register, {defaults, prepare: async () => assert.fail('Paused tasks must stay paused.')});
  assert.deepEqual(f.data.inference_settings, settings);
  assert.deepEqual(f.data.automation, automation);
  assert.deepEqual(f.registered, [{inference: settings.profile}]);
  assert.ok(!JSON.stringify(f.registered).includes(settings.api_key));
});

test('an explicit built-in AI preference is preserved', async t => {
  const f = fixture(t, {inference_preference: 'local'});
  assert.deepEqual(await initializeBrowser(f.register, {defaults}), {profile: null, has_key: false});
  assert.equal(f.data.inference_settings, undefined);
  assert.deepEqual(f.registered, [{inference: null}]);
  assert.equal(f.data.automation.enabled, true);
});

test('an incompatible coordinator reports its required update and does not enable tasks', async t => {
  const f = fixture(t);
  const error = Object.assign(new Error('Choose a supported inference provider.'), {code: 'INVALID_INFERENCE'});
  await assert.rejects(initializeBrowser(async () => { throw error; }, {defaults}), {code: 'COORDINATOR_UPDATE_REQUIRED'});
  assert.equal(f.data.automation, undefined);
  const profile = f.data.inference_settings.profile;
  await initializeBrowser(f.register, {defaults});
  assert.deepEqual(f.data.inference_settings.profile, profile, 'A failed registration must retry the same provider identity.');
});

test('a failed model startup withholds activation until setup succeeds', async t => {
  const f = fixture(t);
  await assert.rejects(initializeBrowser(f.register, {defaults, prepare: async () => { throw new Error('Model unavailable.'); }}), /Model unavailable/);
  assert.equal(f.data.automation, undefined);
});
