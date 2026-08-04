import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import vm from "node:vm";
import type { RealtimeItem } from "@openai/agents/realtime";
import { historyToMessages, messagesToHistory, withoutHistoryItems } from "./realtime-history.ts";
import { chatTitle, findChats, normalizeCommand, type Chat, type Message } from "./state.ts";

assert.equal(normalizeCommand("  Pause,   Voice! "), "pause voice");
assert.equal(chatTitle("Ein kurzer Titel"), "EIN KURZER TITEL");
assert.ok(chatTitle("Ein sehr langer Titel für einen Chat, der sicher gekürzt werden muss").length <= 45);

const chats = [
  { id: "1", title: "REISE WIEN", createdAt: 1, updatedAt: 1, messages: [] },
  { id: "2", title: "REISE BERLIN", createdAt: 2, updatedAt: 2, messages: [] }
] satisfies Chat[];
assert.deepEqual(findChats(chats, "berlin").map(({ id }) => id), ["2"]);

const messages = [
  { id: "stored-user-id", role: "user", text: "Hallo", status: "completed" },
  { id: "64073129-ae81-4f3e-a498-cd13bed22f82", role: "assistant", text: "Servus", status: "completed" }
] satisfies Message[];
const history = messagesToHistory(messages);
assert.deepEqual(messagesToHistory(messages).map(({ itemId }) => itemId), history.map(({ itemId }) => itemId));
assert.ok(history.every(({ itemId }) => itemId.length <= 32));
assert.equal(history[1]?.previousItemId, history[0]?.itemId);
assert.deepEqual(historyToMessages(history).map(({ role, text }) => ({ role, text })), [
  { role: "user", text: "Hallo" },
  { role: "assistant", text: "Servus" }
]);
const hidden = [
  { itemId: "system", type: "message", role: "system", content: [{ type: "input_text", text: "Hidden" }] },
  { itemId: "tool", type: "function_call", status: "completed", arguments: "{}", name: "noop", output: "Hidden" }
] satisfies RealtimeItem[];
assert.deepEqual(historyToMessages(hidden), []);
assert.deepEqual(withoutHistoryItems([...history, ...hidden], new Set([history[1]!.itemId, "tool"])).map(({ itemId }) => itemId), [history[0]!.itemId, "system"]);

let WakeAudioProcessor: new () => { frameOffset: number; resample(input: Float32Array): void };
vm.runInNewContext(readFileSync(new URL("../../public/wake-audio-worklet.js", import.meta.url), "utf8"), {
  AudioWorkletProcessor: class { port = { postMessage() {} }; },
  Float32Array,
  registerProcessor: (_name: string, processor: typeof WakeAudioProcessor) => { WakeAudioProcessor = processor; },
  sampleRate: 48_000
});
const processor = new WakeAudioProcessor!();
for (let offset = 0; offset < 48_000; offset += 128) processor.resample(new Float32Array(128));
assert.equal(processor.frameOffset, 640);

class FakeWorker {
  onmessage = null;
  onerror = null;
  postMessage() {}
  terminate() {}
}
let audioContextCreates = 0;
let audioContextResumes = 0;
class FakeAudioContext {
  state = "suspended";
  constructor() { audioContextCreates++; }
  async resume() { audioContextResumes++; this.state = "running"; }
  async close() { this.state = "closed"; }
}
Object.defineProperty(globalThis, "Worker", { configurable: true, value: FakeWorker });
Object.defineProperty(globalThis, "AudioContext", { configurable: true, value: FakeAudioContext });
Object.defineProperty(globalThis, "window", { configurable: true, value: globalThis });
const { WakeWordDetector } = await import("./wake-word.ts");
const detector = new WakeWordDetector(() => {}, () => {});
await detector.resume();
assert.equal(audioContextCreates, 1);
assert.equal(audioContextResumes, 1);
await detector.destroy();

let resolveMicrophone!: (stream: { getTracks: () => Array<{ stop: () => void }> }) => void;
let stoppedTracks = 0;
Object.defineProperty(globalThis, "navigator", {
  configurable: true,
  value: { mediaDevices: { getUserMedia: () => new Promise((resolve) => { resolveMicrophone = resolve; }) } }
});
const interruptedDetector = new WakeWordDetector(() => {}, () => {});
const interruptedStart = interruptedDetector.start();
await Promise.resolve();
await interruptedDetector.stop();
resolveMicrophone({ getTracks: () => [{ stop: () => { stoppedTracks++; } }] });
await assert.rejects(interruptedStart, (error: DOMException) => error.name === "AbortError");
assert.equal(stoppedTracks, 1);
await interruptedDetector.destroy();

const appSource = readFileSync(new URL("../scripts/app.ts", import.meta.url), "utf8");
const gestureHandler = appSource.slice(appSource.indexOf("const resumeWakeFromGesture"), appSource.indexOf("agentList.addEventListener"));
assert.ok(gestureHandler.indexOf("wakeDetector?.resume()") < gestureHandler.indexOf("wakeSubscribed || wakeStarting"));
assert.match(gestureHandler, /addEventListener\("click", resumeWakeFromGesture/);
const wakeSource = readFileSync(new URL("./wake-word.ts", import.meta.url), "utf8");
assert.ok(wakeSource.indexOf("getUserMedia") < wakeSource.indexOf("new AudioContext"));
assert.doesNotMatch(wakeSource, /sampleRate:\s*\{\s*ideal:/);
const pageSource = readFileSync(new URL("../pages/index.astro", import.meta.url), "utf8");
assert.match(pageSource, /name="voicear-build"/);
assert.match(pageSource, /id="voice-button"/);
assert.match(appSource, /fetch\(`\/\?_voicear_check=\$\{Date\.now\(\)\}`,[^}]+cache: "no-store"/);
assert.match(appSource, /location\.replace\(url\)/);
const voiceHandler = appSource.slice(appSource.indexOf('voiceButton.addEventListener("click"'), appSource.indexOf("const resumeWakeFromGesture"));
assert.match(voiceHandler, /claimAudioOwnership\(\)/);
assert.match(voiceHandler, /startRealtime\(\)/);
assert.match(voiceHandler, /endRealtime\("READY"\)/);
assert.match(appSource, /closest\?\.\("#voice-button"\)/);

console.log("state checks passed");
