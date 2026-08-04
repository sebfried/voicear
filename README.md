# Voicear

Local-first, framework-free browser voice agent using OpenAI Realtime, on-device “Hey Jarvis,” persistent chats, explicit camera sharing, and optional local-agent connections.

> [!WARNING]
> Voicear is experimental and frontend-only. A long-lived OpenAI Platform API key stored in a browser cannot be hidden from JavaScript on the same origin. Use it on trusted personal devices; a shared public deployment should mint short-lived OpenAI client secrets through a trusted backend.

## Features

- Local wake-word detection with openWakeWord and ONNX Runtime Web. Ambient conversation stays on-device until “Hey Jarvis” is detected.
- OpenAI Realtime voice over WebRTC, with a visible button as a wake-word-free fallback.
- No Voicear account or application backend. Chats and photos live in IndexedDB; settings and the OpenAI key live in localStorage.
- Voice-controlled chat creation and switching, transcript navigation, and font scaling.
- Local camera preview and photos with explicit, one-image consent before anything is sent to the agent.
- Optional direct Hermes and OpenClaw connections with a separate local Agent Inbox.
- Mobile-first PWA layout, manual fullscreen, foreground-tab microphone ownership, and local chat export.

## Requirements

- Node.js 22.19 or newer;
- pnpm 11.18.0;
- a modern HTTPS-capable browser with WebRTC, Web Audio, Web Workers, IndexedDB, and MediaDevices; and
- an OpenAI Platform API key with Realtime API access.

A ChatGPT subscription is not an OpenAI API credential.

## Quick start

```sh
pnpm install --frozen-lockfile
pnpm dev
```

The development server listens on the local network over HTTPS. Open the displayed URL and accept the self-signed development certificate on each test device.

Enter an OpenAI Platform API key under `[ KEYS + SETTINGS ]`. Voicear stores it in that browser's localStorage. An iOS Home Screen app has storage separate from Safari and therefore needs its own key import.

For trusted local setup only, `https://HOST:4321/?key=OPENAI_KEY` imports the key once and immediately removes it from the visible URL and browser history. The initial request can still reach server or proxy logs, so the settings form is safer.

## Privacy and data flow

| Action | Local by default | Network transfer |
|---|---:|---|
| Wait for “Hey Jarvis” | Yes | None |
| Start Voice after wake word or `[ VOICE ]` | No | Microphone audio to OpenAI Realtime |
| Create and browse chats | Yes | None |
| Start camera or take a photo | Yes | None |
| Press `[ SEND TO AGENT ]` | Original stays local | One compressed selected photo to the active OpenAI session |
| Ask Voice to send the latest photo | Original stays local | One snapshotted photo after native confirmation |
| Ask what the live camera sees | Preview stays local | One current frame after native confirmation |
| Delegate to a configured local agent | Task stays in this browser | Task data to the selected user-configured endpoint |

Voicear has no analytics or remotely hosted third-party scripts. Browser storage is persistence, not a secret vault: malicious code served from the same origin could access keys, chats, photos, and agent credentials.

## Production deployment

```sh
pnpm install --frozen-lockfile
pnpm check
pnpm test
pnpm build
```

Deploy `dist/` at the root of a trusted static HTTPS origin. The included `public/sw.js` only removes obsolete Voicear service workers and caches; credentials and application data are never service-worker state.

Set these as HTTP response headers at the host or reverse proxy:

```text
Content-Security-Policy: frame-ancestors 'none'; …
Permissions-Policy: camera=(self), microphone=(self)
Referrer-Policy: no-referrer
X-Content-Type-Options: nosniff
Strict-Transport-Security: max-age=31536000
```

The page already supplies a restrictive meta CSP, but `frame-ancestors` is only effective as an HTTP header. Add HSTS `includeSubDomains` only when every subdomain is permanently HTTPS. If agent endpoints are fixed, tighten the documented broad `connect-src https: wss:` policy to those exact origins.

## Optional local agents

`[ CHATS ] → [ LOCAL AGENTS ]` supports multiple Hermes and OpenClaw profiles. Voice works without them.

- Hermes uses an authenticated HTTPS Runs API.
- OpenClaw uses its official, exactly pinned browser Gateway client over WSS.
- Tailscale Serve is an optional private route. Tailscale authentication happens in the device client; Voicear never requests or stores a Tailscale key.

Agent profiles live in localStorage. Credentials, non-extractable OpenClaw device identity, and Inbox tasks live in IndexedDB. A browser can restore state after reopening, but it cannot preserve a live socket while suspended or closed.

## Documentation

- [Camera, photos, and visual conversations](docs/camera.md)
- [Private agent channels](docs/channels.md)
- [Agent tasks, Inbox, and Voice handoff](docs/messages.md)
- [Architecture options and boundaries](docs/options.md)

## Contributing and security

See [CONTRIBUTING.md](CONTRIBUTING.md) before submitting changes. Report vulnerabilities privately according to [SECURITY.md](SECURITY.md); never place real keys, tokens, private URLs, media, or browser exports in an issue.

## License

Original Voicear source code and documentation are licensed under the [Apache License 2.0](LICENSE).

The bundled model artifacts have separate licenses documented in [public/THIRD_PARTY_NOTICES.md](public/THIRD_PARTY_NOTICES.md). In particular, `public/openwakeword/models/hey_jarvis_v0.1.onnx` is licensed under CC BY-NC-SA 4.0 and is restricted to noncommercial use. It is not covered by Voicear's Apache-2.0 license.

Because that classifier is bundled for an out-of-the-box local wake word, the complete checkout and resulting build are not an Apache-only, commercially unrestricted distribution. Remove or replace the classifier with a permissively trained model before commercial use or a fully OSI-compliant distribution.
