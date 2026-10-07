// Real isolated-world capture and freshness checks for compact non-mail fields.
import assert from 'node:assert/strict';
import {chromium} from '@playwright/test';
import {cp, mkdtemp, readFile, writeFile, rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {resolve} from 'node:path';

const root = resolve(import.meta.dirname, '..'), temporary = await mkdtemp(resolve(tmpdir(), 'agentgate-purpose-context-'));
const origin = 'https://catalog.example.test';
let browser;
try {
  const extension = resolve(temporary, 'extension');
  await cp(resolve(root, 'extension'), extension, {recursive: true});
  const manifest = JSON.parse(await readFile(resolve(extension, 'manifest.json')));
  manifest.host_permissions.push(origin + '/*');
  await writeFile(resolve(extension, 'manifest.json'), JSON.stringify(manifest));
  browser = await chromium.launchPersistentContext(resolve(temporary, 'profile'), {channel: 'chromium', headless: true, args: ['--disable-extensions-except=' + extension, '--load-extension=' + extension]});
  const worker = browser.serviceWorkers()[0] || await browser.waitForEvent('serviceworker'), page = await browser.newPage();
  await page.route(origin + '/**', route => route.fulfill({contentType: 'text/html', body: `<main>
    <h1 id="source">Catalog</h1>
    <h2>Other lamp</h2><h3>Rated power</h3><p>60 W</p>
    <h2>Target lamp</h2><h3>Rated power</h3><div><span id="power">30 W</span></div>
    <h2>Target shelf</h2><dl><dt>Capacity</dt><dd id="capacity">1500</dd></dl>
    <h2>Orders</h2><table><thead><tr><th>Record</th><th>Width</th></tr></thead>
      <tbody><tr><th>Target frame</th><td id="width">50 cm</td></tr></tbody></table>
    <section aria-label="Target flask"><h3>Volume</h3><p id="volume">800 ml</p></section>
  </main>`}));
  await page.goto(origin);
  const tab = await worker.evaluate(async origin => (await chrome.tabs.query({})).find(t => t.url?.startsWith(origin)).id, origin);
  const capture = id => worker.evaluate(async ({tab, origin, id}) => {
    await chrome.scripting.executeScript({target: {tabId: tab}, files: ['xpath.js', 'content.js']});
    return chrome.tabs.sendMessage(tab, {type: 'dom_snapshot', origins: [origin], xpath: '//'+({power:'span',capacity:'dd',width:'td',volume:'p'}[id])+'[@id="'+id+'"]', offset: 0, limit: 1});
  }, {tab, origin, id});
  const current = ref => worker.evaluate(({tab, ref}) => chrome.tabs.sendMessage(tab, {type: 'snapshot_current', ids: [ref]}), {tab, ref});
  assert.equal((await capture('power')).blocks[0].context, 'Catalog / Target lamp / Rated power');
  assert.equal((await capture('capacity')).blocks[0].context, 'Catalog / Target shelf / Capacity');
  assert.equal((await capture('width')).blocks[0].context, 'Catalog / Orders / Target frame / Width');
  assert.equal((await capture('volume')).blocks[0].context, 'Catalog / Target flask / Volume');
  const selected = await capture('power'), ref = selected.blocks[0].ref;
  assert.equal((await current(ref)).current, true);
  await page.locator('#source').evaluate(node => {node.textContent = 'Different catalog';});
  assert.equal((await current(ref)).current, false, 'A changed parent source invalidates the complete context.');
  await page.locator('#source').evaluate(node => {node.textContent = 'Catalog';});
  await page.locator('#source').evaluate(node => {node.textContent = 'x'.repeat(181);});
  assert.equal((await capture('power')).blocks[0].context, '', 'Oversized parent headings cannot be dropped or clipped.');
  await page.locator('#source').evaluate(node => {node.textContent = 'Catalog';});
  await page.locator('h2').nth(1).evaluate(node => {node.innerHTML = 'Target lamp <span contenteditable="true">PRIVATE_EDITABLE_TITLE</span>';});
  const safe = await capture('power');
  assert.equal(safe.blocks[0].context, 'Catalog / Target lamp / Rated power');
  assert.ok(!JSON.stringify(safe).includes('PRIVATE_EDITABLE_TITLE'));
  console.log('PASS: Chrome captures active heading hierarchies, definition labels and table headers, excludes peer records and editable values, and rejects changed or oversized source context.');
} finally {
  await browser?.close();
  await rm(temporary, {recursive: true, force: true});
}
