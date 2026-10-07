import {action, automaticActionAllowed, canonical, checksActionPurpose, digest, exact, coordinator, scope, needsApproval, stagedFields, verifyReceipt} from './protocol.mjs';
import {openPairing, pairingChallenge} from './browser-pairing.mjs';
import {AutomaticBrowser} from './automatic.mjs';
import {localModel} from './model-host.mjs';
import {inferenceSettings, inferencePresentation, saveInference, testInference} from './inference-settings.mjs';
import {auditActiveSessions, auditConnectionEnded, auditEvent, auditPrune, auditRecording, auditStatuses} from './audit-log.mjs';
import {SessionRecordings} from './session-recording.mjs';
import {CheckoutRunner} from './checkout-runner.mjs';
const ready = Promise.all([chrome.storage.local.setAccessLevel({accessLevel: 'TRUSTED_CONTEXTS'}), chrome.storage.session.setAccessLevel({accessLevel: 'TRUSTED_CONTEXTS'}), chrome.storage.session.remove(['source', 'binding', 'snapshot'])]);
let socket, heartbeat, reconnectTimer, queue = Promise.resolve(), pairingQueue = Promise.resolve();
const leases = new Map();
const recordings = new SessionRecordings({audit: auditRecording});
const automatic = new AutomaticBrowser({call, config, verifySession, audit: auditEvent, recordings});
const checkout = new CheckoutRunner({call, config, verifySession, recordings});
async function config() { await ready; return (await chrome.storage.local.get('settings')).settings; }
async function forget(settings) {
  if ((await config())?.bridge_token !== settings.bridge_token) return;
  clearTimeout(reconnectTimer); clearInterval(heartbeat);
  if (socket) { socket.onclose = null; socket.close(); socket = null; }
  await recordings.stopAll();
  await auditConnectionEnded();
  await chrome.storage.local.remove('settings'); await chrome.storage.session.remove(['binding', 'bindings', 'agent_tabs', 'guarded', 'snapshot', 'checkout_bindings']); leases.clear();
  await automatic.activity.clear();
}
async function call(path, value) {
  const settings = await config(); if (!settings) throw new Error('Pair the desktop bridge first.');
  const response = await fetch(settings.url + '/api/bridge/' + path, {method: value === undefined ? 'GET' : 'POST', headers: {'Content-Type': 'application/json', Authorization: 'Bearer ' + settings.bridge_token, 'X-AgentGate-Extension': 'chrome-extension://' + chrome.runtime.id}, ...(value !== undefined ? {body: JSON.stringify(value)} : {}), redirect: 'error', cache: 'no-store', signal: AbortSignal.timeout(15000)});
  const result = await response.json(); if (!response.ok) { if (response.status === 403) await forget(settings); throw new Error(result.error?.message || 'The coordinator rejected the request.'); }
  if (path === 'sessions' && value === undefined) auditActiveSessions(result.sessions);
  const published = path.match(/^sessions\/([a-f0-9]{32})\/(view|dom)$/);
  if (published?.[2] === 'view' && result.view) auditEvent(published[1], {id: 'view:' + result.view_digest + ':' + (result.disclosure_request?.id || Date.now()), type: 'view', view: result.view, view_digest: result.view_digest});
  if (published?.[2] === 'dom' && value?.request_id && result.dom_access) auditEvent(published[1], {id: 'dom:' + value.request_id, type: 'dom_read', access: result.dom_access});
  return result;
}
const secret = () => [...crypto.getRandomValues(new Uint8Array(32))].map(n => n.toString(16).padStart(2, '0')).join('');
async function pairingCall(pending, path, value) {
  const response = await fetch(pending.url + '/api/browser/pairings' + path, {method: value === undefined ? 'GET' : 'POST', headers: {'Content-Type': 'application/json', Authorization: 'Bearer ' + pending.credential, 'X-AgentGate-Extension': 'chrome-extension://' + chrome.runtime.id}, ...(value !== undefined ? {body: JSON.stringify(value)} : {}), redirect: 'error', cache: 'no-store', signal: AbortSignal.timeout(15000)});
  const result = await response.json(); if (!response.ok) throw new Error(result.error?.message || 'Browser pairing failed.'); return result;
}
function pairingPresentation(pending) { return {id: pending.item.id, expires_at: pending.item.expires_at, qr_url: pending.url + '/#browser=' + pending.item.id + '&secret=' + pending.secret}; }
async function startPairing(url, name) {
  const pending = {url: coordinator(url), secret: secret(), credential: secret()};
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
  let auditTarget = null;
  try {
    const settings = await config(); await verifySession(packet, settings.phone_key);
    if (command.deadline <= Date.now()) throw new Error('Command expired.');
    const packetDigest = await digest(packet), {dispatches = {}} = await chrome.storage.local.get('dispatches');
    if (dispatches[command.id]) {
      if (dispatches[command.id].packet_digest !== packetDigest) throw new Error('A command identifier was reused with changed authorization.');
      result = dispatches[command.id].result || result;
      await auditEvent(id, {id: 'action:' + command.id, type: 'action', action: command.action, target: null, requires_approval: command.requires_approval, result});
      if (socket?.readyState === WebSocket.OPEN) socket.send(JSON.stringify({session_id: id, result}));
      return;
    }
    const {bindings = {}, agent_tabs = {}} = await chrome.storage.session.get(['bindings', 'agent_tabs']);
    const binding = bindings[id], record = agent_tabs[id];
    if (!binding || binding.session_id !== id || command.view_digest !== binding.view_digest || record?.current !== binding.tab_id || !record.ids.includes(binding.tab_id)) throw new Error('Wait for the automatic task view.');
    const {automation} = await chrome.storage.local.get('automation');
    if (!(packet.scope.disclosure === 'bounded' ? automation?.grants_enabled ?? automation?.enabled : automation?.enabled)) throw new Error('Automatic task execution is paused.');
    const approvedAction = action(command.action, packet.scope, binding.view);
    auditTarget = binding.view.controls.find(control => control.ref === approvedAction.ref) || null;
    if (checksActionPurpose(packet.scope)) { if (!await automatic.allowed(packet)) throw new Error('No matching local purpose approval.'); }
    else if (command.requires_approval !== needsApproval(approvedAction, binding.view, packet.scope)) throw new Error('The action approval policy changed.');
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
      if (packet.scope.interaction === 'automatic' && checksActionPurpose(packet.scope)) {
        const committed = Object.values(dispatches).filter(claim => claim.session_id === id).reduce((total, claim) => total + (claim.payment_cents || 0), 0);
        if (!automaticActionAllowed(packet.scope, command) || committed + command.payment_cents > (packet.scope.action_policy?.payment_limit_cents || 0)) throw new Error('The action exceeds the signed communications or payment allowance.');
      }
      // Persist the claim BEFORE touching the page. An interrupted claim is never replayed.
      dispatches[command.id] = {at: Date.now(), packet_digest: packetDigest, session_id: id, payment_cents: command.payment_cents || 0};
      for (const [key, value] of Object.entries(dispatches)) if (Date.now() - value.at > 86400000) delete dispatches[key];
      await chrome.storage.local.set({dispatches});
      if (['navigate', 'open_tab'].includes(approvedAction.type)) {
        const destination = new URL(approvedAction.url).origin;
        if (destination.startsWith('https:') && !await chrome.permissions.contains({origins: [destination + '/*']})) throw new Error('The approved website needs its setup permission.');
        if (approvedAction.type === 'open_tab') {
          if (record.ids.length >= 5) throw new Error('The task cannot open another tab.');
          const opened = await chrome.tabs.create({url: approvedAction.url, active: false});
          record.ids.push(opened.id); record.current = opened.id; await chrome.storage.session.set({agent_tabs});
          await recordings.start({...packet, id}, opened.id);
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
        bindings[id] = binding; await chrome.storage.session.set({bindings});
      } else if (approvedAction.type !== 'fill') {
        delete bindings[id]; await chrome.storage.session.set({bindings});
      }
    }
  } catch (error) { await chrome.storage.session.set({last_error: error.message}); /* Local diagnostics never enter an agent result. */ }
  if (result.command_id) await auditEvent(id, {id: 'action:' + command.id, type: 'action', action: command.action, target: auditTarget, requires_approval: command.requires_approval, result});
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
    socket.onopen = () => {
      socket.send('ready'); heartbeat = setInterval(() => { if (socket?.readyState === WebSocket.OPEN) socket.send('ping'); }, 20000);
      // Resume owned task recordings when the worker restarts or reconnects.
      (async () => {
        const {agent_tabs = {}} = await chrome.storage.session.get('agent_tabs');
        if (!Object.keys(agent_tabs).length) return;
        const {sessions} = await call('sessions');
        for (const item of sessions) if (agent_tabs[item.id] && !item.checkout) {
          await verifySession({session_id: item.id, scope: item.scope, session_receipt: item.session_receipt}, settings.phone_key);
          await recordings.start(item, agent_tabs[item.id].current);
        }
      })().catch(() => {});
    };
    socket.onmessage = event => {
      if (event.data === 'pong') return;
      try {
        const packet = JSON.parse(event.data);
        queue = queue.then(async () => {
          await automatic.stop(packet.sessions);
          await checkout.stop(packet.sessions);
          for (const check of packet.checks || []) await automatic.check(check);
          for (const command of packet.commands || []) await execute(command);
          for (const handoff of packet.checkouts || []) await checkout.run(handoff);
          automatic.tick().catch(() => {});
          auditStatuses(packet.sessions);
        }).catch(() => {});
      } catch { socket.close(); }
    };
    socket.onclose = event => { clearInterval(heartbeat); automatic.activity.pause(); if (event.code === 4001) { forget(settings).catch(() => {}); } else reconnectTimer = setTimeout(connect, 5000); };
    socket.onerror = () => socket.close();
  } catch { reconnectTimer = setTimeout(connect, 5000); }
}
chrome.alarms.create('agentgate-reconnect', {periodInMinutes: 1});
chrome.alarms.create('agentgate-audit-prune', {periodInMinutes: 1440});
chrome.alarms.onAlarm.addListener(alarm => {
  if (alarm.name === 'agentgate-audit-prune') { auditPrune(); return; }
  connect(); automatic.tick().catch(() => {});
});
setInterval(() => { automatic.activity.expire(); automatic.tick().catch(() => {}); }, 5000);
chrome.tabs.onUpdated.addListener((tabId, change) => { if (change.status === 'complete') automatic.activity.loaded(tabId); });
chrome.debugger.onDetach.addListener(source => recordings.detached(source.tabId));
automatic.activity.initialize();
chrome.action.onClicked.addListener(async () => {
  await ready;
  await chrome.tabs.create({url: chrome.runtime.getURL('review.html')});
});
chrome.runtime.onMessage.addListener((message, sender, respond) => {
  if (sender.id === chrome.runtime.id && !sender.tab && sender.url === chrome.runtime.getURL('local-agent.html') && message.target === 'recording_update') {
    const clip = message.clip;
    if (clip?.session_id) auditRecording(clip.session_id, clip);
    return false;
  }
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
      await chrome.storage.local.set({automation: {enabled: true,grants_enabled:true}}); automatic.tick().catch(() => {}); return {ok: true};
    }
    if(message.type==='set_granted_reads') {
      if(typeof message.enabled!=='boolean')throw new Error('Choose whether approved field reads may run.');
      if(message.enabled&&!await chrome.permissions.contains({origins:['https://*/*']}))throw new Error('Grant website access once in setup.');
      const {automation={enabled:false}}=await chrome.storage.local.get('automation');
      await chrome.storage.local.set({automation:{...automation,grants_enabled:message.enabled}});
      automatic.tick().catch(()=>{});return {ok:true};
    }
    if (message.type === 'disable_automation') { await chrome.storage.local.set({automation: {enabled: false,grants_enabled:false}}); await automatic.activity.pause(); return {ok: true}; }
    if (message.type === 'sessions') return {ok: true, ...await call('sessions')};
    throw new Error('Unsupported extension operation.');
  })().then(respond).catch(error => respond({ok: false, error: error.message}));
  return true;
});
connect();
auditPrune();
