type WakeWorkerMessage =
  | { type: "ready" }
  | { type: "processed"; session: number }
  | { type: "detected"; session: number; score: number }
  | { type: "error"; message: string };

export class WakeWordDetector {
  private worker = new Worker(new URL("../scripts/wake-worker.ts", import.meta.url), { type: "module" });
  private ready: Promise<void> | null = null;
  private resolveReady: (() => void) | null = null;
  private rejectReady: ((error: Error) => void) | null = null;
  private stream: MediaStream | null = null;
  private context: AudioContext | null = null;
  private source: MediaStreamAudioSourceNode | null = null;
  private worklet: AudioWorkletNode | null = null;
  private session = 0;
  private running = false;
  private starting: Promise<void> | null = null;
  private busy = false;
  private detected = false;
  private pending: ArrayBuffer[] = [];
  private firstFrame: (() => void) | null = null;

  constructor(private onDetect: (score: number) => void, private onError: (error: Error) => void) {
    this.worker.onmessage = ({ data }: MessageEvent<WakeWorkerMessage>) => this.handleWorkerMessage(data);
    this.worker.onerror = (event) => this.handleError(new Error(event.message || "Wake-Word-Worker abgestürzt."));
  }

  load() {
    if (this.ready) return this.ready;
    this.ready = new Promise<void>((resolve, reject) => {
      this.resolveReady = resolve;
      this.rejectReady = reject;
      this.worker.postMessage({ type: "init" });
    }).catch((error) => {
      this.ready = null;
      throw error;
    });
    return this.ready;
  }

  async start() {
    if (this.running) return;
    if (this.starting) return this.starting;
    this.starting = this.startInternal();
    try {
      await this.starting;
    } finally {
      this.starting = null;
    }
  }

  private async startInternal() {
    const session = ++this.session;
    this.worker.postMessage({ type: "reset", session });
    this.detected = false;
    this.busy = false;
    this.pending = [];

    try {
      const context = new AudioContext({ latencyHint: "interactive", sampleRate: 16_000 });
      this.context = context;
      const resume = context.resume();
      this.stream = await navigator.mediaDevices.getUserMedia({
        audio: {
          channelCount: 1,
          sampleRate: { ideal: 16_000 },
          echoCancellation: true,
          noiseSuppression: true,
          autoGainControl: true
        }
      });
      await Promise.all([this.load(), resume]);
      if (session !== this.session || this.context !== context) throw new Error("Lokaler Audiostart wurde unterbrochen. Tippe einmal auf die Seite.");
      await context.audioWorklet.addModule("/wake-audio-worklet.js");
      this.source = context.createMediaStreamSource(this.stream);
      this.worklet = new AudioWorkletNode(context, "wake-audio-processor", { numberOfInputs: 1, numberOfOutputs: 1, outputChannelCount: [1] });
      this.worklet.port.onmessage = ({ data }: MessageEvent<Float32Array>) => this.enqueue(data);
      this.source.connect(this.worklet);
      this.worklet.connect(context.destination);
      if (context.state !== "running") await context.resume();
      if (context.state !== "running") throw new Error(`Lokales Audio konnte nicht gestartet werden (${context.state}). Tippe erneut auf START VOICE.`);
      this.running = true;
      await new Promise<void>((resolve, reject) => {
        const timeout = window.setTimeout(() => reject(new Error("Das iPhone liefert keine verarbeitbaren Mikrofonframes. Tippe einmal auf die Seite.")), 10_000);
        this.firstFrame = () => {
          window.clearTimeout(timeout);
          resolve();
        };
      });
    } catch (error) {
      await this.stop();
      throw error;
    }
  }

  async resume() {
    if (!this.running || !this.context || this.context.state === "running") return;
    await this.context.resume();
    const state = this.context.state as AudioContextState;
    if (state !== "running") throw new Error(`Lokales Audio ist unterbrochen (${state}).`);
  }

  async stop() {
    this.running = false;
    this.session++;
    this.pending = [];
    this.firstFrame = null;
    this.busy = false;
    if (this.worklet) {
      this.worklet.port.onmessage = null;
      this.worklet.port.close();
      this.worklet.disconnect();
      this.worklet = null;
    }
    this.source?.disconnect();
    this.source = null;
    this.stream?.getTracks().forEach((track) => track.stop());
    this.stream = null;
    if (this.context && this.context.state !== "closed") await this.context.close();
    this.context = null;
  }

  async destroy() {
    await this.stop();
    this.worker.terminate();
  }

  private enqueue(frame: Float32Array) {
    if (!this.running || this.detected) return;
    if (this.busy) {
      this.pending.push(frame.buffer as ArrayBuffer);
      if (this.pending.length > 8) this.pending.shift();
      return;
    }
    this.send(frame.buffer as ArrayBuffer);
  }

  private send(samples: ArrayBuffer) {
    this.busy = true;
    this.worker.postMessage({ type: "frame", session: this.session, samples }, [samples]);
  }

  private handleWorkerMessage(message: WakeWorkerMessage) {
    if (message.type === "ready") {
      this.resolveReady?.();
      this.resolveReady = null;
      this.rejectReady = null;
      return;
    }
    if (message.type === "error") {
      this.handleError(new Error(message.message));
      return;
    }
    if (message.session !== this.session) return;
    if (message.type === "detected" && this.running && !this.detected) {
      this.detected = true;
      this.onDetect(message.score);
      return;
    }
    if (message.type === "processed") {
      this.firstFrame?.();
      this.firstFrame = null;
      if (this.pending.length && this.running && !this.detected) {
        const next = this.pending.shift()!;
        this.send(next);
      } else {
        this.busy = false;
      }
    }
  }

  private handleError(error: Error) {
    this.rejectReady?.(error);
    this.resolveReady = null;
    this.rejectReady = null;
    if (this.running) this.onError(error);
  }
}
