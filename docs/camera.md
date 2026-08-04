# Camera, local photos, and visual conversations

Status: implemented baseline and roadmap, 2026-08-04

Voicear treats the camera as a separate local capability. Starting the camera is always a deliberate button action. Voice can control an already running camera, but it cannot open a permission prompt, restart a stopped camera, or capture in the background.

## Privacy contract

| Action | Stays in this browser | Sent to OpenAI |
|---|---:|---:|
| Start camera with `[ CAMERA ]` | Yes | No |
| Show/hide the feed or change opacity | Yes | No |
| Take a photo with the button or `take_photo` | Yes | No |
| Press `[ SEND TO AGENT ]` on one local photo | Original stays local | That selected compressed photo, in the active session only |
| Ask Voice to send the latest photo and confirm (`send_latest_photo`) | Original stays local | That snapshotted compressed photo, in the active session only |
| Ask what the camera currently sees and confirm (`inspect_camera`) | Preview stays local | At most one compressed current frame per user turn |
| Stop camera | Yes | No |

The live feed is never streamed to OpenAI. A saved photo is never silently reused for vision and is never queued, retried, or uploaded later after an offline or API error. Button sending is the consent action itself; voice sending requires a native confirmation. `take_photo`, `send_latest_photo`, and `inspect_camera` are intentionally separate operations.

The same-origin frontend threat model still applies: malicious JavaScript delivered from the Voicear origin could access browser state, API keys, camera frames, and local photos. Keep production deployments free of third-party scripts, retain the restrictive CSP, and use only a trusted browser profile. A frontend-only BYOK deployment cannot hide a long-lived API key from its own JavaScript.

## What “visual conversation” means today

The selected Realtime models accept text, audio, and image input, but not a native video stream. Voicear therefore uses two explicit, on-demand image paths:

1. The user presses `[ CAMERA ]`; `getUserMedia({ audio: false, video: … })` creates a local preview.
2. The user explicitly asks a visual question such as “What do you see?”
3. The SDK pauses `inspect_camera` for a native one-time confirmation. Duplicate calls in the same user turn are rejected.
4. After approval, `inspect_camera` captures and compresses one current frame.
5. The Agents SDK sends it with `RealtimeSession.addImage(dataUrl, { triggerResponse: false })`.
6. The normal tool result continues the existing response exactly once; Voicear does not request a second response.
7. The transient Data URL is not persisted locally. The image is still a conversation item in the active OpenAI Realtime session and is subject to the API's data handling; ending the local session prevents it from being restored into a later session.

For a saved photo, `[ SEND TO AGENT ]` sends exactly that card with `addImage()` and starts one response. The voice tool snapshots the latest photo ID before showing its confirmation, then uses `addImage(dataUrl, { triggerResponse: false })` so the normal tool result continues exactly once. Both paths downscale a send-only JPEG copy; the stored original is unchanged. `SHARED THIS SESSION` is deliberately transient because the SDK's text-history replay does not restore image inputs into a replacement session; after reconnecting, the neutral status is `NOT SHARED THIS SESSION`. A photo that failed local persistence remains marked `NOT SAVED · DOWNLOAD NOW`, including after a successful share.

This matches the current [Realtime image-input protocol](https://developers.openai.com/api/docs/guides/realtime-conversations#image-inputs), the pinned Agents SDK [`RealtimeSession.addImage`](https://openai.github.io/openai-agents-js/openai/agents/realtime/classes/realtimesession/), and the documented input modalities of [gpt-realtime-2.1](https://developers.openai.com/api/docs/models/gpt-realtime-2.1) and [gpt-realtime-2.1-mini](https://developers.openai.com/api/docs/models/gpt-realtime-2.1-mini).

No second model, backend bridge, custom training, or local vision model is required. Image inputs do add context and image-token cost; Voicear therefore sends no periodic frames. See [Realtime costs](https://developers.openai.com/api/docs/guides/realtime-costs).

## Controls

- `[ CAMERA ]` starts, abandons a pending start, or stops the camera. Browser permission prompts cannot be programmatically canceled; Voicear blocks another request until the first settles and immediately stops any late stream. It is the only video-`getUserMedia()` path.
- `[ FEED ]` hides or restores only the preview. The camera remains active and the UI continues to say so.
- `[ PHOTO ]` saves a local JPEG in the active chat.
- `[ SEND TO AGENT ]` sends exactly that local photo to an already connected, foreground Realtime session. It never starts Voice or queues a later upload.
- `OPACITY` adjusts the background feed. Zero hides it; a positive value restores it. The last positive value is saved locally.
- `[ DOWNLOAD ]` uses a Blob URL and the native anchor `download` behavior.
- `[ DELETE ]` removes only the selected local photo.
- `[ FULLSCREEN ]` remains a separate manual Fullscreen API action. Camera CSS never enters document fullscreen itself.

Supported voice intents after manual camera start:

- stop camera;
- show or hide feed;
- set camera opacity from 0 to 100 percent;
- take a local photo;
- send the latest local photo after native confirmation;
- inspect the current view after an explicit visual question and native one-time confirmation.

Voice controls call the same state functions as the native buttons; they do not synthesize clicks. There is deliberately no `start_camera` tool.

## Local photo storage

Text history and photos are kept separately. Realtime `history_updated` replaces the text-derived message array, SDK item IDs can change during hydration, and chats are written frequently while text streams. Embedding Blobs in `Message` or `Chat` would therefore be both fragile and expensive.

IndexedDB version 4 includes a `photos` object store indexed by `chatId` and permanent, tiny deletion markers that prevent a delayed history writer in another tab from recreating a deleted chat. Each photo record stores the JPEG Blob, dimensions, capture time, and `afterMessageCount`. The count places a photo between text messages without depending on an unstable Realtime item ID. Equal positions sort by capture time and ID. Deleting a chat writes its marker and deletes the chat plus photo records in the same transaction.

The app initially renders the newest 100 text messages and their photos. `[ OLDER ]` expands this in 100-message steps. Object URLs exist only while their cards are rendered and are revoked on removal or chat change.

Browser storage is not a backup. `navigator.storage.persist()` is best effort, site-data clearing/private browsing/OS eviction can still remove IndexedDB data, and storage quota can be exhausted. Individual records are limited to 12 MiB and 8192 pixels per edge, but the active chat's photo records are loaded together; a photo-heavy chat can therefore still exhaust memory. If persistence fails after capture, Voicear keeps a temporary per-chat card until reload and asks the user to download it immediately. See [browser storage quotas and eviction](https://developer.mozilla.org/en-US/docs/Web/API/Storage_API/Storage_quotas_and_eviction_criteria).

The JSON history export contains text chats, not binary photo data. Download important photos individually. ZIP/binary export is deferred until users need bulk export.

## Mobile lifecycle and browser behavior

The preview video is always present with `autoplay`, `muted`, and `playsinline`; hiding the feed changes opacity rather than applying `display: none`. This avoids iPhone/WebKit frame stalls associated with non-inline or non-visible video pipelines. See [WebKit’s iOS video policies](https://webkit.org/blog/6784/new-video-policies-for-ios/) and [WebKit issue 260345](https://bugs.webkit.org/show_bug.cgi?id=260345).

Camera access requires a secure context and user permission. Voicear uses `ideal`, not `exact`, rear-camera constraints so normal browser fallback remains possible. See [`getUserMedia()`](https://developer.mozilla.org/en-US/docs/Web/API/MediaDevices/getUserMedia).

Every video track is synchronously stopped when:

- the user or Voice stops the camera;
- the page becomes hidden;
- `pagehide` fires;
- a newer Voicear tab takes media ownership; or
- the camera track ends.

A late permission result is rejected by a monotonic generation check and its tracks are immediately stopped. Returning to the page, reloading, focusing the tab, or restoring a PWA never restarts the camera. Background and lock-screen camera capture are not supported.

The PWA manifest uses `standalone`, not `fullscreen`. The document Fullscreen API still requires a direct user gesture and remains available only through its button. See [Web App Manifest display modes](https://www.w3.org/TR/appmanifest/#display-modes) and the [Fullscreen API security requirement](https://developer.mozilla.org/en-US/docs/Web/API/Element/requestFullscreen#security).

On iOS, the browser may open an image instead of honoring the suggested download filename. The website cannot guarantee “Save to Photos.” Web Share also requires a fresh tap and cannot be reliably invoked by a voice command, so it is not part of the first version.

## Roadmap

### Phase 1 — implemented

- Button-only, video-only camera start with permission-race protection.
- Full-viewport local feed behind a high-contrast transcript scrim.
- Native feed, photo, opacity, stop, and manual fullscreen controls.
- Voice stop/show/hide/opacity/local-photo tools.
- Approval-gated, one-frame `inspect_camera` for explicit visual questions, capped at one approval per user turn.
- Explicit per-card photo sending plus approval-gated voice sending of the snapshotted latest photo; both share the same one-image-per-user-turn voice guard.
- Local Blob photos in chat, reload persistence, download, delete, cascade deletion, and older-history paging.
- Active-tab ownership, hidden/pagehide stop, no automatic restart.
- iPhone-compatible inline video markup and responsive 320-pixel controls.

### Phase 2 — only after real-device evidence

- Manual front/rear camera switch if `facingMode: environment` proves insufficient.
- Native Share button if iPhone download behavior is materially worse than the current fallback.
- Better storage management, per-chat photo counts, and quota diagnostics for photo-heavy use.
- Optional explicit “inspect again” shortcut; still one frame per user request.

### Phase 3 — only after a demonstrated product need

- Adaptive, user-enabled periodic snapshots with an obvious transmit indicator and strict rate/cost limits. This is not a video stream and would require a new consent model.
- ZIP or other binary chat export for bulk photo backup.
- A small token-minting backend for public deployments so permanent Platform keys are not exposed to frontend JavaScript. OpenAI documents the ephemeral-token browser pattern in the [Realtime WebRTC guide](https://developers.openai.com/api/docs/guides/realtime-webrtc#creating-an-ephemeral-token).
- A local browser vision model only if offline semantic vision becomes a hard requirement and its download size, memory use, battery cost, model license, and iPhone performance are acceptable.

## Explicitly not promised

- Native continuous video input to the current Realtime models.
- Autonomous watching, motion detection, or periodic uploads.
- Camera start, permission prompts, restart, PWA fullscreen, download, or OS Share Sheet by voice.
- Camera use in a hidden tab, background, or lock screen.
- Video/audio recording, torch, zoom, camera selection, or photo editing.
- Automatic, queued, retried, background, or cross-tab upload of saved photos.
- Cross-device photo sync, cloud backup, or recovery after site data is cleared.
- Reliable iOS destination/filename control for downloads.

## Release verification

Automated checks cover the frame sizing/opacity helpers, TypeScript, existing local state, and production build. Before calling camera support production-ready, run these real-device checks:

1. Current iPhone Safari and installed Home Screen app.
2. Current Android Chrome.
3. Permission allow, deny, cancel, late allow, revoke, missing camera, and camera busy.
4. Portrait/landscape, screen lock, app switch, and tab ownership transfer; the camera indicator must turn off.
5. Camera plus local wake word, active Realtime microphone, speaker output, Bluetooth, and a phone/audio interruption.
6. Feed hidden and opacity zero while photo and explicit inspection still work.
7. Local photo reload, chat switch, older-history paging, download, delete, chat cascade, and quota failure.
8. Local photos remain `ON DEVICE` until the exact card button or an approved voice tool sends one; no delayed send after failure, no send after rejecting confirmation, and at most one approved voice-image send per user turn.
9. 320 CSS pixels, 200% text zoom, safe areas, VoiceOver/TalkBack, reduced motion, and a bright white camera scene.
