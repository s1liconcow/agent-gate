import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp, mkdir, readFile, readdir, rm, writeFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {createHash} from 'node:crypto';
import {buildPurposeEngine, installPurposeBundle, purposeProtocol, validatePurposeBundle} from '../scripts/purpose-bundle.mjs';

const hash = value => createHash('sha256').update(value).digest('hex');
async function fixture(t) {
  const root = await mkdtemp(join(tmpdir(), 'agentgate-purpose-build-'));
  t.after(() => rm(root, {recursive: true, force: true}));
  const directory = join(root, 'export'); await mkdir(directory);
  const files = {};
  for (const name of ['model.onnx', 'tokenizer.json', 'tokenizer_config.json']) {
    const content = Buffer.from(name);
    await writeFile(join(directory, name), content);
    files[name] = {bytes: content.length, sha256: hash(content)};
  }
  const manifest = {model: 'agentgate-purpose-browser-' + 'a'.repeat(16), trained: true, threshold: .98, files, checkpoint_selection: 'calibrated-utility', domains: ['calendar']};
  const fidelity = {passed: true, model: manifest.model, cases: 200, exported: {necessary: 100, released_necessary: 95, false_releases: 1}, utility: {passed: true}, by_domain: {calendar: {exported: {necessary: 100, released_necessary: 95, false_releases: 1}}}};
  async function save() {
    const content = JSON.stringify(manifest);
    await writeFile(join(directory, 'manifest.json'), content);
    fidelity.manifest_sha256 = hash(content);
    await writeFile(join(directory, 'fidelity.json'), JSON.stringify(fidelity));
  }
  await save(); return {root, directory, manifest, fidelity, save};
}

test('installing a verified model updates only the canonical extension model directory', async t => {
  const {root, directory, manifest} = await fixture(t);
  await mkdir(join(root, 'extension'));
  await writeFile(join(root, 'extension/review.html'), 'Current dropdown');
  await writeFile(join(directory, 'review.html'), 'Old dropdown');
  assert.deepEqual(await installPurposeBundle(root, directory), manifest);
  assert.equal(await readFile(join(root, 'extension/review.html'), 'utf8'), 'Current dropdown');
  const installed = join(root, 'extension/models/purpose');
  assert.deepEqual(await validatePurposeBundle(installed), manifest);
  assert.deepEqual(await installPurposeBundle(root, installed), manifest);
  assert.deepEqual((await readdir(join(root, 'extension'))).sort(), ['models', 'review.html']);
});

test('rebuilding from the shared protocol retains the installed pin and leaves public defaults unconfigured', async () => {
  const source = await readFile(new URL('../shared/protocol.mjs', import.meta.url), 'utf8');
  const manifest = {model: 'agentgate-purpose-browser-' + 'b'.repeat(16)};
  const first = purposeProtocol(source, manifest), second = purposeProtocol(source, manifest);
  assert.equal(first, second);
  assert.ok(first.includes("model: '" + manifest.model + "'"));
  assert.equal(purposeProtocol(source, null), source);
  assert.ok(source.includes("purpose_browser: {endpoint: 'browser://purpose', model: '', format: 'classifier'}"));
  assert.throws(() => purposeProtocol(first, manifest));
  assert.throws(() => purposeProtocol(source, {model: 'latest'}));
});

test('tampered checkpoint bytes and changed fidelity identity cannot replace an installed model', async t => {
  const {root, directory, manifest, fidelity, save} = await fixture(t);
  await installPurposeBundle(root, directory);
  await writeFile(join(directory, 'model.onnx'), 'Changed checkpoint');
  await assert.rejects(installPurposeBundle(root, directory), /Checkpoint bundle changed/);
  assert.deepEqual(await validatePurposeBundle(join(root, 'extension/models/purpose')), manifest);
  await save(); fidelity.manifest_sha256 = '0'.repeat(64);
  await writeFile(join(directory, 'fidelity.json'), JSON.stringify(fidelity));
  await assert.rejects(validatePurposeBundle(directory), /Verify export fidelity/);
});

test('development and workflow utility gates still apply when installing in place', async t => {
  const {directory, fidelity, save} = await fixture(t);
  fidelity.exported.released_necessary = 94; await save();
  await assert.rejects(validatePurposeBundle(directory), /Development utility failed/);
  fidelity.exported.released_necessary = 95; fidelity.exported.false_releases = 2; await save();
  await assert.rejects(validatePurposeBundle(directory), /Development utility failed/);
  fidelity.exported.false_releases = 1; fidelity.by_domain.calendar.exported.released_necessary = 89; await save();
  await assert.rejects(validatePurposeBundle(directory), /Workflow development utility failed/);
});

test('a missing local model permits a base build while an incomplete installation fails', async t => {
  const {root} = await fixture(t);
  assert.equal(await buildPurposeEngine(root), null);
  await mkdir(join(root, 'extension/models/purpose'), {recursive: true});
  await assert.rejects(buildPurposeEngine(root), {code: 'ENOENT'});
});
