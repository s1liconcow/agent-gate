// Chrome's small browser surface as used by AutomaticBrowser.
// This object is per Gate execution; no tenant data lives in module globals.
export function hostedAPI(adapter, store, privateSession = new Map()) {
  const area = namespace => ({
    async get(names) {
      const result = {};
      for (const name of typeof names === 'string' ? [names] : names) {
        const value = name === 'checkout_bindings' ? privateSession.get(name) : await store.get(namespace + ':' + name);
        if (value !== undefined) result[name] = value;
      }
      return result;
    },
    async set(values) {
      for (const [name, value] of Object.entries(values)) {
        if (name === 'checkout_bindings') privateSession.set(name, value);
        else await store.put(namespace + ':' + name, value);
      }
    },
    async remove(names) { for (const name of typeof names === 'string' ? [names] : names) { privateSession.delete(name); await store.delete(namespace + ':' + name); } }
  });
  return {
    storage: {local: area('local'), session: area('session')},
    runtime: {getManifest: () => ({version: '0.7.1'})},
    permissions: {contains: async () => true},
    tabs: {
      get: id => adapter.tab(id),
      remove: id => adapter.closeTab(id),
      create: ({url}) => adapter.createTab(url),
      update: (id, {url}) => adapter.navigate(id, url),
      sendMessage: (id, message) => adapter.message(id, message)
    },
    scripting: {executeScript: ({target, files}) => adapter.inject(target.tabId, files)}
  };
}
