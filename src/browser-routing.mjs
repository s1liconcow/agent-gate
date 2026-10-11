import {fail} from '../shared/protocol.mjs';

export class BrowserRouting {
  constructor(storage, now = Date.now) { this.db = storage; this.now = now; }
  async choices() {
    const hosted = await this.db.get('hosted:consent'), records = await this.db.list({prefix: 'browser:'});
    return [...records.values()].filter(item => item.status === 'active' && item.expires_at > this.now() &&
      (item.kind !== 'hosted' || hosted?.browser_id === item.id && hosted.expires_at > this.now()))
      .map(item => ({id: item.id, name: item.name, kind: item.kind === 'hosted' ? 'cloud' : 'local'}))
      .sort((a, b) => (a.kind === 'cloud' ? 0 : 1) - (b.kind === 'cloud' ? 0 : 1));
  }
  async current() {
    const choices = await this.choices(), saved = await this.db.get('default_browser_id');
    return choices.find(item => item.id === saved) || choices[0] || null;
  }
  async select(id) {
    const item = (await this.choices()).find(item => item.id === id);
    if (!item) fail('BROWSER_UNAVAILABLE', 'Connect this browser before selecting it.', 409);
    return item;
  }
  async choose(kind, id) {
    if (!['local', 'cloud'].includes(kind)) fail('BROWSER_SELECTION_REQUIRED', 'Explicitly select browser=local or browser=cloud.');
    const choices = (await this.choices()).filter(item => item.kind === kind);
    if (id) { const selected = choices.find(item => item.id === id); if (selected) return selected; }
    else {
      const current = await this.current();
      if (current?.kind === kind) return current;
      if (choices.length === 1) return choices[0];
    }
    fail('BROWSER_SELECTION_REQUIRED', choices.length ? 'Select the connected local classifier device explicitly.' : 'Connect the explicitly selected browser; AgentGate will not switch browsers.', 409);
  }
  async setDefault(id) { await this.select(id); await this.db.put('default_browser_id', id); }
  async sessionBrowser(item) {
    if (item.task.browser_id || item.browser_id) return item.task.browser_id || item.browser_id;
    // Preserve sessions created by the single-browser coordinator during upgrade.
    const previous = await this.db.get('inference_profile');
    return previous?.browser_id || (await this.current())?.id || 'legacy';
  }
  async owns(item, id) { return await this.sessionBrowser(item) === id; }
  async pinSessions(items) {
    for (const item of items) if (!item.task.browser_id && !item.browser_id) {
      item.browser_id = await this.sessionBrowser(item); await this.db.put('session:' + item.id, item);
    }
  }
}
