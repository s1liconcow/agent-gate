let opening;
function database() {
  opening ||= new Promise((resolve, reject) => {
    const request = indexedDB.open('agentgate-session-recordings', 1);
    request.onupgradeneeded = () => {
      request.result.createObjectStore('clips', {keyPath: 'id'});
      request.result.createObjectStore('chunks', {keyPath: ['clip_id', 'sequence']}).createIndex('clip_id', 'clip_id');
    };
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => { opening = null; reject(request.error); };
  });
  return opening;
}
async function transaction(stores, mode, operation) {
  const db = await database();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(stores, mode);
    const result = operation(tx);
    tx.oncomplete = () => resolve(result?.result);
    tx.onerror = tx.onabort = () => reject(tx.error || new Error('Recording storage failed.'));
  });
}
export const saveClip = clip => transaction(['clips'], 'readwrite', tx => tx.objectStore('clips').put(clip));
export const saveChunk = (clip_id, sequence, blob) => transaction(['chunks'], 'readwrite', tx => tx.objectStore('chunks').put({clip_id, sequence, blob}));
export const listClips = () => transaction(['clips'], 'readonly', tx => tx.objectStore('clips').getAll());
export async function recordingBlob(id) {
  const [clip, chunks] = await Promise.all([
    transaction(['clips'], 'readonly', tx => tx.objectStore('clips').get(id)),
    transaction(['chunks'], 'readonly', tx => tx.objectStore('chunks').index('clip_id').getAll(id))
  ]);
  if (!clip || !chunks.length) return null;
  return new Blob(chunks.sort((a, b) => a.sequence - b.sequence).map(chunk => chunk.blob), {type: clip.mime});
}
export async function recoverRecordings(now = Date.now()) {
  const interrupted = (await listClips()).filter(clip => clip.state === 'recording' && (clip.expires_at || clip.started_at + 600000) <= now).map(clip => ({...clip, state: 'interrupted', ended_at: clip.updated_at || clip.started_at}));
  for (const clip of interrupted) await saveClip(clip);
  return interrupted;
}
export async function pruneRecordings(sessionIds, expiredIds = []) {
  const keep = new Set(sessionIds);
  const expired = new Set(expiredIds);
  const removed = (await listClips()).filter(clip => expired.has(clip.session_id) || !keep.has(clip.session_id) && Date.now() - (clip.ended_at || clip.updated_at || clip.started_at) >= 30 * 86400000).map(clip => clip.id);
  if (!removed.length) return;
  await transaction(['clips', 'chunks'], 'readwrite', tx => {
    for (const id of removed) {
      tx.objectStore('clips').delete(id);
      const cursor = tx.objectStore('chunks').index('clip_id').openKeyCursor(id);
      cursor.onsuccess = () => {
        const item = cursor.result;
        if (item) { tx.objectStore('chunks').delete(item.primaryKey); item.continue(); }
      };
    }
  });
}
