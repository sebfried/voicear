# Contributing to Voicear

Thanks for helping improve Voicear. Keep changes focused, explain user-visible behavior, and open an issue before undertaking a large architectural change.

## Development

Requirements:

- Node.js 22.19 or newer;
- pnpm 11.18.0 through Corepack or a compatible installation; and
- a modern browser with WebRTC, Web Audio, Web Workers, IndexedDB, and MediaDevices support.

```sh
pnpm install --frozen-lockfile
pnpm dev
```

Before submitting a change, run:

```sh
pnpm check
pnpm test
pnpm build
```

## Project rules

- Never commit API keys, tokens, certificates, private endpoints, personal media, or exported browser data.
- Preserve the local-first consent boundaries for microphone, camera, photos, chats, and agent connections.
- Add the smallest runnable regression check for non-trivial behavior.
- Do not add a dependency, model, dataset, icon, or copied source without documenting its provenance and compatible license.
- Keep `@openclaw/gateway-client` upgrades explicit; it is a pinned beta integration with protocol-level compatibility tests.

Unless explicitly stated otherwise, contributions intentionally submitted for inclusion are licensed under Apache-2.0 as described in section 5 of the project license.
