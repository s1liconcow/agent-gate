import {acquire, connect, limits, history} from '@cloudflare/playwright';
import {hostedBrowserFactory} from './hosted-browser-factory.mjs';
import {withAcquisitionHeaders} from './hosted-browser-limits.mjs';

export function cloudflareBrowserFactory(binding) {
  return hostedBrowserFactory(binding, {acquire: withAcquisitionHeaders(acquire), connect, limits, history,
    terminate: async (binding, id) => {
      const response = await binding.fetch('http://fake.host/v1/devtools/browser/' + encodeURIComponent(id), {method: 'DELETE'});
      if (![200, 204, 404, 410].includes(response.status)) throw new Error('Browser termination failed with HTTP ' + response.status);
    }});
}
