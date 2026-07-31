class WakeAudioProcessor extends AudioWorkletProcessor {
  constructor() {
    super();
    this.frame = new Float32Array(1280);
    this.frameOffset = 0;
    this.carry = new Float32Array(0);
    this.readOffset = 0;
  }

  push(sample) {
    this.frame[this.frameOffset++] = sample;
    if (this.frameOffset !== this.frame.length) return;
    const completed = this.frame;
    this.port.postMessage(completed, [completed.buffer]);
    this.frame = new Float32Array(1280);
    this.frameOffset = 0;
  }

  resample(input) {
    const combined = new Float32Array(this.carry.length + input.length);
    combined.set(this.carry);
    combined.set(input, this.carry.length);
    const ratio = sampleRate / 16000;

    while (this.readOffset + 1 < combined.length) {
      const index = Math.floor(this.readOffset);
      const fraction = this.readOffset - index;
      this.push(combined[index] + (combined[index + 1] - combined[index]) * fraction);
      this.readOffset += ratio;
    }

    // Keep one sample so interpolation and phase continue across render blocks.
    const consumed = Math.min(Math.floor(this.readOffset), combined.length - 1);
    this.carry = combined.slice(consumed);
    this.readOffset -= consumed;
  }

  process(inputs) {
    const input = inputs[0]?.[0];
    if (!input) return true;
    if (sampleRate === 16000) {
      for (const sample of input) this.push(sample);
    } else {
      this.resample(input);
    }
    return true;
  }
}

registerProcessor("wake-audio-processor", WakeAudioProcessor);
