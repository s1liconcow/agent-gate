import {assertLocalBrowserEnvironment} from './browser-environment.mjs';

// All local browser entrypoints share this preflight, before creating fixtures.
assertLocalBrowserEnvironment();
export {chromium} from '@playwright/test';
