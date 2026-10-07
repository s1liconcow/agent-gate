import {inferenceProfile} from './protocol.mjs';
import {abortable, deadline} from './deadline.mjs';

export const remoteCodes = ['INFERENCE_CONFIG_CHANGED', 'INFERENCE_AUTH_FAILED', 'INFERENCE_RATE_LIMITED', 'INFERENCE_UNAVAILABLE', 'INFERENCE_NOT_APPROVED'];
export function inferenceError(code = 'INFERENCE_UNAVAILABLE') {
  const messages = {
    INFERENCE_CONFIG_CHANGED: 'Inference settings changed. Request a fresh phone-approved session.',
    INFERENCE_AUTH_FAILED: 'The inference provider rejected the API key. Update it in extension setup.',
    INFERENCE_RATE_LIMITED: 'The inference provider is rate limited or out of quota.',
    INFERENCE_UNAVAILABLE: 'The inference provider could not complete a valid JSON response. Check endpoint, model and response format.',
    INFERENCE_NOT_APPROVED: 'This inference request no longer has matching phone approval.'
  };
  const error = new Error(messages[code] || messages.INFERENCE_UNAVAILABLE); error.code = code; return error;
}
export async function boundedJson(response, signal) {
  const reader = response.body?.getReader(); if (!reader) throw inferenceError();
  const chunks = []; let size = 0;
  try {
    for (;;) {
      const {value, done} = await abortable(() => reader.read(), signal);
      if (done) break;
      size += value.length; if (size > 65536) throw inferenceError(); chunks.push(value);
    }
    const bytes = new Uint8Array(size); let at = 0;
    for (const chunk of chunks) { bytes.set(chunk, at); at += chunk.length; }
    return JSON.parse(new TextDecoder().decode(bytes));
  } finally { await reader.cancel().catch(() => {}); }
}

// LanguageModel facade: only planner-prepared JSON reaches this transport. Each
// clone is a fresh stateless request, preserving the same source-ID checks as Nano.
export function remoteModelAPI(settings, {fetcher = globalThis.fetch, authorize = async () => {}, milliseconds = 30000} = {}) {
  const profile = inferenceProfile(settings.profile), apiKey = settings.api_key;
  if (['openjev','purpose_encoder','purpose_browser'].includes(profile.provider)) throw inferenceError();
  // Live synthetic evaluation found false approvals for unrelated browser actions.
  // Keep saved profiles recognizable so owners can switch away, but fail closed.
  if (profile.provider === 'cloudflare') throw inferenceError();
  if (typeof apiKey !== 'string' || !apiKey.length || apiKey.length > 4096 || /\s/.test(apiKey)) throw inferenceError('INFERENCE_AUTH_FAILED');
  const session = (system, lifetime) => {
    let destroyed = false;
    return {
      async clone({signal} = {}) { signal?.throwIfAborted(); if (destroyed) throw inferenceError(); return session(system, signal); },
      destroy() { destroyed = true; },
      async prompt(input, {responseConstraint, signal = lifetime} = {}) {
        if (destroyed || typeof input !== 'string' || input.length > 100000 || !responseConstraint) throw inferenceError();
        return deadline(async timeout => {
          const combined = signal ? AbortSignal.any([signal, timeout]) : timeout;
          combined.throwIfAborted();
          await abortable(authorize, combined);
          combined.throwIfAborted(); if (destroyed) throw inferenceError();
          const anthropic = profile.provider === 'anthropic';
          // Anthropic does not support maxItems. The source validator still
          // enforces the original 32-ID limit after the response is received.
          const schema = structuredClone(responseConstraint);
          if (anthropic && schema.properties?.ids) delete schema.properties.ids.maxItems;
          const headers = {'Content-Type': 'application/json', ...(anthropic ? {'x-api-key': apiKey, 'anthropic-version': '2023-06-01', 'anthropic-dangerous-direct-browser-access': 'true'} : {Authorization: 'Bearer ' + apiKey})};
          const body = anthropic ? {
            model: profile.model, max_tokens: 2048, system,
            messages: [{role: 'user', content: input}],
            output_config: {format: {type: 'json_schema', schema}}
          } : {
            model: profile.model, ...(profile.provider === 'openai' ? {max_completion_tokens: 2048, store: false} : {max_tokens: 2048}),
            messages: [{role: 'system', content: system + (['json', 'prompt_json'].includes(profile.format) ? '\nReturn only JSON matching this schema: ' + JSON.stringify(responseConstraint) : '')}, {role: 'user', content: input}],
            ...(profile.format === 'prompt_json' ? {temperature: 0} : {response_format: profile.format === 'json' ? {type: 'json_object'} : {type: 'json_schema', json_schema: {name: 'agentgate_decision', strict: true, schema: responseConstraint}}})
          };
          try {
            const response = await abortable(() => fetcher(profile.endpoint, {method: 'POST', headers, body: JSON.stringify(body), credentials: 'omit', redirect: 'error', cache: 'no-store', referrerPolicy: 'no-referrer', signal: combined}), combined);
            if (!response.ok) {
              // Do not read or propagate provider errors: they can echo secrets/content.
              response.body?.cancel().catch(() => {});
              throw inferenceError([401, 403].includes(response.status) ? 'INFERENCE_AUTH_FAILED' : response.status === 429 ? 'INFERENCE_RATE_LIMITED' : 'INFERENCE_UNAVAILABLE');
            }
            const result = await boundedJson(response, combined);
            let output;
            if (anthropic) {
              if (result.stop_reason !== 'end_turn' || !Array.isArray(result.content) || result.content.length !== 1 || result.content[0]?.type !== 'text') throw inferenceError();
              output = result.content[0].text;
            } else {
              if (result.choices?.length !== 1 || result.choices[0].finish_reason !== 'stop' || result.choices[0].message?.refusal || result.choices[0].message?.tool_calls) throw inferenceError();
              output = result.choices[0].message?.content;
            }
            if (typeof output !== 'string' || output.length > 8000) throw inferenceError();
            const decision = JSON.parse(output);
            if (!decision || typeof decision !== 'object' || Array.isArray(decision)) throw inferenceError();
            return output;
          } catch (error) {
            if (combined.aborted) throw combined.reason;
            if (remoteCodes.includes(error.code)) throw error;
            throw inferenceError();
          }
        }, milliseconds);
      }
    };
  };
  return {remote: true, availability: async () => 'available', create: async ({initialPrompts, signal}) => { signal?.throwIfAborted(); return session(initialPrompts[0].content, signal); }};
}
