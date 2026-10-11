import {deadline} from '../extension/deadline.mjs';

const fault = code => Object.assign(new Error(code), {code});
const transport = `globalThis.chrome ||= {};chrome.runtime ||= {id:'agentgate-hosted',onMessage:{addListener(f){(globalThis.__agentgateListeners ||= new Set()).add(f)},removeListener(f){globalThis.__agentgateListeners?.delete(f)}}};`;

export class HostedAdapter {
  constructor(browser, context, {scripts, modelUrl, store}) {
    Object.assign(this, {browser, context, scripts, modelUrl, store}); this.pages = new Map(); this.worlds = new Map();
  }
  async target(page) {
    const cdp = await this.context.newCDPSession(page);
    try { return (await cdp.send('Target.getTargetInfo')).targetInfo.targetId; }
    finally { await cdp.detach(); }
  }
  async recover() {
    for (const page of this.context.pages()) {
      if (page.url() === this.modelUrl) { this.modelPage = page; continue; }
      const id = await this.target(page); this.pages.set(id, page);
    }
  }
  async restore(profile) {
    if (!profile) return;
    await this.context.addCookies(profile.cookies || []);
    if (!profile.origins?.length) return;
    const page = await this.context.newPage(), id = await this.target(page);
    this.pages.set(id, page);
    try {
      // No website request or website script runs during profile restoration.
      await page.route('**/*', route => route.fulfill({contentType: 'text/html', body: '<!doctype html><title>Profile restore</title>'}));
      for (const origin of profile.origins) {
        await this.navigate(id, origin.origin);
        await this.evaluate(id, `(()=>{const module={};${this.scripts['storage-state.js']};return new (module.exports.StorageScript())(false).restore(${JSON.stringify(origin)});})()`);
      }
    } finally { await this.closeTab(id); }
  }
  page(id) { const page = this.pages.get(id); if (!page || page.isClosed()) throw fault('TAB_CLOSED'); return page; }
  async tab(id) { const page = this.page(id); return {id, url: page.url(), status: await page.evaluate(() => document.readyState === 'complete' ? 'complete' : 'loading')}; }
  async createTab(url) {
    const page = await this.context.newPage(), id = await this.target(page);
    this.pages.set(id, page);
    await this.navigate(id, url); return this.tab(id);
  }
  async navigate(id, url) {
    const parsed = new URL(url);
    if (!['http:', 'https:'].includes(parsed.protocol) || parsed.username || parsed.password) throw fault('OUT_OF_SCOPE');
    const page = this.page(id);
    // A navigation timeout can still leave a usable page. All later access checks
    // inspect the current origin and document readiness before capture.
    try { await page.goto(url, {waitUntil: 'domcontentloaded', timeout: 15000}); }
    catch (error) { if (error.name !== 'TimeoutError') throw fault('BROWSER_UNRESPONSIVE'); }
    this.worlds.delete(id);
    return this.tab(id);
  }
  async world(id) {
    const page = this.page(id), cached = this.worlds.get(id);
    const cdp = cached?.cdp || await this.context.newCDPSession(page);
    const {frameTree} = await cdp.send('Page.getFrameTree');
    const {executionContextId} = await cdp.send('Page.createIsolatedWorld', {frameId: frameTree.frame.id, worldName: 'agentgate-hosted'});
    this.worlds.set(id, {cdp, executionContextId});
    return {cdp, executionContextId};
  }
  async evaluate(id, expression) {
    const {cdp, executionContextId} = await this.world(id);
    const answer = await deadline(() => cdp.send('Runtime.evaluate', {expression, contextId: executionContextId, returnByValue: true, awaitPromise: true}), 15000, 'BROWSER_UNRESPONSIVE');
    if (answer.exceptionDetails) throw fault('BROWSER_UNRESPONSIVE');
    return answer.result.value;
  }
  async inject(id, files) {
    for (const file of files) {
      if (!Object.hasOwn(this.scripts, file)) throw fault('OUT_OF_SCOPE');
      await this.evaluate(id, transport + '\n' + this.scripts[file]);
    }
  }
  async message(id, message) {
    return this.evaluate(id, `new Promise((resolve,reject)=>{let handled=false;for(const f of globalThis.__agentgateListeners||[]){const result=f(${JSON.stringify(message)},{id:chrome.runtime.id},resolve);handled ||= result===true;}if(!globalThis.__agentgateListeners?.size)reject(new Error('Reader unavailable'));})`);
  }
  async modelRequest(message) {
    const page = this.modelPage;
    if (!page || page.isClosed() || page.url() !== this.modelUrl) throw fault('INFERENCE_UNAVAILABLE');
    return page.evaluate(async request => {
      const runtime = await globalThis.agentgatePurposeReady();
      if (runtime.model !== request.model) throw new Error('Classifier identity changed.');
      if (request.type === 'warmup') return {ok: true, model: runtime.model, financial_source_policy: runtime.financial_source_policy};
      const result = await runtime.classify(request.row);
      return {ok: true, ...result};
    }, message);
  }
  async warmup(model) {
    if (!this.modelPage || this.modelPage.isClosed()) {
      this.modelPage = await this.context.newPage();
      await this.modelPage.goto(this.modelUrl, {waitUntil: 'domcontentloaded', timeout: 15000});
    }
    return deadline(() => this.modelRequest({type: 'warmup', model}), 90000, 'MODEL_TIMEOUT');
  }
  async closeTab(id) {
    const page = this.pages.get(id); if (page && !page.isClosed()) await page.close();
    this.pages.delete(id); this.worlds.delete(id);
  }
  async loginState() { return this.context.storageState({indexedDB: true}); }
  async liveView(id) {
    const page = this.page(id), cdp = await this.context.newCDPSession(page);
    try { return (await cdp.send('Cloudflare.getLiveView', {mode: 'tab', expiresInMs: 60000})).devtoolsFrontendUrl; }
    finally { await cdp.detach(); }
  }
}
