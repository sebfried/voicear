// Browser/ONNX pipeline adapted from openWakeWord v0.5.1 (Apache-2.0).
// Model-specific licenses are documented in public/THIRD_PARTY_NOTICES.md.
import * as ort from "onnxruntime-web/wasm";

const MODEL_ROOT = "/openwakeword/models";
const SAMPLE_RATE = 16_000;
const FRAME_SAMPLES = 1_280;
const PCM_OVERLAP = 480;
const MEL_FRAMES = 76;
const MEL_BINS = 32;
const EMBEDDING_FRAMES = 16;
const EMBEDDING_SIZE = 96;
const WAKE_THRESHOLD = 0.5;
const VAD_THRESHOLD = 0.5;
const VAD_HANGOVER_FRAMES = 12;

ort.env.wasm.numThreads = 1;

type SessionSet = {
  mel: ort.InferenceSession;
  embedding: ort.InferenceSession;
  wake: ort.InferenceSession;
  vad: ort.InferenceSession;
};

type WorkerRequest =
  | { type: "init" }
  | { type: "reset"; session: number }
  | { type: "frame"; session: number; samples: ArrayBuffer };

const scope = self as unknown as {
  onmessage: ((event: MessageEvent<WorkerRequest>) => void) | null;
  postMessage: (message: unknown) => void;
};

let sessions: SessionSet | null = null;
let loading: Promise<void> | null = null;
let activeSession = 0;
let queue = Promise.resolve();
let pcmTail = new Float32Array(0);
let melWindow = new Float32Array(MEL_FRAMES * MEL_BINS).fill(1);
let embeddingWindow = new Float32Array(EMBEDDING_FRAMES * EMBEDDING_SIZE);
let embeddingCount = 0;
let vadH: ort.Tensor = new ort.Tensor("float32", new Float32Array(128), [2, 1, 64]);
let vadC: ort.Tensor = new ort.Tensor("float32", new Float32Array(128), [2, 1, 64]);
let vadHangover = 0;
let detected = false;

const postError = (error: unknown) => {
  scope.postMessage({ type: "error", message: error instanceof Error ? error.message : "Lokale Wake-Word-Inferenz fehlgeschlagen." });
};

const load = () => loading ??= Promise.all([
  ort.InferenceSession.create(`${MODEL_ROOT}/melspectrogram.onnx`, { executionProviders: ["wasm"] }),
  ort.InferenceSession.create(`${MODEL_ROOT}/embedding_model.onnx`, { executionProviders: ["wasm"] }),
  ort.InferenceSession.create(`${MODEL_ROOT}/hey_jarvis_v0.1.onnx`, { executionProviders: ["wasm"] }),
  ort.InferenceSession.create(`${MODEL_ROOT}/silero_vad.onnx`, { executionProviders: ["wasm"] })
]).then(([mel, embedding, wake, vad]) => {
  sessions = { mel, embedding, wake, vad };
}).catch((error) => {
  loading = null;
  throw error;
});

const reset = (session: number) => {
  activeSession = session;
  pcmTail = new Float32Array(0);
  melWindow = new Float32Array(MEL_FRAMES * MEL_BINS).fill(1);
  embeddingWindow = new Float32Array(EMBEDDING_FRAMES * EMBEDDING_SIZE);
  embeddingCount = 0;
  vadH = new ort.Tensor("float32", new Float32Array(128), [2, 1, 64]);
  vadC = new ort.Tensor("float32", new Float32Array(128), [2, 1, 64]);
  vadHangover = 0;
  detected = false;
};

const inputName = (session: ort.InferenceSession) => session.inputNames[0];
const output = (session: ort.InferenceSession, results: ort.InferenceSession.OnnxValueMapType) =>
  results[session.outputNames[0]].data as Float32Array;

const runVad = async (frame: Float32Array) => {
  const current = sessions!;
  const results = await current.vad.run({
    input: new ort.Tensor("float32", frame, [1, FRAME_SAMPLES]),
    sr: new ort.Tensor("int64", new BigInt64Array([BigInt(SAMPLE_RATE)]), []),
    h: vadH,
    c: vadC
  });
  vadH = results.hn as ort.Tensor;
  vadC = results.cn as ort.Tensor;
  if (Number((results.output.data as Float32Array)[0]) > VAD_THRESHOLD) vadHangover = VAD_HANGOVER_FRAMES;
  else vadHangover = Math.max(0, vadHangover - 1);
  return vadHangover > 0;
};

const updateMelWindow = async (frame: Float32Array) => {
  const current = sessions!;
  const pcm = new Float32Array(pcmTail.length + frame.length);
  for (let index = 0; index < pcmTail.length; index++) pcm[index] = pcmTail[index] * 32767;
  for (let index = 0; index < frame.length; index++) pcm[pcmTail.length + index] = Math.max(-1, Math.min(1, frame[index])) * 32767;
  pcmTail = frame.slice(-PCM_OVERLAP);

  const results = await current.mel.run({
    [inputName(current.mel)]: new ort.Tensor("float32", pcm, [1, pcm.length])
  });
  const raw = output(current.mel, results);
  const normalized = new Float32Array(raw.length);
  for (let index = 0; index < raw.length; index++) normalized[index] = raw[index] / 10 + 2;

  const addedFrames = normalized.length / MEL_BINS;
  const shift = Math.min(MEL_FRAMES, addedFrames) * MEL_BINS;
  melWindow.copyWithin(0, shift);
  melWindow.set(normalized.subarray(Math.max(0, normalized.length - melWindow.length)), melWindow.length - Math.min(normalized.length, melWindow.length));
};

const runWakeModel = async () => {
  const current = sessions!;
  const embeddingResults = await current.embedding.run({
    [inputName(current.embedding)]: new ort.Tensor("float32", melWindow, [1, MEL_FRAMES, MEL_BINS, 1])
  });
  const embedding = output(current.embedding, embeddingResults);
  embeddingWindow.copyWithin(0, EMBEDDING_SIZE);
  embeddingWindow.set(embedding.subarray(0, EMBEDDING_SIZE), embeddingWindow.length - EMBEDDING_SIZE);
  embeddingCount++;
  if (embeddingCount < EMBEDDING_FRAMES) return 0;

  const wakeResults = await current.wake.run({
    [inputName(current.wake)]: new ort.Tensor("float32", embeddingWindow, [1, EMBEDDING_FRAMES, EMBEDDING_SIZE])
  });
  return Number(output(current.wake, wakeResults)[0]);
};

const processFrame = async (session: number, samples: ArrayBuffer) => {
  if (session !== activeSession || detected) return;
  await load();
  const frame = new Float32Array(samples);
  if (frame.length !== FRAME_SAMPLES) throw new Error(`Ungültiger Audioframe: ${frame.length} statt ${FRAME_SAMPLES} Samples.`);
  const speech = await runVad(frame);
  await updateMelWindow(frame);
  const score = await runWakeModel();
  if (session === activeSession && speech && score >= WAKE_THRESHOLD) {
    detected = true;
    scope.postMessage({ type: "detected", session, score });
  }
};

scope.onmessage = ({ data }) => {
  if (data.type === "init") {
    void load().then(() => scope.postMessage({ type: "ready" })).catch(postError);
    return;
  }
  if (data.type === "reset") {
    reset(data.session);
    return;
  }
  queue = queue.then(() => processFrame(data.session, data.samples))
    .catch(postError)
    .finally(() => scope.postMessage({ type: "processed", session: data.session }));
};
