import {auditStorageKey, pruneAudit} from './audit-log.mjs';
import {recordingBlob} from './recording-store.mjs';

const $ = id => document.getElementById(id);
let records = [];
let selectedId, recordingKey;
const videoUrls = new Set();
const stamp = value => value ? new Date(value).toLocaleString() : 'Unknown';
const line = (label, value) => { const row = document.createElement('p'); row.className = 'audit-line'; const name = document.createElement('strong'); name.textContent = label + ': '; row.append(name, document.createTextNode(String(value))); return row; };
const formatted = value => { const block = document.createElement('pre'); block.textContent = JSON.stringify(value, null, 2); return block; };

function eventTitle(event) {
  if (event.type === 'status') return 'Session ' + event.status;
  if (event.type === 'view') return 'View shared with assistant';
  if (event.type === 'dom_read') return 'Field read shared with assistant';
  if (event.type === 'action_check') return 'Action check: ' + event.decision;
  if (event.type === 'action') return 'Browser action: ' + (event.result?.ok ? 'dispatched' : 'failed');
  return event.type;
}

function clearVideoUrls() { for (const url of videoUrls) URL.revokeObjectURL(url); videoUrls.clear(); }
async function showRecordings(record, container) {
  const key = record.id + ':' + JSON.stringify(record.recordings || []);
  if (recordingKey === key) return;
  recordingKey = key;
  clearVideoUrls(); container.replaceChildren();
  const heading = document.createElement('h3'); heading.textContent = 'Session recording'; container.append(heading);
  if (!record.recordings?.length) { container.append(line('Recording', record.ended_at ? 'No video was saved for this session.' : 'Starts when the session opens its task tab.')); return; }
  for (const clip of record.recordings) {
    const item = document.createElement('div'); item.className = 'audit-clip'; container.append(item);
    if (clip.state === 'recording') { item.append(line('Recording', 'In progress · ' + stamp(clip.started_at))); continue; }
    let blob;
    try { blob = await recordingBlob(clip.id); } catch {}
    if (recordingKey !== key) return;
    if (!blob?.size) { item.append(line('Recording', 'Unavailable · ' + stamp(clip.started_at))); continue; }
    const url = URL.createObjectURL(blob); videoUrls.add(url);
    const video = document.createElement('video'); video.controls = true; video.preload = 'metadata'; video.src = url;
    video.setAttribute('aria-label', 'Recording of the session task tab');
    const download = document.createElement('a'); download.href = url; download.download = 'agentgate-' + record.id + '-' + clip.id + '.webm'; download.textContent = 'Download recording';
    item.append(video, line('Recorded', stamp(clip.started_at) + ' · ' + Math.ceil(((clip.ended_at || clip.updated_at) - clip.started_at) / 1000) + ' seconds'), download);
    if (clip.state !== 'complete') item.append(line('Recording', 'Interrupted; saved video is available above.'));
  }
}

function show(id) {
  const record = records.find(item => item.id === id), detail = $('detail');
  if (!record) { detail.replaceChildren(line('Session', 'Select a session to inspect its audit.')); clearVideoUrls(); selectedId = null; recordingKey = null; return; }
  if (selectedId !== id) {
    selectedId = id; recordingKey = null; clearVideoUrls(); detail.replaceChildren();
    for (const name of ['audit-summary', 'audit-recordings', 'audit-events']) { const container = document.createElement('div'); container.className = name; detail.append(container); }
  }
  const information = detail.querySelector('.audit-summary'); information.replaceChildren();
  const heading = document.createElement('h2'); heading.textContent = record.scope?.goal || 'Pending session'; information.append(heading);
  information.append(line('Session ID', record.id), line('Status', record.status), line('First seen', stamp(record.started_at)));
  if (record.ended_at) information.append(line('Ended', stamp(record.ended_at)));
  if (record.scope) {
    information.append(line('Websites', record.scope.origins.join(', ')), line('Permissions', record.scope.permissions.join(', ')), line('Disclosure', record.scope.disclosure || 'Legacy session'));
    if (record.scope.inference) information.append(line('Inference', record.scope.inference.provider + ' · ' + record.scope.inference.model));
  }
  showRecordings(record, detail.querySelector('.audit-recordings')).catch(() => {});
  const events = detail.querySelector('.audit-events'); events.replaceChildren();
  const title = document.createElement('h3'); title.textContent = 'Events'; events.append(title);
  if (!record.events.length) events.append(line('Events', 'None recorded yet.'));
  for (const event of record.events) {
    const item = document.createElement('details'); item.className = 'audit-event';
    const summary = document.createElement('summary'); summary.textContent = eventTitle(event) + ' · ' + stamp(event.at); item.append(summary);
    item.append(formatted(Object.fromEntries(Object.entries(event).filter(([key]) => !['id', 'type', 'at'].includes(key)))));
    events.append(item);
  }
  for (const button of $('sessions').querySelectorAll('button')) button.setAttribute('aria-current', String(button.dataset.id === id));
}

async function refresh() {
  const stored = (await chrome.storage.local.get(auditStorageKey))[auditStorageKey] || {};
  records = Object.values(pruneAudit(stored)).sort((a, b) => b.started_at - a.started_at);
  const list = $('sessions'); list.replaceChildren();
  if (!records.length) { const empty = document.createElement('p'); empty.textContent = 'No sessions recorded yet.'; list.append(empty); }
  for (const record of records) {
    const button = document.createElement('button'); button.className = 'secondary audit-session'; button.dataset.id = record.id;
    const title = document.createElement('strong'); title.textContent = record.scope?.goal || 'Pending session';
    const meta = document.createElement('span'); meta.textContent = record.status + ' · ' + stamp(record.started_at);
    button.append(title, meta); button.addEventListener('click', () => { location.hash = record.id; show(record.id); }); list.append(button);
  }
  const selected = location.hash.slice(1);
  show(records.some(record => record.id === selected) ? selected : records[0]?.id);
}

chrome.storage.onChanged.addListener((changes, area) => { if (area === 'local' && changes[auditStorageKey]) refresh().catch(() => {}); });
window.addEventListener('hashchange', () => show(location.hash.slice(1)));
window.addEventListener('pagehide', clearVideoUrls);
await refresh();
