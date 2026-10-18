import {deadline} from '../extension/deadline.mjs';
import {executionError} from '../shared/bridge-result.mjs';

const fault = (code, execution_error) => Object.assign(new Error(code), {code, ...(execution_error ? {execution_error} : {})});
const transport = `globalThis.chrome ||= {};chrome.runtime ||= {id:'agentgate-hosted',onMessage:{addListener(f){(globalThis.__agentgateListeners ||= new Set()).add(f)},removeListener(f){globalThis.__agentgateListeners?.delete(f)}}};`;

export async function hostedTarget(context, page, milliseconds = 15000) {
  // Cloudflare runs both Playwright sides in this Worker and already knows the
  // target. Its own SDK uses toImpl to access these in-process objects. Avoid a
  // second protocol attachment just to recover an existing target identifier.
  if (typeof page._connection?.toImpl === 'function') {
    const id = page._connection.toImpl(page)?.delegate?._targetId;
    if (typeof id !== 'string' || !id) throw fault('BROWSER_UNRESPONSIVE', 'TRANSPORT_FAILED');
    return id;
  }
  return deadline(async () => {
    const cdp = await context.newCDPSession(page);
    try { return (await cdp.send('Target.getTargetInfo')).targetInfo.targetId; }
    finally { await cdp.detach(); }
  }, milliseconds, 'BROWSER_UNRESPONSIVE');
}

export class HostedAdapter {
  constructor(browser, context, {scripts, anchorId, store, operationMilliseconds = 15000}) {
    Object.assign(this, {browser, context, scripts, anchorId, store, operationMilliseconds}); this.pages = new Map(); this.worlds = new Map();
  }
  async target(page) {
    return hostedTarget(this.context, page, this.operationMilliseconds);
  }
  async recover() {
    for (const page of this.context.pages()) {
      const id = await this.target(page);
      if (id === this.anchorId) { this.anchorPage = page; continue; }
      this.pages.set(id, page);
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
  async tab(id) { const page = this.page(id); return {id, url: page.url(), status: await deadline(() => page.evaluate(() => document.readyState === 'complete' ? 'complete' : 'loading'), this.operationMilliseconds, 'BROWSER_UNRESPONSIVE')}; }
  async createTab(url) {
    const page = await deadline(signal => this.context.newPage().then(async page => {
      if (signal.aborted) { await page.close().catch(() => {}); throw signal.reason; }
      return page;
    }), this.operationMilliseconds, 'BROWSER_UNRESPONSIVE');
    let id;
    try {
      id = await this.target(page);
      this.pages.set(id, page);
      await this.navigate(id, url); return await this.tab(id);
    } catch (error) {
      if (id) this.pages.delete(id);
      await deadline(() => page.close(), this.operationMilliseconds, 'BROWSER_UNRESPONSIVE').catch(() => {});
      throw error;
    }
  }
  async navigate(id, url) {
    const parsed = new URL(url);
    if (!['http:', 'https:'].includes(parsed.protocol) || parsed.username || parsed.password) throw fault('OUT_OF_SCOPE');
    const page = this.page(id);
    // A navigation timeout can still leave a usable page. All later access checks
    // inspect the current origin and document readiness before capture.
    try { await page.goto(url, {waitUntil: 'domcontentloaded', timeout: 15000}); }
    catch (error) { if (error.name !== 'TimeoutError') throw Object.assign(fault('BROWSER_UNRESPONSIVE', executionError(error)), {phase: 'opening_tab'}); }
    const world = this.worlds.get(id); if (world) world.executionContextId = null;
    return this.tab(id);
  }
  async world(id) {
    const page = this.page(id);
    let world = this.worlds.get(id);
    if (!world) {
      const cdp = await this.context.newCDPSession(page);
      world = {cdp, executionContextId: null}; this.worlds.set(id, world);
      cdp.on('Runtime.executionContextDestroyed', ({executionContextId}) => { if (world.executionContextId === executionContextId) world.executionContextId = null; });
      cdp.on('Runtime.executionContextsCleared', () => { world.executionContextId = null; });
      await cdp.send('Runtime.enable');
    }
    if (world.executionContextId === null) {
      const {frameTree} = await world.cdp.send('Page.getFrameTree');
      // Names do not guarantee that createIsolatedWorld returns the same world.
      // Captured refs belong to this exact context until Chrome destroys it.
      const {executionContextId} = await world.cdp.send('Page.createIsolatedWorld', {frameId: frameTree.frame.id, worldName: 'agentgate-hosted'});
      world.executionContextId = executionContextId;
    }
    return world;
  }
  async evaluate(id, expression) {
    const {cdp, executionContextId} = await this.world(id);
    let answer;
    try { answer = await deadline(() => cdp.send('Runtime.evaluate', {expression, contextId: executionContextId, returnByValue: true, awaitPromise: true}), 15000, 'BROWSER_UNRESPONSIVE'); }
    catch { this.worlds.delete(id); throw fault('BROWSER_UNRESPONSIVE', 'TRANSPORT_FAILED'); }
    if (answer.exceptionDetails) throw fault('BROWSER_UNRESPONSIVE', /Reader unavailable/.test(answer.exceptionDetails.exception?.description || '') ? 'READER_UNAVAILABLE' : 'EVALUATION_FAILED');
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
