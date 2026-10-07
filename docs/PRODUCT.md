# AgentGate

<!-- impeccable:product-schema 1 -->

## Platform

web

## Users

The owner of a desktop browser and Android phone, delegating personal assistant tasks to ChatGPT, Claude, Codex or Claude Code over MCP.

## Product Purpose

Allow an assistant to use a signed-in browser for an explicitly approved purpose while withholding unrelated information.

## Operating Context

The user approves a high-level purpose once on their phone and handles website login and MFA themselves. Automatic mode runs actions within the approved purpose. Communications and payments are optional, with a total USD session limit for payments. Uncertain or unrelated actions stop. The assistant runs in an isolated environment with only the agent-facing MCP interface. Cloudflare hosts coordination and a mobile approval PWA; browser credentials and unapproved content remain local.

## Capabilities and Constraints

Tasks are general personal assistant workflows. Synthetic email, calendar, payment and a full bank navigation journey exercise the same gateway. The original read-only AgentGate 0.1 remains available. The purpose classifier has a self-contained Chrome build trained across thirteen workflows: mail, calendars, documents, projects, support, shopping, travel, billing, appointment logistics, education, CRM, developer tools and banking. It judges bounded text fields against the signed purpose. The earlier desktop service remains an inbox research baseline. Chrome's on-device AI and configured remote providers support the whole-page planner. The phone approves a precise purpose. In whole-page mode, the model selects source IDs, a separate context verifies relevance, and deterministic rules construct a bounded view. Unavailable inference, uncertainty and policy failures withhold disclosure. Whole-page writes, clicks and navigation require two purpose checks. Read-only classifiers check each field and permit navigation within signed origins. Additional action approvals apply only to explicitly selected confirmation modes. Raw DOM, screenshots, cookies and arbitrary JavaScript are excluded from the assistant interface. Remote ChatGPT/Claude connections use OAuth and separate session principals.

Browser setup uses a QR scanned by the paired phone. The extension verifies an encrypted signed response and stores its own credential and pinned phone key without key copying. Normal operation needs only hosted MCP, the Chrome extension and the phone approval app. One browser connection is active at a time; a newly approved connection replaces the old one.

## Brand Commitments

AgentGate is a provisional working name inherited from the prototype. Preserve its restrained dark surfaces and mint action color.

## Product Principles

- Enforce scope outside the acting model.
- Release the smallest checked browser view needed for the approved task.
- Bind approvals to immutable requests and bounded lifetimes.
- Stop on stale views, expiry, revocation or uncertain outcomes.

## Open Decisions

Single-owner operation and Cloudflare visibility into approved task metadata remain assumptions. Production multi-user identity, end-to-end encrypted coordination and native Android packaging remain open. Genuine Chrome local inference passed a synthetic payment disclosure check in a separate test profile. Broader relevance accuracy, integrated native-model workflows and actual ChatGPT/Claude account setup require verification on supported owner devices.
