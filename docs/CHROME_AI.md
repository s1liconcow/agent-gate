# Chrome AI

The MCP request selects `classifier_backend: "chrome_ai"` and a paired local
browser in the same account. In the extension, **Prepare Chrome AI** starts or
retries native setup. Preparation and download progress appear in the settings
page. Failed setup preserves the saved provider and reports its blocker.

Chrome AI performs task-relevant view selection and action assessment locally.
It cannot expand signed origins, permissions, expiry or final-commit authority.
The alternative `onnx` backend uses the identity-checked bundle already installed
under `extension/models/purpose/`.

```sh
node --test tests/chrome-ai-setup.test.mjs tests/model-runtime.test.mjs tests/action-guard.test.mjs
node tests/chrome-ai-setup-browser.mjs
npm run test:native-extension
npm run demo:flow
```

Native availability is checked in isolated browser/offscreen contexts. Reports
distinguish fixture conformance from actual inference and unresolved availability.
Native extension readiness remains unresolved in the recorded test environment;
a successful synthetic or ONNX flow does not establish native readiness.
