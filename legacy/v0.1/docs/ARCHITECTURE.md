# Architecture and threat model

## Implemented data path

```text
ACTING ASSISTANT                       TRUSTED USER DEVICE
MCP client
  |
  | request_private_answer
  v
Agent-role MCP process -> Local broker -> pending task
                         (agent key)        |
                                           v
                                  Extension approval UI
                                  (separate device key)
                                           |
                                  Human confirms scope
                                           |
                             User-selected signed-in page
                              /                        \
                 available balance                 selected text
                         |                               |
                integer-cent comparison          pattern redaction
                         |                               |
                  fixed boolean schema             local broker
                         |                               |
                         +-----------> independent local AI
                                        no tools
                                        fixed schemas
                                        relevance + veto
                                             |
                                   private output preview
                                             |
                                   explicit human approval
                                             |
                                    short retrieval lease
                                             |
Assistant <-------------- approved minimal answer only
```

The funds branch exports a boolean and fixed metadata. The model's input cannot include the raw balance through the funds-review endpoint. A local user may include optional fees and reserve in the calculation without revealing those inputs. The broker trusts the extension's calculation; this is not an attested balance oracle.

General text is limited to 12,000 selected characters, at most 80 segments, and a final answer of at most 12 segments / 2,000 characters. The reviewer can select original sanitized segments in their existing order. It cannot author a replacement answer. A second model call applies a veto. Both calls use the same configured local review model, independently of the acting assistant. They do not constitute two independent model implementations.

## Roles

The device key authorizes listing pending requests, preparing a private preview, approving its exact digest/receipt and revoking. The agent key authorizes request creation, status reads, approved-result reads and revocation. A request ID alone grants no access. This is a single-user, single-agent-identity development configuration; a production service needs per-agent identities and per-request audience binding.

The loopback broker requires a matching Host header, a paired extension Origin for device endpoints and separate bearer authentication. It does not accept web-page origins. CORS is a browser defense; it does not authenticate local programs. Any local process that obtains a key can exercise that role. The device key is stored in trusted extension storage, which is not hardware-backed secret storage.

## State machine

```text
pending -> reviewing -> reviewed -> ready -> expired
    |          |           |         |
    +----------+-----------+---------+----> revoked
```

A review failure returns the request to pending without output. The endpoint rechecks status after a model call, preventing a result that completed after revocation from being published. A valid preview carries a random approval receipt and a digest of the task plus candidate. Final publication validates both. No model response is an approval credential. Publication starts the lease. Preview expiration clears candidate/receipt and requires review again; the current UI guides the user to revoke and create a fresh request.

Expiry is checked on each retrieval using both wall and monotonic clocks. Worker sleep, browser suspension and missed alarms do not extend a broker lease. A result sent just before expiration remains in the receiving agent's possession. Revocation cannot recall those bytes. A broker crash invalidates all in-memory requests.

## Trusted computing base

The extension bundle and browser; the approval UI and its human operator; broker code and host operating system; the independent local inference service; and filesystem permissions protecting configuration are trusted. The acting assistant, websites' text, external task descriptions and model replies are treated as untrusted.

The installed local model may still make bad semantic judgments. Pattern redaction is incomplete for names, locations, medical facts and indirect identifiers. Explicit final human approval is always required, including when the model says allow. A user-controlled browser can show false or stale information; origin binding does not prove financial truth.

The current protections exclude compromised operating systems, malicious extensions, screen recording, accessibility automation, same-user agents with unrestricted filesystem access, and an agent that can operate the approval UI. Give the assistant a separate limited environment. Installing this extension beside an unrestricted browser-control tool does not isolate that other tool.

## Host permissions

Chrome's `activeTab` is obtained when the user invokes the extension's action, enabling temporary access to that tab. The extension never asks for blanket site permissions. See [Chrome's activeTab documentation](https://developer.chrome.com/docs/extensions/develop/concepts/activeTab).

The local host permission covers loopback, with port restriction enforced in code and CSP. Production should consider native messaging to reduce the exposed local HTTP surface, backed by a signed desktop installation and a strong pairing process. The prototype has no enterprise policy enforcement or signed native host.

## Remote and mobile roadmap

A remote deployment should introduce a public **agent-facing** MCP endpoint, strong client/user authentication and an outbound mutually authenticated device channel. The device must locally verify a signed, immutable approval challenge containing origin, purpose, account alias, requested disclosure, recipient/amount for an eventual action, lease, nonce, audience and budget. A relay must not become able to impersonate device approval. Devices should keep long-lived site credentials local.

The phone can sign the approval challenge using a device-bound key gated by user presence. Phone approval of the broker request does not automatically satisfy a website's own passkey/MFA prompt. Browser, OS and website authentication constraints need to be handled separately.

Prefer returning typed, minimal results. Keep raw page text and screenshots out of the remote coordinator. A hosted assistant must receive access only to the broker's approved-result tools; direct access to the signed-in browser would create another disclosure channel.

Do not expose the current device broker to the internet. It has no production remote authentication, multi-tenant isolation, relay protocol, mobile approval or denial-of-service hardening.

## Eventual actions

The present version performs no write actions on sites. A future domain adapter would need separate read and action permissions, bank/site-specific semantics, independent recipient/amount confirmation, replay prevention, submission idempotency and post-action reconciliation. A boolean balance predicate proves only the configured comparison on the selected evidence. A transaction must still satisfy every separate authorization and safety requirement.

A browser automation API consisting of arbitrary clicks, URLs or JavaScript would defeat the narrow interface. Do not add a generic `execute_script`, `fetch_with_session`, cookie-export or unrestricted screenshot endpoint to this broker.

## Source references checked during implementation

- Chrome activeTab: https://developer.chrome.com/docs/extensions/develop/concepts/activeTab
- Chrome trusted storage access: https://developer.chrome.com/docs/extensions/reference/api/storage
- Chrome worker lifetime: https://developer.chrome.com/docs/extensions/develop/concepts/service-workers/lifecycle
- Ollama structured outputs: https://docs.ollama.com/capabilities/structured-outputs
- Ollama cloud-disable configuration: https://docs.ollama.com/faq
- OpenAI MCP client configuration: https://developers.openai.com/codex/mcp
- OpenAI MCP authorization and tool design: https://developers.openai.com/plugins/build/mcp-server

These references support the platform interfaces. They are not evidence that this prototype is security-audited or integrated with Dots.
