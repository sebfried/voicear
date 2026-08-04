# Voice

Frameworkfreie, lokale Web-App für OpenAI Realtime Voice mit lokalem „Hey Jarvis“, Chat-History und Sprachsteuerung.

```sh
pnpm install
pnpm dev
```

Der Dev-Server lauscht standardmäßig im lokalen Netzwerk über HTTPS. Beim ersten Aufruf muss das selbstsignierte Entwicklungszertifikat im Browser bestätigt werden.

Dann im Browser einen **OpenAI Platform API Key** eintragen. Er bleibt dauerhaft im `localStorage` dieses Browsers; Chats liegen lokal in IndexedDB. „Hey Jarvis“ läuft mit openWakeWord und ONNX Runtime Web vollständig im Browser. Erst nach der lokalen Erkennung wird eine neue Mikrofon-Session für OpenAI Realtime geöffnet. Für Mikrofon, Wake Lock, Fullscreen und PWA-Installation ist HTTPS erforderlich.

Alternativ kann der Key einmalig über `https://HOST:4321/?key=OPENAI_KEY` importiert werden. Die App übernimmt ihn in den `localStorage` und entfernt `key` sofort aus URL und Browser-Verlauf. Query-Parameter können beim ersten Request dennoch in Server- oder Proxy-Logs erscheinen; diese Variante deshalb nur in einer vertrauenswürdigen lokalen Umgebung verwenden.

Ein ChatGPT-Abo ist keine API-Freigabe. OpenAI bietet für Realtime im Browser derzeit keinen allgemeinen ChatGPT-OAuth-Flow; ein normaler Platform-Key im Frontend ist auslesbar. Diese BYOK-Variante ist deshalb für persönliche Geräte gedacht. Für eine öffentlich geteilte Installation ist ein kleiner Server-Endpunkt für kurzlebige `ek_`-Tokens erforderlich.

Sprachbefehle: neuer Chat, Chat wechseln/auflisten/anzeigen, Schrift größer/kleiner oder Prozentwert, `Pause Voice`, `Stop Voice`, `Current Voice` sowie lokale Agents einrichten/testen, Aufgaben delegieren und die Agent Inbox lesen.

Die Kamera startet aus Datenschutzgründen ausschließlich über `[ CAMERA ]`. Danach kann Voice sie stoppen, den lokalen Hintergrund-Feed zeigen/verbergen, seine Opacity ändern, ein ausschließlich lokal gespeichertes Foto aufnehmen oder nach einer ausdrücklichen visuellen Frage und Einmal-Bestätigung höchstens einen aktuellen Frame analysieren. Fotos erscheinen im Chat und lassen sich einzeln herunterladen. Architektur, Privacy-Grenzen, Browser-Limits, Testmatrix und Roadmap: [`docs/camera.md`](docs/camera.md).

## Optionale lokale Agents

Unter `[ CHATS ] → [ LOCAL AGENTS ]` können mehrere Hermes- oder OpenClaw-Verbindungen gespeichert werden. Voice funktioniert ohne sie unverändert. Profile liegen im `localStorage`; Agent-Zugänge, die nicht exportierbare OpenClaw-Geräteidentität und Inbox-Aufträge liegen in IndexedDB. Nach Reload, Netzwechsel oder iOS-Suspend baut die App den Socket neu auf und gleicht offene Aufträge ab – ein Browser kann keinen laufenden Socket selbst dauerhaft speichern.

- Hermes: `https://`-Endpoint, `API_SERVER_KEY` und die exakte Voice-Origin in `API_SERVER_CORS_ORIGINS`.
- OpenClaw: `wss://`-Gateway, optionaler Agent-Name und bei der Ersteinrichtung ein Gateway-Token; Geräte-Pairing kann bestätigt werden müssen. Der offizielle Browser-Client ist exakt auf die angezeigte Beta-Version fixiert.
- Tailscale Serve ist eine optionale private Netzwerkstrecke. Tailscale-Anmeldung erfolgt im Tailscale-Client des Geräts; Voice speichert keinen Tailscale-Key und führt keinen Tailscale-OAuth-Flow aus. Ein direkt erreichbarer, korrekt abgesicherter HTTPS/WSS-Endpoint funktioniert ebenfalls.

Neue Agent-Ergebnisse bleiben in der separaten Inbox. Nur ein Ergebnis, das live während einer bereits aktiven Voice-Session eintrifft, darf einmal isoliert und ohne Tools zusammengefasst werden. Reconciliation, App-Start und Voice-Idle spielen nichts später nach. Architektur, Sicherheitsgrenzen und Alternativen: [`docs/channels.md`](docs/channels.md), [`docs/messages.md`](docs/messages.md), [`docs/options.md`](docs/options.md).

Die unveränderten openWakeWord-v0.5.1-Modellartefakte werden lokal aus `public/openwakeword/models` ausgeliefert und vom Service Worker gecacht. Der openWakeWord-Code ist Apache-2.0; die mitgelieferten vortrainierten Modelle einschließlich „Hey Jarvis“ stehen unter CC BY-NC-SA 4.0. Details und Attribution: `public/openwakeword/NOTICE.md`.

## Produktion

```sh
pnpm install --frozen-lockfile
pnpm check
pnpm test
pnpm build
```

Danach `dist/` auf einem statischen HTTPS-Host im Web-Root veröffentlichen.
