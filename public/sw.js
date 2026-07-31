const CACHE = "voice-local-v3";
const SHELL = [
  "/",
  "/global.css",
  "/icon-192.png",
  "/icon-512.png",
  "/icon.svg",
  "/manifest.webmanifest",
  "/wake-audio-worklet.js",
  "/openwakeword/models/melspectrogram.onnx",
  "/openwakeword/models/embedding_model.onnx",
  "/openwakeword/models/hey_jarvis_v0.1.onnx",
  "/openwakeword/models/silero_vad.onnx"
];

self.addEventListener("install", (event) => {
  event.waitUntil((async () => {
    const cache = await caches.open(CACHE);
    await cache.addAll(SHELL);
    const html = await (await cache.match("/")).text();
    const buildAssets = [...html.matchAll(/(?:src|href)="(\/_astro\/[^\"]+)"/g)].map((match) => match[1]);
    await cache.addAll(buildAssets);
    await self.skipWaiting();
  })());
});

self.addEventListener("activate", (event) => {
  event.waitUntil(caches.keys().then((keys) => Promise.all(keys.filter((key) => key !== CACHE).map((key) => caches.delete(key)))).then(() => self.clients.claim()));
});

self.addEventListener("fetch", (event) => {
  const { request } = event;
  if (request.method !== "GET" || new URL(request.url).origin !== self.location.origin) return;
  if (request.mode === "navigate") {
    event.respondWith(fetch(request).then(async (response) => {
      await (await caches.open(CACHE)).put("/", response.clone());
      return response;
    }).catch(() => caches.match("/")));
    return;
  }
  event.respondWith(fetch(request).then(async (response) => {
    await (await caches.open(CACHE)).put(request, response.clone());
    return response;
  }).catch(() => caches.match(request)));
});
