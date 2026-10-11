import {browserLimitError, inspectBrowserLimits, inspectBrowserHistory} from './hosted-browser-limits.mjs';

export const HOSTED_BROWSER_IDLE_MS = 120000;

const stopped = error => /^Unable to connect to browser: code: (404|410):/.test(error.message || '');

export function hostedBrowserFactory(binding, {acquire, connect, limits, history, now = Date.now}) {
  return {
    inspectLimits() { return inspectBrowserLimits(binding, limits, now); },
    inspectHistory() { return inspectBrowserHistory(binding, history, now); },
    async open(id, onAcquire = async () => {}, beforeAcquire = async () => {}) {
      // Reconnect only the browser recorded for this account.
      if (id) {
        try { return {browser: await connect(binding, {sessionId: id, persistent: true}), sessionId: id, fresh: false}; }
        catch (error) { if (!stopped(error)) throw await browserLimitError(error, binding, limits, now); }
      }
      await beforeAcquire();
      let sessionId;
      try { ({sessionId} = await acquire(binding, {keep_alive: HOSTED_BROWSER_IDLE_MS})); }
      catch (error) { throw await browserLimitError(error, binding, limits, now); }
      try {
        await onAcquire(sessionId);
        return {browser: await connect(binding, {sessionId, persistent: true}), sessionId, fresh: true};
      } catch (error) {
        try { await this.close(sessionId); }
        catch { error.cleanupSessionId = sessionId; }
        throw await browserLimitError(error, binding, limits, now);
      }
    },
    async close(id, beforeClose = async () => {}) {
      if (!id) return;
      let browser;
      try { browser = await connect(binding, {sessionId: id, persistent: true}); }
      catch (error) { if (stopped(error)) return; throw error; }
      try { await beforeClose(browser); }
      finally {
        try { await (await browser.newBrowserCDPSession()).send('Browser.close'); }
        finally { await browser.close().catch(() => {}); }
      }
    }
  };
}
