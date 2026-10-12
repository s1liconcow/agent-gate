import test from 'node:test';import assert from 'node:assert/strict';
import {BrowserRouting, summarizeLocalBrowsers} from '../src/browser-routing.mjs';import {fixture,device} from './flow/fixture.mjs';
test('explicit routes and pinned classifier never fall back to an unrelated device',async()=>{const f=await fixture(),r=new BrowserRouting(f.db),cloud='c'.repeat(32);for(const [id,kind]of [[device,'local'],[cloud,'hosted']])await f.db.put('browser:'+id,{id,kind,name:kind,status:'active',expires_at:Date.now()+60000});await f.db.put('hosted:consent',{browser_id:cloud,expires_at:Date.now()+60000});assert.equal((await r.choose('local',device)).id,device);assert.equal((await r.choose('cloud')).id,cloud);await assert.rejects(r.choose('local',cloud),{code:'BROWSER_SELECTION_REQUIRED'});await assert.rejects(r.choose('local','f'.repeat(32)),{code:'BROWSER_SELECTION_REQUIRED'});await r.setDefault(cloud);assert.equal(await r.sessionBrowser(await f.engine.get(f.id)),device);assert.equal(await r.owns(await f.engine.get(f.id),cloud),false);await assert.rejects(f.engine.create({...f.request,browser_id:cloud}),{code:'INVALID_FIELDS'});});

test('local connection diagnostics distinguish active, pending, expired and hosted browsers', () => {
  const now = 100_000;
  const a = 'a'.repeat(32), b = 'b'.repeat(32);
  const records = [
    {id: a, kind: 'local', status: 'active', expires_at: now + 1000},
    {id: b, status: 'active', expires_at: now + 1000},
    {id: 'c'.repeat(32), status: 'active', expires_at: now - 1},
    {id: 'd'.repeat(32), status: 'requested', expires_at: now + 1000},
    {id: 'e'.repeat(32), kind: 'hosted', status: 'active', expires_at: now + 1000},
    {id: 'f'.repeat(32), kind: 'local', status: 'revoked', expires_at: now + 1000}
  ];
  assert.deepEqual(summarizeLocalBrowsers(records, id => id === a, now), {
    active_pairings: 2, connected_sockets: 1, pending_pairings: 1
  });
  assert.deepEqual(summarizeLocalBrowsers([records[4]], () => true, now), {
    active_pairings: 0, connected_sockets: 0, pending_pairings: 0
  });
});
