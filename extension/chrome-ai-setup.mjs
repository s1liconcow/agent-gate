import {abortable, deadline, dispose} from './deadline.mjs';

const options = {expectedInputs: [{type: 'text', languages: ['en']}], expectedOutputs: [{type: 'text', languages: ['en']}]};

// Run from the provider selection event: Chrome needs user activation to
// download its model. Background tasks only use an already prepared model.
export async function prepareChromeAI({api = globalThis.LanguageModel, progress = () => {}, milliseconds = 300000} = {}) {
  return deadline(async signal => {
    const availability = api ? await abortable(() => api.availability(options), signal) : 'unavailable';
    if (!['available', 'downloadable', 'downloading'].includes(availability)) {
      const error = new Error('Chrome AI is unavailable on this browser or device. Choose another AI provider.');
      error.code = 'MODEL_UNAVAILABLE';
      throw error;
    }
    let session;
    try {
      session = await abortable(() => api.create({...options, signal, monitor: monitor => {
        monitor.addEventListener('downloadprogress', event => {
          if (!signal.aborted && Number.isFinite(event.loaded)) progress(Math.max(0, Math.min(1, event.loaded)));
        });
      }}), signal, dispose);
    } finally { dispose(session); }
  }, milliseconds);
}
