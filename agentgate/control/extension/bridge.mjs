import {action, canonical, digest, exact, origin, scope, needsApproval, stagedFields, verifyReceipt} from './protocol.mjs';
import {prepareSnapshot, selectedView} from './disclosure.mjs';
import {openPairing, pairingChallenge} from './browser-pairing.mjs';
import {AutomaticBrowser} from './automatic.mjs';
import {localModel} from './model-host.mjs';
import {inferenceSettings, inferencePresentation, saveInference, testInference} from './inference-settings.mjs';
const ready = Promise.all([chrome.storage.local.setAccessLevel({accessLevel: 'TRUSTED_CONTEXTS'}), chrome.storage.session.setAccessLevel({accessLevel: 'TRUSTED_CONTEXTS'})]);
let socket, heartbeat, reconnectTimer, queue = Promise.resolve(), pairingQueue = Promise.resolve();
const leases = new Map();
const automatic = new AutomaticBrowser({call, config, verifySession});
async function config() { await ready; return (await chrome.storage.local.get('settings')).settings; }
async function forget(settings) {
  if ((await config())?.bridge_token !== settings.bridge_token) return;
  clearTimeout(reconnectTimer); clearInterval(heartbeat);
  if (socket) { socket.onclose = null; socket.close(); socket = null; }
  await chrome.storage.local.remove('settings'); await chrome.storage.session.remove(['binding', 'bindings', 'agent_tabs', 'guarded', 'snapshot']); leases.clear();
  await automatic.activity.clear();
}
async function call(path, value) {
  const settings = await config(); if (!settings) throw new Error('Pair the desktop bridge first.');
  const response = await fetch(settings.url + '/api/bridge/' + path, {method: value === undefined ? 'GET' : 'POST', headers: {'Content-Type': 'application/json', Authorization: 'Bearer ' + settings.bridge_token, 'X-AgentGate-Extension': 'chrome-extension://' + chrome.runtime.id}, ...(value !== undefined ? {body: JSON.stringify(value)} : {}), redirect: 'error', cache: 'no-store', signal: AbortSignal.timeout(15000)});
  const result = await response.json(); if (!response.ok) { if (response.status === 403) await forget(settings); throw new Error(result.error?.message || 'The coordinator rejected the request.'); } return result;
}
const secret = () => [...crypto.getRandomValues(new Uint8Array(32))].map(n => n.toString(16).padStart(2, '0')).join('');
async function pairingCall(pending, path, value) {
  const response = await fetch(pending.url + '/api/browser/pairings' + path, {method: value === undefined ? 'GET' : 'POST', headers: {'Content-Type': 'application/json', Authorization: 'Bearer ' + pending.credential, 'X-AgentGate-Extension': 'chrome-extension://' + chrome.runtime.id}, ...(value !== undefined ? {body: JSON.stringify(value)} : {}), redirect: 'error', cache: 'no-store', signal: AbortSignal.timeout(15000)});
  const result = await response.json(); if (!response.ok) throw new Error(result.error?.message || 'Browser pairing failed.'); return result;
}
function pairingPresentation(pending) { return {id: pending.item.id, expires_at: pending.item.expires_at, qr_url: pending.url + '/#browser=' + pending.item.id + '&secret=' + pending.secret}; }
async function startPairing(url, name) {
  const pending = {url: origin(url), secret: secret(), credential: secret()};
  const requestedName = typeof name === 'string' ? name.trim() : '';
  pending.item = await pairingCall(pending, '', {name: requestedName, credential_hash: await digest(pending.credential)});
  const c = pairingChallenge(pending.item.challenge);
  if (c.browser_id !== pending.item.id || c.name !== requestedName || c.coordinator !== pending.url || c.extension_origin !== 'chrome-extension://' + chrome.runtime.id || c.credential_hash !== await digest(pending.credential) || c.expires_at !== pending.item.expires_at || c.expires_at <= Date.now() || c.expires_at > Date.now() + 300000) throw new Error('The coordinator changed the browser pairing request.');
  await chrome.storage.session.set({pending_pairing: pending}); return pairingPresentation(pending);
}
async function pairingStatus() {
  const {pending_pairing: pending} = await chrome.storage.session.get('pending_pairing');
  if (!pending) { const settings = await config(); return settings ? {status: 'connected', fingerprint: (await digest(settings.phone_key)).slice(0, 24), name: settings.name} : {status: 'none'}; }
  const item = await pairingCall(pending, '/' + pending.item.id);
  if (['expired', 'revoked'].includes(item.status)) { await chrome.storage.session.remove('pending_pairing'); throw new Error('Pairing expired or was denied. Create a new QR code.'); }
  if (item.status === 'requested') return {status: 'requested', ...pairingPresentation(pending)};
  if (!item.envelope || !['approved', 'active'].includes(item.status)) throw new Error('No encrypted phone approval. Scan a fresh QR code.');
  let phone_key;
  try { phone_key = await openPairing(pending.secret, pending.item.challenge, item.envelope); }
  catch { await chrome.storage.session.remove('pending_pairing'); throw new Error('Phone pairing could not be verified. No phone key was saved. Create and scan a fresh QR code.'); }
  const connection = await pairingCall(pending, '/' + pending.item.id + '/claim', {});
  if (connection.id !== item.id || connection.status !== 'active' || !Number.isSafeInteger(connection.expires_at) || connection.expires_at > Date.now() + pending.item.challenge.connection_ttl_seconds * 1000 || connection.expires_at <= Date.now()) throw new Error('The browser access duration changed.');
  const previous = await config(); if (previous) await forget(previous);
  await chrome.storage.local.set({settings: {url: pending.url, bridge_token: pending.credential, phone_key, browser_id: item.id, name: pending.item.name, expires_at: connection.expires_at}});
  await call('inference', {inference: (await inferenceSettings())?.profile || null});
  await chrome.storage.session.remove(['pending_pairing', 'binding', 'snapshot']); await connect();
  return {status: 'paired', fingerprint: (await digest(phone_key)).slice(0, 24), name: pending.item.name};
}
async function verifySession(packet, publicKey) {
  const receipt = packet.session_receipt, c = receipt?.challenge;
  if (!c) throw new Error('No phone session approval.');
  exact(c, ['version', 'stage', 'session_id', 'nonce', 'scope_digest', 'scope', 'expires_at']);
  const checked = scope(packet.scope);
  if (c.version !== 1 || c.stage !== 'session' || c.session_id !== packet.session_id || canonical(c.scope) !== canonical(checked) || c.scope_digest !== await digest(checked) || c.expires_at > Date.now() + checked.ttl_seconds * 1000) throw new Error('Session scope differs from the signed approval.');
  await verifyReceipt(receipt, publicKey, c);
  const previous = leases.get(c.session_id);
  if (!previous) leases.set(c.session_id, {at: performance.now(), duration: Math.max(0, c.expires_at - Date.now())});
  else if (performance.now() - previous.at >= previous.duration) throw new Error('The local session lease expired.');
}
async function execute(packet) {
  const {session_id: id, command} = packet;
  let result = {command_id: command?.id, ok: false, code: 'BRIDGE_ERROR'};
  try {
    const settings = await config(); await verifySession(packet, settings.phone_key);
    if (command.deadline <= Date.now()) throw new Error('Command expired.');
    const packetDigest = await digest(packet), {dispatches = {}} = await chrome.storage.local.get('dispatches');
    if (dispatches[command.id]) {
      if (dispatches[command.id].packet_digest !== packetDigest) throw new Error('A command identifier was reused with changed authorization.');
      result = dispatches[command.id].result || result;
      if (socket?.readyState === WebSocket.OPEN) socket.send(JSON.stringify({session_id: id, result}));
      return;
    }
    const {binding: manualBinding, bindings = {}} = await chrome.storage.session.get(['binding', 'bindings']);
    const automated = Boolean(bindings[id]), binding = bindings[id] || manualBinding;
    if (!binding || binding.session_id !== id || command.view_digest !== binding.view_digest) throw new Error('Bind and publish the current view first.');
    const approvedAction = action(command.action, packet.scope, binding.view);
    if (packet.scope.interaction === 'local_gate') { if (!await automatic.allowed(packet)) throw new Error('No matching local purpose approval.'); }
    else if (command.requires_approval !== needsApproval(approvedAction, binding.view)) throw new Error('The action approval policy changed.');
    if (command.requires_approval) {
      const receipt = packet.action_receipt, c = receipt?.challenge;
      if (!c) throw new Error('No exact action approval.');
      exact(c, ['version', 'stage', 'session_id', 'nonce', 'scope_digest', 'view_digest', 'command_id', 'action', 'target', 'staged_fields', 'expires_at']);
      const target = binding.view.controls.find(c => c.ref === approvedAction.ref) || null;
      const fields = stagedFields(binding.view, binding.fills || {});
      if (c.version !== 1 || c.stage !== 'action' || c.session_id !== id || c.command_id !== command.id || c.scope_digest !== packet.session_receipt.challenge.scope_digest || c.view_digest !== binding.view_digest || canonical(c.action) !== canonical(approvedAction) || canonical(c.target) !== canonical(target) || canonical(c.staged_fields) !== canonical(fields) || c.expires_at !== command.deadline || c.expires_at > packet.session_receipt.challenge.expires_at) throw new Error('The exact action differs from its phone approval.');
      await verifyReceipt(receipt, settings.phone_key, c);
    }
    const tab = await chrome.tabs.get(binding.tab_id);
    if (new URL(tab.url).origin !== binding.view.origin || !packet.scope.origins.includes(new URL(tab.url).origin)) throw new Error('The bound tab changed origin.');
    if (dispatches[command.id]) {
      result = dispatches[command.id].result || result;
    } else {
      // Persist the claim BEFORE touching the page. An interrupted claim is never replayed.
      dispatches[command.id] = {at: Date.now(), packet_digest: packetDigest};
      for (const [key, value] of Object.entries(dispatches)) if (Date.now() - value.at > 86400000) delete dispatches[key];
      await chrome.storage.local.set({dispatches});
      if (['navigate', 'open_tab'].includes(approvedAction.type)) {
        const destination = new URL(approvedAction.url).origin;
        if (destination.startsWith('https:') && !await chrome.permissions.contains({origins: [destination + '/*']})) throw new Error('The approved website needs its setup permission.');
        if (approvedAction.type === 'open_tab') {
          const {agent_tabs = {}} = await chrome.storage.session.get('agent_tabs'), record = agent_tabs[id];
          if (!automated || !record || record.ids.length >= 5) throw new Error('The task cannot open another tab.');
          const opened = await chrome.tabs.create({url: approvedAction.url, active: false});
          record.ids.push(opened.id); record.current = opened.id; await chrome.storage.session.set({agent_tabs});
          await automatic.activity.sync([{...packet, id, status: 'executing'}], true, true);
        } else await chrome.tabs.update(binding.tab_id, {url: approvedAction.url});
        result = {command_id: command.id, ok: true, code: 'DISPATCHED'};
      } else {
        const answer = await chrome.tabs.sendMessage(binding.tab_id, {type: 'execute', action: approvedAction, origins: packet.scope.origins, staged_fields: Object.entries(binding.fills || {}).map(([ref, value]) => ({ref, value}))}, {frameId: 0});
        if (!answer || typeof answer.ok !== 'boolean' || !['DISPATCHED', 'STALE_VIEW', 'OUT_OF_SCOPE', 'BRIDGE_ERROR'].includes(answer.code)) throw new Error('Invalid local adapter response.');
        result = {command_id: command.id, ...answer};
      }
      dispatches[command.id].result = result; await chrome.storage.local.set({dispatches});
      if (approvedAction.type === 'fill' && result.ok) {
        binding.fills[approvedAction.ref] = approvedAction.value;
        if (automated) { bindings[id] = binding; await chrome.storage.session.set({bindings}); } else await chrome.storage.session.set({binding});
      } else if (approvedAction.type !== 'fill') {
        if (automated) { delete bindings[id]; await chrome.storage.session.set({bindings}); } else await chrome.storage.session.remove('binding');
      }
    }
  } catch (error) { await chrome.storage.session.set({last_error: error.message}); /* Local diagnostics never enter an agent result. */ }
  if (socket?.readyState === WebSocket.OPEN && result.command_id) socket.send(JSON.stringify({session_id: id, result}));
}
async function connect() {
  if (socket?.readyState === WebSocket.OPEN || socket?.readyState === WebSocket.CONNECTING) return;
  clearTimeout(reconnectTimer); clearInterval(heartbeat);
  try {
    const settings = await config(); if (!settings) return;
    if (settings.expires_at && settings.expires_at <= Date.now()) { await forget(settings); return; }
    const {ticket} = await call('ticket', {}), url = new URL(settings.url + '/api/bridge/socket'); url.protocol = url.protocol === 'https:' ? 'wss:' : 'ws:';
    socket = new WebSocket(url, 'agentgate-' + ticket);
    socket.onopen = () => { socket.send('ready'); heartbeat = setInterval(() => { if (socket?.readyState === WebSocket.OPEN) socket.send('ping'); }, 20000); };
    socket.onmessage = event => {
      if (event.data === 'pong') return;
      try {
        const packet = JSON.parse(event.data);
        queue = queue.then(async () => {
          const {binding} = await chrome.storage.session.get('binding');
          if (binding && packet.sessions?.some(i => i.id === binding.session_id && ['revoked', 'expired', 'closed'].includes(i.status))) await chrome.storage.session.remove(['binding', 'snapshot']);
          await automatic.stop(packet.sessions);
          for (const check of packet.checks || []) await automatic.check(check);
          for (const command of packet.commands || []) await execute(command);
          automatic.tick().catch(() => {});
        }).catch(() => {});
      } catch { socket.close(); }
    };
    socket.onclose = event => { clearInterval(heartbeat); automatic.activity.pause(); if (event.code === 4001) { forget(settings).catch(() => {}); } else reconnectTimer = setTimeout(connect, 5000); };
    socket.onerror = () => socket.close();
  } catch { reconnectTimer = setTimeout(connect, 5000); }
}
chrome.alarms.create('agentgate-reconnect', {periodInMinutes: 1});
chrome.alarms.onAlarm.addListener(() => { connect(); automatic.tick().catch(() => {}); });
setInterval(() => { automatic.activity.expire(); automatic.tick().catch(() => {}); }, 5000);
chrome.tabs.onUpdated.addListener((tabId, change) => { if (change.status === 'complete') automatic.activity.loaded(tabId); });
automatic.activity.initialize();
chrome.action.onClicked.addListener(async tab => {
  await ready;
  try { const url = new URL(tab.url); if (url.protocol !== 'https:' && !(url.protocol === 'http:' && ['127.0.0.1', 'localhost'].includes(url.hostname))) throw new Error(); await chrome.storage.session.set({source: {tab_id: tab.id, origin: url.origin}}); }
  catch { await chrome.storage.session.remove('source'); }
  await chrome.tabs.create({url: chrome.runtime.getURL('review.html')});
});
chrome.runtime.onMessage.addListener((message, sender, respond) => {
  if (sender.id !== chrome.runtime.id || sender.url !== chrome.runtime.getURL('review.html')) return false;
  (async () => {
    await ready;
    if (['start_pairing', 'pairing_status'].includes(message.type)) {
      const operation = async () => message.type === 'start_pairing' ? {ok: true, status: 'requested', ...await startPairing(message.url, message.name)} : {ok: true, ...await pairingStatus()};
      pairingQueue = pairingQueue.then(operation, operation); return pairingQueue;
    }
    if (message.type === 'connect') { socket?.close(); socket = null; await connect(); return {ok: true}; }
    if (message.type === 'status') return {ok: true, connected: socket?.readyState === WebSocket.OPEN, automation: (await chrome.storage.local.get('automation')).automation || null};
    if (message.type === 'inference_status') return {ok: true, ...inferencePresentation(await inferenceSettings())};
    if (message.type === 'save_inference') return {ok: true, ...await saveInference(message, value => call('inference', value))};
    if (message.type === 'test_inference') return {ok: true, ...await testInference()};
    if (message.type === 'enable_automation') {
      if (!await chrome.permissions.contains({origins: ['https://*/*']})) throw new Error('Grant website access once in setup.');
      const result = await localModel('availability');
      if (result.availability !== 'available') throw new Error('Enable Chrome’s model or configure a remote provider in setup.');
      await call('inference', {inference: (await inferenceSettings())?.profile || null});
      await chrome.storage.local.set({automation: {enabled: true}}); automatic.tick().catch(() => {}); return {ok: true};
    }
    if (message.type === 'disable_automation') { await chrome.storage.local.set({automation: {enabled: false}}); await automatic.activity.pause(); return {ok: true}; }
    if (message.type === 'sessions') return {ok: true, ...await call('sessions')};
    if (message.type === 'capture' || message.type === 'snapshot') {
      const {source} = await chrome.storage.session.get('source'); if (!source) throw new Error('Click AgentGate on the source browser tab first.');
      const tab = await chrome.tabs.get(source.tab_id); if (new URL(tab.url).origin !== source.origin) throw new Error('The source tab changed. Bind it with the toolbar again.');
      let item;
      if (message.type === 'snapshot') {
        const {sessions} = await call('sessions'); item = sessions.find(s => s.id === message.session_id);
        if (!item || item.status !== 'active' || item.view || item.scope.disclosure !== 'local_planner' || !item.scope.origins.includes(source.origin)) throw new Error('Approve local planning in an active session with no published view first.');
        await verifySession({session_id: item.id, scope: item.scope, session_receipt: item.session_receipt}, (await config()).phone_key);
      }
      await chrome.scripting.executeScript({target: {tabId: source.tab_id, frameIds: [0]}, files: ['content.js']});
      const candidate = await chrome.tabs.sendMessage(source.tab_id, {type: message.type === 'snapshot' ? 'snapshot' : 'collect'}, {frameId: 0});
      if (candidate.origin !== source.origin) throw new Error('The source changed during capture.');
      if (item) await chrome.storage.session.set({snapshot: {session_id: item.id, source, prepared: prepareSnapshot(candidate, item.scope), request_id: item.disclosure_request?.id || null}});
      return {ok: true, ...candidate};
    }
    if (message.type === 'publish' || message.type === 'publish_auto') {
      const {source} = await chrome.storage.session.get('source'), settings = await config();
      const {sessions} = await call('sessions'), item = sessions.find(s => s.id === message.session_id);
      if (!item || item.status !== 'active' || !source) throw new Error('The session or source changed. Refresh and review again.');
      await verifySession({session_id: item.id, scope: item.scope, session_receipt: item.session_receipt}, settings.phone_key);
      let approved = message.view;
      if (message.type === 'publish_auto') {
        const {snapshot} = await chrome.storage.session.get('snapshot');
        if (item.scope.disclosure !== 'local_planner' || item.view || snapshot?.session_id !== item.id || canonical(snapshot.source) !== canonical(source) || snapshot.request_id !== (item.disclosure_request?.id || null)) throw new Error('The on-device plan is stale or was not approved for this session.');
        approved = selectedView(snapshot.prepared, item.scope, {allow: true, ids: message.ids}, {allow: true});
      }
      if (source.origin !== approved.origin || new URL((await chrome.tabs.get(source.tab_id)).url).origin !== approved.origin) throw new Error('The source website changed.');
      const response = await call('sessions/' + item.id + '/view', approved);
      await chrome.storage.session.set({binding: {session_id: item.id, tab_id: source.tab_id, view: response.view, view_digest: response.view_digest, fills: {}}});
      await chrome.storage.session.remove('snapshot');
      return {ok: true};
    }
    throw new Error('Unsupported extension operation.');
  })().then(respond).catch(error => respond({ok: false, error: error.message}));
  return true;
});
connect();
