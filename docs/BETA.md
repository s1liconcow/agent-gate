# Shared beta

One Cloudflare Worker serves the beta. Share one private invitation link. Each tester creates an account, pairs a phone and browser, then connects an assistant. Testers run no server. You run no command for each tester.

## One-time launch

1. Run `PUBLIC_ORIGIN=https://agentgate-control.dchalloner.workers.dev npm run setup`. This preserves an existing local configuration and adds one beta invitation secret. The generated invitation is in `~/.agentgate-control/beta-invite-url.txt`. Keep that file private.
2. Run `npx wrangler secret put BETA_INVITE_TOKEN` and paste its value from `~/.agentgate-control/config.json`. Set `BETA_MAX_USERS` if the default limit of ten testers is unsuitable.
3. Run `npm run build` and `npx wrangler deploy --strict` with the updated `wrangler.jsonc`. The `v2` migration adds the Registry Durable Object. Keep the existing `GATE` and `OAUTH_KV` bindings and owner secrets.
4. Open the invitation link yourself and complete a synthetic demo before sharing it.

The owner deployment remains at its existing root URLs. Beta URLs use `/u/<account-id>/`. The invitation code is sent only when someone chooses **Create my space**; the phone pairing code stays in the URL fragment and is removed after the setup page reads it. The desktop keeps the pairing code locally until the phone is paired, so setup survives a reload. Sharing the invitation lets recipients create accounts until the cap is reached. Set `BETA_MAX_USERS=0` to stop new enrollment without changing enrolled accounts.

## Tester flow

1. Open the invitation link on desktop Chrome and choose **Create my space**. Save the resulting account URL.
2. Scan the phone QR, then pair the approval phone. The phone keeps a separate nonextractable signing key for that account.
3. Install the Chrome extension from the setup page. Paste the account's coordinator URL into **Connect browser → Coordinator settings**, then pair the browser with the phone QR.
4. Add the account's `/mcp` endpoint to the assistant with OAuth. Approve that connection and each browser task on the paired phone.

Each account has its own Durable Object storage, phone key, browser credentials and sockets, session state, and assistant connections. OAuth tokens carry an account ID and are accepted only for that account's MCP resource. The older shared agent and bridge credentials are rejected on beta account routes.

The extension checks phone-signed sessions and exact action receipts before browser access. Cloudflare handles approved MCP views and task arguments in plaintext. The service operator controls the hosted phone app and extension release, so this beta does not provide operator-proof approval code or end-to-end encrypted views.

## Verification

`npm test` checks account URL parsing and coordinator validation. With `npm run setup` and a local Wrangler server at `127.0.0.1:8790`, run `node tests/tenant-live.mjs` to exercise two enrollments, phone pairing, encrypted browser pairing, shared-token rejection, per-account OAuth, and MCP audience isolation. This live check creates two local beta accounts.
