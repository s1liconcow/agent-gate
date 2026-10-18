export async function ownerBrowsers(gate) {
  return {
    account_id: await gate.ctx.storage.get('account_id') || 'owner',
    browsers: (await gate.browsers.list()).filter(item => item.kind !== 'hosted').map(item => ({
      ...gate.browsers.public(item), socket_connected: item.status === 'active' && gate.ctx.getWebSockets('browser:' + item.id).some(ws => ws.readyState === 1)
    })),
    choices: await gate.browserRouting.choices(), default_browser_id: (await gate.browserRouting.current())?.id || null
  };
}

export async function ownerSessions(gate) {
  const items = await gate.engine.list(), hosted = await gate.hostedConsent.current();
  return Promise.all(items.map(async item => ({...gate.engine.public(item), scope: item.task,
    browser_id: await gate.browserRouting.sessionBrowser(item), hosted: Boolean(hosted && await gate.browserRouting.owns(item, hosted.browser_id)),
    audit: item.history.filter(event => ['session', 'action_check', 'disclosure_check'].includes(event.type)),
    challenge: item.status === 'requested' ? item.challenge : item.status === 'awaiting_action' ? item.action_challenge : null
  })));
}

export async function ownerState(gate) {
  return {
    sessions: await ownerSessions(gate), connectors: (await gate.connectors.list()).map(item => gate.connectors.public(item)),
    browser_state: await ownerBrowsers(gate), hosted: await gate.hostedConsent.status(), engagement: await gate.engagement.public(),
    sources: (await gate.loginSources.list()).map(item => gate.loginSources.public(item)), transfers: await gate.loginSync.pending(),
    connections: await gate.hostedConsent.current() ? await gate.loginSync.connections() : []
  };
}
