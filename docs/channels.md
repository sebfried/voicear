# Private agent channels

Status: implemented behavior, 2026-08-01

## Decision

Voicear is still a backend-free frontend. The browser connects directly to user-configured agents:

- OpenClaw over its native Gateway WebSocket (`wss://`);
- Hermes over its authenticated Runs HTTP API (`https://`);
- plain `ws://`/`http://` only for loopback development.

Tailscale Serve is an optional private routing/TLS choice, not a Voicear server and not an application login. A normal reverse proxy or an already-secure direct hostname works too. The production requirement is a reachable HTTPS/WSS endpoint with the exact Voicear origin allowed by the agent.

No cloud relay, Voicear account, A2A gateway, MCP gateway, WebRTC agent transport, or local companion is required.

## Tailscale: no key in Voicear

When Tailscale is used, its client runs on the agent device and each client device. Users sign those devices into their tailnet outside Voicear. Tailscale Serve can then proxy a loopback agent port to a private `https://…ts.net` endpoint governed by tailnet grants/ACLs.

Voicear does not request or store a Tailscale auth key, API token, OAuth client secret, or OAuth authorization. Auth keys and Tailscale OAuth are for registering devices or administering/provisioning tailnet resources; they are not bearer credentials for a frontend request to a Serve URL. Voicear still authenticates at the application layer with the Hermes API key or OpenClaw device credential.

Use Funnel only if deliberate public exposure is acceptable; it is not part of this design. Sources: [Tailscale Serve](https://tailscale.com/docs/features/tailscale-serve), [adding a device](https://tailscale.com/docs/features/access-control/device-management/how-to/set-up), [Tailscale identity and auth keys](https://tailscale.com/docs/concepts/tailscale-identity), and [OAuth apps](https://tailscale.com/docs/features/oauth-apps).

## OpenClaw

Voicear pins the official browser client exactly:

```json
"@openclaw/gateway-client": "2026.7.2-beta.6"
```

The integration is explicitly experimental because this is a beta release. It imports `@openclaw/gateway-client/browser`; do not substitute an unrelated SDK or silently float the version.

The connector provides:

- protocol v4 challenge/connect handshake;
- a browser-generated signing identity;
- one-time bootstrap token followed by locally stored, revocable device tokens;
- only `operator.read` and `operator.write` scopes;
- `chat.send` with the local task UUID as `idempotencyKey`;
- live event reduction, native abort, reconnect, and `chat.history` reconciliation.

The connection profile may contain an optional target agent ID. A bootstrap token is removed locally once the paired device token is stored. Outer event sequences are connection/run observations, not a durable global replay cursor.

Primary references: [OpenClaw Gateway protocol](https://docs.openclaw.ai/gateway/protocol), [building a Gateway client](https://docs.openclaw.ai/gateway/clients), [operator scopes](https://docs.openclaw.ai/gateway/operator-scopes), and [Gateway security](https://docs.openclaw.ai/gateway/security).

## Hermes

Voicear uses a small polling connector:

- `GET /v1/capabilities` to test compatibility;
- `POST /v1/runs` with `{ input, session_id }`;
- `GET /v1/runs/{run_id}` as authoritative status;
- `POST /v1/runs/{run_id}/stop` for cancellation.

There is no Hermes SSE layer in this version. Visible unfinished runs are polled every five seconds, and lifecycle events trigger a single-flight reconciliation. Every request uses `Authorization: Bearer …`, bounded JSON parsing, and an abort signal where supplied.

Minimal Hermes host configuration is:

```dotenv
API_SERVER_ENABLED=true
API_SERVER_KEY=<long-random-secret>
API_SERVER_CORS_ORIGINS=https://<exact-voicear-origin>
```

### Current CORS and idempotency caveat

The stock Hermes CORS allow-header list currently includes `Authorization`, `Content-Type`, and `Idempotency-Key`, but not `X-Hermes-Session-Id` or `X-Hermes-Session-Key`. Voicear therefore sends neither special session header cross-origin; it sends the chat UUID as the JSON `session_id` instead.

Voicear sends `Idempotency-Key: <local-task-uuid>` for forward compatibility. The current upstream `/v1/runs` handler does not consume that header, so it is not an exactly-once guarantee for Runs. If submission fails ambiguously, Voicear records `unknown` and does not retry automatically.

References: [Hermes API Server and browser CORS](https://hermes-agent.nousresearch.com/docs/user-guide/features/api-server/), [environment variables](https://hermes-agent.nousresearch.com/docs/reference/environment-variables/), and the [current API-server implementation](https://github.com/NousResearch/hermes-agent/blob/main/gateway/platforms/api_server.py).

`API_SERVER_KEY` can unlock Hermes' full configured toolset, including terminal and filesystem access. Use a long random key, a narrow server-side origin allowlist, private routing where possible, and no third-party scripts on the Voicear origin.

## Runtime endpoints and CSP

Connections are user-configured at runtime, so a static meta CSP cannot enumerate their origins in advance. The implemented `connect-src` intentionally permits runtime HTTPS/WSS endpoints plus loopback development:

```text
connect-src 'self' https: wss:
  http://localhost:* http://127.0.0.1:*
  ws://localhost:* ws://127.0.0.1:*
```

This is the practical BYO-endpoint tradeoff: it allows arbitrary secure outbound connection origins, so CSP is no longer an exact exfiltration allowlist. The remaining policy keeps scripts and assets same-origin, forbids objects and base URLs, and sends no referrer. A deployment with fixed endpoints should tighten `connect-src` to those exact HTTPS/WSS origins; a same-origin reverse proxy can retain `'self'` only.

The agent's CORS/origin allowlist remains the server-side boundary. CSP does not replace it. See the [CSP `connect-src` specification](https://www.w3.org/TR/CSP3/#directive-connect-src) and [MDN mixed-content guidance](https://developer.mozilla.org/en-US/docs/Web/Security/Mixed_content).

## Local persistence

Voicear separates discoverable profiles from secrets:

- connection profiles (`kind`, label, endpoint, optional OpenClaw target, enabled/default): `localStorage`;
- Hermes API keys, OpenClaw bootstrap/device credentials, and non-extractable signing keys: IndexedDB `agentCredentials`;
- durable task snapshots: IndexedDB `agentTasks`;
- chats remain in IndexedDB `chats`.

The IndexedDB schema is version 2. Removing a connection removes its credential and associated tasks. Credentials are never placed in URLs, transcript messages, task records, console output, or exports.

Hermes keys and OpenClaw device tokens are bound to their normalized endpoint. OpenClaw writes are additionally bound to the exact saved profile revision and connector generation, so an old tab or stopped connector cannot reuse or restore a credential for a changed host or target.

LocalStorage and IndexedDB are persistence, not a secret vault: same-origin malicious code could use stored credentials. The design therefore avoids third-party scripts and renders remote text only with `textContent`. A local companion remains an upgrade option if browser-held Hermes authority becomes unacceptable or multi-user revocation/push is required.

## Setup checklist

1. Make the agent reachable through direct HTTPS/WSS, a reverse proxy, or optional Tailscale Serve.
2. Keep a directly proxied local agent on loopback where possible.
3. Configure the exact deployed Voicear origin in Hermes CORS or OpenClaw allowed origins.
4. Add the connection profile and its agent credential in Voicear; never add a Tailscale key.
5. Test the connection before delegating work.
6. For OpenClaw, complete any device-pairing approval and verify the scoped device token replaces the bootstrap token.
7. Test reconnect, ambiguous submission, cancellation, and foreground reconciliation on desktop and iPhone.

## Acceptance checks

- Production endpoints require HTTPS/WSS; plaintext is loopback-only.
- Tailscale is optional and contributes no credential to Voicear.
- Wrong agent token and wrong browser origin are rejected.
- OpenClaw remains pinned to `2026.7.2-beta.6` and labeled experimental.
- OpenClaw reconnects its socket and reconciles pending tasks without replaying requests.
- Hermes works against stock cross-origin CORS without special session headers.
- An ambiguous Hermes submit becomes `unknown` rather than an automatic duplicate.
- Runtime endpoints work under the documented broad `connect-src` tradeoff.
- No credential appears in a URL, transcript, task, log, or export.
