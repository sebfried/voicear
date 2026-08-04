# Local-agent options and boundaries

Status: implementation decision, 2026-08-01

This file records the final choices and the important limits that are easy to miss. Voicear remains a frontend-only OpenAI Voice app when no local agent is configured; local-agent support is an optional capability, not a startup dependency.

## Chosen architecture

- Hermes uses its authenticated Runs HTTP API. Runs are reconciled after reconnect; live streaming is only an enhancement.
- OpenClaw uses its native Gateway WebSocket, scoped device pairing, and history/run recovery.
- Non-secret connection profiles are stored in `localStorage`. Agent credentials, the non-extractable OpenClaw device key, and task snapshots are stored in IndexedDB. Agent results never become chat messages.
- Each connector owns its native remote run/session identifiers. Voicear keeps one small, durable task projection rather than inventing a shared event log or protocol.
- The Inbox appears only when at least one connection is saved. One connector failing must not affect OpenAI Voice, wake-word detection, chats, or another connector.
- The current app does not use a persistent service worker. Its legacy worker only removes obsolete Voicear caches and unregisters itself; it never owns agent sockets, credentials, polling, or background work.

No account, Voicear backend, cloud relay, WebRTC mesh, A2A gateway, or MCP gateway is required for this version.

## Persistence is not a permanent connection

Browser storage can preserve profiles, credentials, tasks, unread state, and remote run IDs. It cannot preserve a live WebSocket, SSE stream, timer, or JavaScript process after a tab is suspended or closed.

On load and when the visible app returns online or to the foreground, Voicear reconnects and reconciles unfinished tasks. This creates a persistent user experience, not a permanently running browser connection. `navigator.storage.persist()` is best effort; private browsing, clearing site data, browser profile changes, or operating-system eviction can still remove all local state. There is no cross-device synchronization.

## Network access: Tailscale is optional

Tailscale Serve is the recommended private-network path because it supplies private routing, trusted HTTPS/WSS, MagicDNS, and tailnet access control while the agent remains bound to loopback. Tailscale authentication belongs to the installed Tailscale client on the phone/computer and agent host. Voicear must not request or store a Tailscale API key, OAuth client secret, or auth key.

OpenClaw/Hermes authentication remains separate from Tailscale. Tailscale decides whether the device can reach the host; the native agent protocol decides what Voicear may do.

Tailscale is not required. A directly reachable endpoint also works when it has:

- HTTPS for Hermes or WSS for OpenClaw with a certificate trusted by the browser;
- an exact allowlist for the deployed Voicear `Origin`;
- firewall exposure limited to the intended network and users; and
- any browser Local Network Access permission required by that platform.

Plain HTTP/WS is accepted only for exact loopback development addresses. A CSP allowance does not override mixed-content rules, certificate errors, iOS networking policy, or reachability. Do not use Tailscale Funnel merely to avoid client setup; it makes the endpoint public.

References: [Tailscale Serve](https://tailscale.com/docs/features/tailscale-serve), [OpenClaw remote access](https://docs.openclaw.ai/gateway/remote), and [Chrome Local Network Access](https://developer.chrome.com/blog/local-network-access).

## CSP tradeoff for user-provided endpoints

A static CSP cannot add an arbitrary origin after the page has loaded. Voicear currently allows `connect-src https: wss:` plus explicit loopback development endpoints so a user can enter a secure agent URL without rebuilding the app. `script-src` remains same-origin-only and remote output is rendered as text.

This flexibility weakens CSP as an exfiltration backstop if same-origin JavaScript is ever compromised. Deployments with fixed agents should tighten `connect-src` at build or hosting time to the exact OpenAI and agent origins. A same-origin reverse proxy is another strict-CSP option, but it is no longer a universally static deployment. There is no browser-only design that simultaneously supports arbitrary runtime destinations and an exact destination allowlist.

## Frontend BYOK threat model

Browser persistence is convenient, not a hardware-backed vault:

- same-origin malicious JavaScript can read or use OpenAI and Hermes credentials;
- a non-extractable OpenClaw private key cannot be exported, but compromised same-origin code could still ask it to sign;
- agent tokens must never enter URLs, chat transcripts, task text, exports, console logs, or error dumps;
- editing a connection must not refill its secret into a visible input; an empty secret field keeps it only while the endpoint is unchanged, and endpoint changes require fresh Hermes authority or fresh OpenClaw pairing;
- persisted agent credentials are endpoint-bound; stale tabs and replaced connectors fail closed instead of sending a newly stored key to an old host;
- disconnecting an agent removes its credential and tasks after confirmation.

The design is appropriate for personal, trusted browser profiles with no third-party scripts. Use a local companion/backend when secrets must be hidden from frontend JavaScript, independently revoked per device, centrally audited, or shared across users.

## iPhone and background limits

Mobile Safari may suspend a visible-looking Home Screen app, stop timers, and close WebSocket/SSE connections. A service worker is not a durable socket host and cannot provide arbitrary background polling. Therefore:

- live progress is best effort;
- the remote agent remains authoritative;
- final state is recovered on the next foreground/open event; and
- immediate closed-app notification is not promised.

Testing must cover both portrait and landscape, normal Safari and an installed PWA, network changes, screen lock, and returning after suspension.

## Hermes caveats

Hermes requires `API_SERVER_KEY` even on loopback. `API_SERVER_CORS_ORIGINS` must contain the exact Voicear scheme, host, and port, and its preflight must allow `Authorization`, `Content-Type`, and `Idempotency-Key`.

Voicear sends `Idempotency-Key`, but the inspected current Hermes Runs handler does not yet consume it even though CORS permits the header. It is therefore a forward-compatible correlation hint, not an exactly-once guarantee. If a request may have succeeded but its acknowledgement was lost, Voicear keeps the task `unknown` instead of blindly running it again. SSE event retention is shorter than durable run/session state, so reconnect uses run status and session history rather than assuming event replay. Authenticated live SSE must use `fetch()` streaming because native `EventSource` cannot set the bearer header.

Reference: [Hermes API Server](https://hermes-agent.nousresearch.com/docs/user-guide/features/api-server/).

## OpenClaw beta caveat

Voicear pins the official `@openclaw/gateway-client` package to `2026.7.2-beta.6`. Its browser entry is not a turnkey SDK: Voicear still owns the WebSocket adapter, non-extractable Ed25519 device-key storage, token storage, pairing UX, and task projection. The package owns protocol frames, handshake, authentication planning, and reconnect behavior.

First use may require approval in OpenClaw. Normal operation requests and accepts exactly `operator.read` and `operator.write`; credentials with other scopes are rejected. Bootstrap credentials are not the long-term device identity. Upgrades must remain exact-version changes and pass pairing, token reuse/revocation, sequence-gap, reconnect, and history-recovery tests before release.

The OpenResponses HTTP endpoint is not a fallback for this feature: its bearer grants broad authority and it does not provide the same durable browser reconnect/task semantics.

References: [OpenClaw Gateway clients](https://docs.openclaw.ai/gateway/clients) and [Gateway protocol](https://docs.openclaw.ai/gateway/protocol).

## Voice result policy

“Voice active” means an OpenAI Realtime session is connected, the document is visible, and the current session has not been paused or stopped.

- A result first observed while Voice is active may be queued until the current response/audio ends, then announced and summarized once.
- Voicear sends a bounded, explicitly marked untrusted result into an isolated one-off Realtime response; it never inserts raw agent output as a system instruction or normal user turn.
- That out-of-band result-summary response uses `conversation: "none"` and has tools disabled. Neither its input nor summary can persist into later tool-capable turns.
- Results first observed while Voice is idle, disconnected, hidden, starting, or reconciling only update the Inbox badge.
- The live notification queue is memory-only and is cleared with the Realtime session. There is no announcement replay on the next wake word, reconnect, or app opening.

The last rule is intentional: reconciliation answers “what changed while away,” not “what should unexpectedly speak now.” The user can open the Inbox or ask Voice to list/read stored results.

## Multiple agents and routing

Every profile, credential, task, remote identifier, and error is scoped by connection ID. One connection can be the default.

- With one enabled connection, an unqualified delegation can use it.
- With several, an exact connection ID or normalized label wins; otherwise the explicit default is used.
- With no unique match/default, Voice lists the candidates and asks. It never broadcasts a task to every agent.
- A connector error stays on that connector. Reconciliation and results from the others continue.
- Removing the last connection hides the Inbox and removes its otherwise unreachable local tasks after confirmation; if work is unfinished, the confirmation warns that remote work may continue without local control.

Unsolicited agent-to-user messages unrelated to a Voicear task are not modeled yet. Add a separate message/event model only when a supported connector supplies a durable identity/cursor for them.

## Deferred options and their triggers

| Deferred option | Add only when |
|---|---|
| Local companion or Voicear backend | Agent secrets must leave frontend JavaScript, clients cannot reach private endpoints, centralized revocation/audit or cross-device sync is required. |
| Cloud relay | Private routing is unavailable and making the trust/infrastructure tradeoff is explicitly accepted. |
| Web Push | Immediate closed-app delivery becomes required and a push/application server is accepted. |
| Approval and input workflows | A deployed connector actually returns `needs_approval`/`needs_input` and the product has a safe review/reply UI. Never auto-approve. |
| Files, images, rich artifacts, or Markdown | A real connector returns them. Until then results are bounded plain text with no remote embeds or automatic links. |
| Persistent event log/outbox | Audit, progress replay, unsolicited messages, or protocol-level delivery acknowledgement becomes a requirement. |
| A2A or MCP wire adapters | A real configured agent exposes that protocol and native OpenClaw/Hermes integration no longer covers the use case. |
| Additional connector abstraction/plugin system | A third implemented connector demonstrates shared behavior that the existing two-way switch cannot express cleanly. |
