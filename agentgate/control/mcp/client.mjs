import {EnvHttpProxyAgent, fetch} from 'undici';
export class Client {
  constructor(url = process.env.AGENTGATE_URL, token = process.env.AGENTGATE_AGENT_TOKEN) {
    if (!url || !token) throw new Error('Set AGENTGATE_URL and the agent-role AGENTGATE_AGENT_TOKEN.');
    const parsed = new URL(url);
    if (parsed.username || parsed.password || parsed.search || parsed.hash || (parsed.protocol !== 'https:' && !(parsed.protocol === 'http:' && ['127.0.0.1', 'localhost', 'host.docker.internal'].includes(parsed.hostname)))) throw new Error('Use HTTPS, or the local development coordinator.');
    this.url = parsed.origin; this.token = token;
    this.dispatcher = process.env.HTTPS_PROXY || process.env.HTTP_PROXY ? new EnvHttpProxyAgent() : undefined;
  }
  async call(path, data) {
    const response = await fetch(this.url + '/api/agent/' + path, {method: data === undefined ? 'GET' : 'POST', headers: {Authorization: 'Bearer ' + this.token, 'Content-Type': 'application/json'}, ...(data !== undefined ? {body: JSON.stringify(data)} : {}), signal: AbortSignal.timeout(15000), redirect: 'error', dispatcher: this.dispatcher});
    const result = await response.json(); if (!response.ok) { const error = new Error(result.error?.message || 'The coordinator rejected the request.'); error.code = result.error?.code; throw error; } return result;
  }
}
