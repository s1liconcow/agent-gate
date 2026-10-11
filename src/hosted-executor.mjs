import {action, automaticActionAllowed, canonical, checksActionPurpose, digest, exact, needsApproval, stagedFields, verifyReceipt} from '../shared/protocol.mjs';

// The command journal is durable and is written before any page effect.
// An interrupted command is reported as uncertain and never dispatched again.
export async function executeHosted(packet, {api, automatic, authorize, phoneKey, now = Date.now}) {
  const {session_id: id, command} = packet;
  let result = {command_id: command.id, ok: false, code: 'BRIDGE_ERROR'};
  await authorize(packet, 'executing');
  if (command.deadline <= now()) return {...result, code: 'EXPIRED'};
  const packetDigest = await digest(packet), {dispatches = {}} = await api.storage.local.get('dispatches');
  const previous = dispatches[command.id];
  if (previous) {
    if (previous.packet_digest !== packetDigest) throw new Error('Command authorization changed.');
    return previous.result || result;
  }
  const {bindings = {}, agent_tabs = {}} = await api.storage.session.get(['bindings', 'agent_tabs']);
  const binding = bindings[id], record = agent_tabs[id];
  if (!binding || binding.session_id !== id || command.view_digest !== binding.view_digest || binding.tab_id !== record?.current || !record.ids.includes(binding.tab_id)) throw new Error('The task view changed.');
  const approvedAction = action(command.action, packet.scope, binding.view);
  if (checksActionPurpose(packet.scope)) { if (!await automatic.allowed(packet)) throw new Error('No matching purpose check.'); }
  else if (command.requires_approval !== needsApproval(approvedAction, binding.view, packet.scope)) throw new Error('Action approval policy changed.');
  if (command.requires_approval) {
    const receipt = packet.action_receipt, c = receipt?.challenge;
    if (!c) throw new Error('No exact action approval.');
    exact(c, ['version', 'stage', 'session_id', 'nonce', 'scope_digest', 'view_digest', 'command_id', 'action', 'target', 'staged_fields', 'expires_at']);
    const target = binding.view.controls.find(control => control.ref === approvedAction.ref) || null;
    if (c.version !== 1 || c.stage !== 'action' || c.session_id !== id || c.command_id !== command.id || c.scope_digest !== packet.session_receipt.challenge.scope_digest || c.view_digest !== binding.view_digest || canonical(c.action) !== canonical(approvedAction) || canonical(c.target) !== canonical(target) || canonical(c.staged_fields) !== canonical(stagedFields(binding.view, binding.fills || {})) || c.expires_at !== command.deadline || c.expires_at > packet.session_receipt.challenge.expires_at) throw new Error('Action differs from its phone approval.');
    await verifyReceipt(receipt, phoneKey, c, now());
  }
  const tab = await api.tabs.get(binding.tab_id);
  if (new URL(tab.url).origin !== binding.view.origin || !packet.scope.origins.includes(new URL(tab.url).origin)) throw new Error('The bound tab changed origin.');
  if (packet.scope.interaction === 'automatic' && checksActionPurpose(packet.scope)) {
    const committed = Object.values(dispatches).filter(claim => claim.session_id === id).reduce((sum, claim) => sum + (claim.payment_cents || 0), 0);
    if (!automaticActionAllowed(packet.scope, command) || committed + command.payment_cents > (packet.scope.action_policy?.payment_limit_cents || 0)) throw new Error('The action exceeds its signed allowance.');
  }
  await authorize(packet, 'executing');
  dispatches[command.id] = {at: now(), packet_digest: packetDigest, session_id: id, payment_cents: command.payment_cents || 0};
  for (const [key, claim] of Object.entries(dispatches)) if (now() - claim.at > 86400000) delete dispatches[key];
  await api.storage.local.set({dispatches});
  // Consent, scope and command are checked again after the durable write.
  await authorize(packet, 'executing');
  if (['navigate', 'open_tab'].includes(approvedAction.type)) {
    if (approvedAction.type === 'open_tab') {
      if (record.ids.length >= 5) throw new Error('Task tab limit reached.');
      const opened = await api.tabs.create({url: approvedAction.url});
      record.ids.push(opened.id); record.current = opened.id;
      await api.storage.session.set({agent_tabs});
    } else await api.tabs.update(binding.tab_id, {url: approvedAction.url});
    result = {command_id: command.id, ok: true, code: 'DISPATCHED'};
  } else {
    const answer = await api.tabs.sendMessage(binding.tab_id, {type: 'execute', action: approvedAction, origins: packet.scope.origins, staged_fields: Object.entries(binding.fills || {}).map(([ref, value]) => ({ref, value}))});
    if (!answer || typeof answer.ok !== 'boolean' || !['DISPATCHED', 'STALE_VIEW', 'OUT_OF_SCOPE', 'BRIDGE_ERROR'].includes(answer.code)) throw new Error('Invalid browser adapter response.');
    result = {command_id: command.id, ...answer};
  }
  dispatches[command.id].result = result; await api.storage.local.set({dispatches});
  if (approvedAction.type === 'fill' && result.ok) binding.fills[approvedAction.ref] = approvedAction.value;
  else if (approvedAction.type !== 'fill') delete bindings[id];
  await api.storage.session.set({bindings});
  return result;
}
