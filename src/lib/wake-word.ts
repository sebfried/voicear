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
  private firstFrameTimer = 0;
  private rejectFirstFrame: ((error: DOMException) => void) | null = null;
  private onDetect: (score: number) => void;
  private onError: (error: Error) => void;

  constructor(onDetect: (score: number) => void, onError: (error: Error) => void) {
    this.onDetect = onDetect;
    this.onError = onError;
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
      const streamPromise = navigator.mediaDevices.getUserMedia({
        audio: {
          channelCount: 1,
          echoCancellation: true,
          noiseSuppression: true,
          autoGainControl: true
        }
      }).then((stream) => {
        if (session !== this.session) {
          stream.getTracks().forEach((track) => track.stop());
          throw new DOMException("Lokaler Audiostart wurde unterbrochen.", "AbortError");
        }
        this.stream = stream;
        return stream;
      });
      const [stream] = await Promise.all([streamPromise, this.load()]);
      const context = this.context ?? new AudioContext({ latencyHint: "interactive" });
      this.context = context;
      await context.audioWorklet.addModule("/wake-audio-worklet.js");
      if (session !== this.session || this.context !== context) throw new DOMException("Lokaler Audiostart wurde unterbrochen.", "AbortError");
      this.source = context.createMediaStreamSource(stream);
      this.worklet = new AudioWorkletNode(context, "wake-audio-processor", { numberOfInputs: 1, numberOfOutputs: 1, outputChannelCount: [1] });
      this.worklet.port.onmessage = ({ data }: MessageEvent<Float32Array>) => this.enqueue(data);
      this.source.connect(this.worklet);
      this.worklet.connect(context.destination);
      if (context.state !== "running") void context.resume().catch(() => undefined);
      this.running = true;
      await new Promise<void>((resolve, reject) => {
        this.rejectFirstFrame = reject;
        this.firstFrameTimer = window.setTimeout(() => {
          this.clearFirstFrameWait();
          reject(new DOMException("Das iPhone liefert keine verarbeitbaren Mikrofonframes. Tippe einmal auf die Seite.", "NotReadableError"));
        }, 10_000);
        this.firstFrame = () => {
          this.clearFirstFrameWait();
          resolve();
        };
      });
    } catch (error) {
      const interrupted = session !== this.session;
      await this.stop();
      throw interrupted && (!(error instanceof DOMException) || error.name !== "AbortError")
        ? new DOMException("Lokaler Audiostart wurde unterbrochen.", "AbortError")
        : error;
    }
  }

  async resume() {
    if (!this.context) this.context = new AudioContext({ latencyHint: "interactive" });
    const context = this.context;
    if (!context || context.state === "running" || context.state === "closed") return;
    await context.resume();
    if (this.context !== context) return;
    const state = context.state as AudioContextState;
    if (state !== "running") throw new Error(`Lokales Audio ist unterbrochen (${state}).`);
  }

  async stop() {
    this.running = false;
    this.session++;
    this.pending = [];
    const rejectFirstFrame = this.rejectFirstFrame;
    this.clearFirstFrameWait();
    rejectFirstFrame?.(new DOMException("Lokaler Audiostart wurde beendet.", "AbortError"));
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

  private clearFirstFrameWait() {
    window.clearTimeout(this.firstFrameTimer);
    this.firstFrameTimer = 0;
    this.firstFrame = null;
    this.rejectFirstFrame = null;
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
