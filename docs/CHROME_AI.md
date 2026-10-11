# Chrome AI reads and writes

Choose **Advanced settings → AI provider → Chrome AI** in the desktop extension.
Selection prepares Chrome's model in the settings page before saving the provider.
The **Prepare Chrome AI** button also initializes or retries the default Chrome AI
selection. Download progress is shown; failed preparation preserves the saved
provider. Chrome AI requires a supported browser and device.

Chrome AI supports `read`, `fill`, `click` and `navigate` through the local planner.
It exposes task-relevant fields and controls, checks each proposed write twice,
and applies the approved task's interaction or engagement policy. Selecting it
does not grant write permission or approve a purchase. Existing task approvals
retain their signed scope; request a fresh task after changing provider.

The bundled **On-device checks** classifier supports `read` and `navigate`.
Chrome AI supplies the full planner and action guardian needed for writes.

Verification:

```sh
node --test tests/chrome-ai-setup.test.mjs tests/session-defaults.test.mjs tests/action-guard.test.mjs
node tests/chrome-ai-setup-browser.mjs
node tests/draft-browser.mjs
node scripts/chrome-ai-check.mjs --chrome --draft
```

The draft browser test verifies actual extension clicks and fills on a synthetic
form with fixture model decisions. The native probe uses Chrome's real model to
select Compose and draft fields, check an approved click and both fills, and
verify that Send stays outside the published view and cannot be acted on. It
uses an isolated synthetic-test Chrome profile.
