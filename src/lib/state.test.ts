import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import vm from "node:vm";
import { chatTitle, findChats, messagesToHistory, normalizeCommand, type Chat } from "./state.ts";

assert.equal(normalizeCommand("  Pause,   Voice! "), "pause voice");
assert.equal(chatTitle("Ein kurzer Titel"), "EIN KURZER TITEL");
assert.ok(chatTitle("Ein sehr langer Titel für einen Chat, der sicher gekürzt werden muss").length <= 45);

const chats = [
  { id: "1", title: "REISE WIEN", createdAt: 1, updatedAt: 1, messages: [] },
  { id: "2", title: "REISE BERLIN", createdAt: 2, updatedAt: 2, messages: [] }
] satisfies Chat[];
assert.deepEqual(findChats(chats, "berlin").map(({ id }) => id), ["2"]);

const history = messagesToHistory([{ id: "stored-id", role: "user", text: "Hallo", status: "completed" }]);
assert.equal(history[0]?.itemId.length, 32);

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

console.log("state checks passed");
