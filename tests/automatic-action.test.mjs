import test from 'node:test';
import assert from 'node:assert/strict';
import {AutomaticBrowser} from '../extension/automatic.mjs';

test('automatic dispatch requires the exact checked effect and payment amount, signed options and active setup', async () => {
  const packet = {session_id: 'a'.repeat(32), scope: {disclosure: 'local_planner', interaction: 'automatic', action_policy: {communications: true, payments: true, payment_limit_cents: 5000}}, command: {id: 'b'.repeat(32), action: {type: 'click', ref: 'c'.repeat(32)}, requires_approval: false, view_digest: 'current', deadline: Date.now() + 60000, effect: 'payment', payment_cents: 5000}};
  const stored = {automation: {enabled: true}, guarded: {}};
  const previous = globalThis.chrome;
  globalThis.chrome = {storage: {local: {get: async () => stored}, session: {get: async () => stored}}};
  try {
    const browser = new AutomaticBrowser({});
    stored.guarded[packet.command.id] = {decision: 'allow', effect: 'payment', payment_cents: 5000, digest: await browser.commandDigest(packet)};
    assert.equal(await browser.allowed(packet), true);
    for (const change of [{effect: 'other'}, {payment_cents: 4900}, {payment_cents: 5001}, {requires_approval: true}, {view_digest: 'stale'}]) assert.equal(await browser.allowed({...packet, command: {...packet.command, ...change}}), false);
    stored.guarded[packet.command.id].decision = 'confirm'; assert.equal(await browser.allowed(packet), false);
    stored.guarded[packet.command.id].decision = 'allow'; stored.automation.enabled = false; assert.equal(await browser.allowed(packet), false);
  } finally { globalThis.chrome = previous; }
});
