// Emits synthetic, production-prepared disclosure cases for a Workers AI eval.
// This file makes no API requests and never loads browser data or credentials.
import {createHash} from 'node:crypto';
import {readFile} from 'node:fs/promises';
import {accessCases} from '../tests/fixtures/access-cases.mjs';
import {accessHoldout} from '../tests/fixtures/access-holdout.mjs';
import {accessAcceptance} from '../tests/fixtures/access-acceptance.mjs';
import {prepareSnapshot, selectionPrompt, verificationPrompt, itemVerificationPrompt, selectionSchema, itemVerificationSchema} from '../extension/disclosure.mjs';
import {inferenceDefaults} from '../shared/protocol.mjs';

const suites = {development: [accessCases, '../tests/fixtures/access-cases.mjs'], holdout: [accessHoldout, '../tests/fixtures/access-holdout.mjs'], acceptance: [accessAcceptance, '../tests/fixtures/access-acceptance.mjs']};
const name = process.argv[2];
if (!Object.hasOwn(suites, name)) throw new Error('Choose development, holdout or acceptance.');
const [cases, relativePath] = suites[name];
const source = await readFile(new URL(relativePath, import.meta.url));
const prepared = cases.map(c => {
  const task = {goal: c.goal, origins: ['https://mail.example'], permissions: ['read']};
  const snapshot = {origin: task.origins[0], controls: [], blocks: c.entries.map((entry, i) => ({ref: (i + 1).toString(16).padStart(32, '0'), text: entry.text, context: entry.context}))};
  const original = prepareSnapshot(snapshot, task).entries;
  const entries = original.map((entry, i) => ({...entry, id: 'e' + i}));
  const expected = c.expected.map(i => {
    const index = original.findIndex(entry => entry.id === snapshot.blocks[i].ref);
    return index < 0 ? 'filtered-' + i : 'e' + index;
  });
  return {id: c.id, goal: c.goal, need: c.need, entries, expected};
});
console.log(JSON.stringify({suite: name, fixture_sha256: createHash('sha256').update(source).digest('hex'), model: inferenceDefaults.cloudflare.model, prompts: {selection: selectionPrompt, verification: verificationPrompt, item: itemVerificationPrompt}, schemas: {selection: selectionSchema, item: itemVerificationSchema}, cases: prepared}));
