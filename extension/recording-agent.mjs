import {saveClip, saveChunk} from './recording-store.mjs';

const recordings = new Map();
const completed = new Map();
const notify = clip => chrome.runtime.sendMessage({target: 'recording_update', clip}).catch(() => {});
async function finish(id, state = 'complete') {
  const recording = recordings.get(id);
  if (!recording) return completed.get(id);
  if (recording.finishing) return recording.finishing;
  recording.finishing = (async () => {
    clearTimeout(recording.expiry);
    await recording.frames.catch(() => {});
    await new Promise(resolve => {
      if (recording.recorder.state === 'inactive') return resolve();
      recording.recorder.addEventListener('stop', resolve, {once: true});
      recording.recorder.stop();
    });
    for (const track of recording.stream.getTracks()) track.stop();
    await recording.writes.catch(() => { state = 'failed'; });
    const clip = {...recording.clip, state, ended_at: Date.now(), bytes: recording.bytes};
    recordings.delete(id);
    await saveClip(clip);
    completed.set(id, clip);
    if (completed.size > 100) completed.delete(completed.keys().next().value);
    notify(clip);
    return clip;
  })();
  return recording.finishing;
}
async function start(message) {
  if (recordings.has(message.session_id)) return recordings.get(message.session_id).clip;
  completed.delete(message.session_id);
  const canvas = document.createElement('canvas'); canvas.width = 1280; canvas.height = 900;
  const context = canvas.getContext('2d', {alpha: false});
  context.fillStyle = '#0d1117'; context.fillRect(0, 0, canvas.width, canvas.height);
  const stream = canvas.captureStream(0);
  const mime = ['video/webm;codecs=vp8', 'video/webm'].find(type => MediaRecorder.isTypeSupported(type));
  if (!mime) throw new Error('Video recording is unavailable.');
  const recorder = new MediaRecorder(stream, {mimeType: mime, videoBitsPerSecond: 1200000});
  const clip = {id: crypto.randomUUID(), session_id: message.session_id, started_at: Date.now(), expires_at: message.expires_at, state: 'recording', mime, bytes: 0};
  const recording = {clip, canvas, context, stream, recorder, frames: Promise.resolve(), writes: Promise.resolve(), sequence: 0, bytes: 0};
  await saveClip(clip);
  recorder.addEventListener('dataavailable', event => {
    if (!event.data.size) return;
    const sequence = recording.sequence++;
    recording.bytes += event.data.size;
    recording.writes = recording.writes.then(async () => {
      await saveChunk(clip.id, sequence, event.data);
      await saveClip({...clip, bytes: recording.bytes, updated_at: Date.now()});
    });
    recording.writes.catch(() => finish(message.session_id, 'failed').catch(() => {}));
  });
  recorder.addEventListener('error', () => finish(message.session_id, 'failed').catch(() => {}));
  recordings.set(message.session_id, recording);
  recording.expiry = setTimeout(() => finish(message.session_id).catch(() => {}), Math.max(0, message.expires_at - Date.now()));
  recorder.start(1000);
  return clip;
}
async function frame(message) {
  const recording = recordings.get(message.session_id);
  if (!recording || recording.finishing) return;
  recording.frames = recording.frames.then(async () => {
    if (!message.data) {
      recording.context.fillStyle = '#0d1117'; recording.context.fillRect(0, 0, recording.canvas.width, recording.canvas.height);
      recording.context.fillStyle = '#dce6ee'; recording.context.font = '24px sans-serif';
      recording.context.fillText(message.loading ? 'Task tab loading…' : 'Recording paused outside the approved websites.', 48, 100);
      recording.stream.getVideoTracks()[0].requestFrame();
      return;
    }
    const response = await fetch('data:image/jpeg;base64,' + message.data);
    const bitmap = await createImageBitmap(await response.blob());
    const {canvas, context} = recording;
    const scale = Math.min(canvas.width / bitmap.width, canvas.height / bitmap.height);
    const width = bitmap.width * scale, height = bitmap.height * scale;
    context.fillStyle = '#0d1117'; context.fillRect(0, 0, canvas.width, canvas.height);
    context.drawImage(bitmap, (canvas.width - width) / 2, (canvas.height - height) / 2, width, height);
    bitmap.close();
    recording.stream.getVideoTracks()[0].requestFrame();
  });
  await recording.frames;
}
chrome.runtime.onMessage.addListener((message, sender, respond) => {
  if (sender.id !== chrome.runtime.id || sender.tab || message.target !== 'session_recording') return false;
  (async () => {
    if (!/^[a-f0-9]{32}$/.test(message.session_id || '')) throw new Error('Unknown session.');
    if (message.type === 'start' && Number.isSafeInteger(message.expires_at) && message.expires_at > Date.now() && message.expires_at <= Date.now() + 600000) return {ok: true, clip: await start(message)};
    if (message.type === 'frame') { await frame(message); return {ok: true}; }
    if (message.type === 'stop') return {ok: true, clip: await finish(message.session_id, message.state)};
    throw new Error('Unknown recording operation.');
  })().then(respond, error => { console.error('AgentGate recording operation failed:', error.message); respond({ok: false}); });
  return true;
});
