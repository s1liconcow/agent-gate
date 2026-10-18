import test from 'node:test';
import assert from 'node:assert/strict';
import {spawnSync} from 'node:child_process';
import {readdir, readFile} from 'node:fs/promises';
import {join} from 'node:path';
import {fileURLToPath} from 'node:url';
import {assertLocalBrowserEnvironment} from '../scripts/browser-environment.mjs';

test('macOS Codex sandbox fails before browser startup with an actionable error', () => {
  assert.throws(() => assertLocalBrowserEnvironment({platform: 'darwin', env: {CODEX_SANDBOX: 'seatbelt'}}), error => {
    assert.equal(error.code, 'LOCAL_BROWSER_SANDBOX');
    assert.match(error.message, /sandbox_permissions="require_escalated"/);
    assert.match(error.message, /Chrome was not started/);
    return true;
  });
});

test('regular macOS terminals and other platforms remain usable', () => {
  for (const platform of ['darwin', 'linux', 'win32']) {
    assert.doesNotThrow(() => assertLocalBrowserEnvironment({platform, env: {}}));
    assert.doesNotThrow(() => assertLocalBrowserEnvironment({platform, env: {CODEX_CI: '1', CODEX_SANDBOX_NETWORK_DISABLED: '1'}}));
  }
  assert.doesNotThrow(() => assertLocalBrowserEnvironment({platform: 'linux', env: {CODEX_SANDBOX: 'seatbelt'}}));
});

test('the local browser module blocks sandboxed imports before caller setup', {skip: process.platform !== 'darwin'}, () => {
  const module = new URL('../scripts/local-browser.mjs', import.meta.url).href;
  const result = spawnSync(process.execPath, ['--input-type=module', '-e', `await import(${JSON.stringify(module)}); console.log('caller setup');`], {
    env: {...process.env, CODEX_SANDBOX: 'seatbelt'}, encoding: 'utf8', timeout: 10000
  });
  assert.ifError(result.error);
  assert.equal(result.signal, null);
  assert.equal(result.status, 1);
  assert.match(result.stderr, /LOCAL_BROWSER_SANDBOX/);
  assert.equal(result.stdout, '');
});

test('local browser entrypoints share the preflight', async () => {
  const root = new URL('../', import.meta.url), unguarded = [];
  for (const directory of ['scripts', 'tests']) {
    for (const entry of await readdir(new URL(directory + '/', root), {recursive: true, withFileTypes: true})) {
      if (!entry.isFile() || !/\.[cm]?js$/.test(entry.name)) continue;
      const path = join(entry.parentPath, entry.name);
      if (path === fileURLToPath(new URL('scripts/local-browser.mjs', root))) continue;
      const source = await readFile(path, 'utf8');
      if (/(?:from\s*|import\s*\(\s*|require\s*\(\s*)['"](?:@playwright\/test|playwright(?:-core)?)(?:\/[^'"]*)?['"]/.test(source)) unguarded.push(path);
    }
  }
  assert.deepEqual(unguarded, [], 'Import local Chromium through scripts/local-browser.mjs.');
});
