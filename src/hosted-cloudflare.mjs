import {acquire, connect, limits, history} from '@cloudflare/playwright';
import {hostedBrowserFactory} from './hosted-browser-factory.mjs';
import {withAcquisitionHeaders} from './hosted-browser-limits.mjs';

export function cloudflareBrowserFactory(binding) {
  return hostedBrowserFactory(binding, {acquire: withAcquisitionHeaders(acquire), connect, limits, history});
}
