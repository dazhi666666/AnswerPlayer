class PCMResampler extends AudioWorkletProcessor {
  constructor() {
    super();
    this.inputRate = sampleRate;
    this.targetRate = 16000;
    this.ratio = this.targetRate / this.inputRate;
    this.buffer = [];
    this.FRAME_SIZE = 640;
  }

  process(inputs) {
    const input = inputs[0];
    if (!input || !input[0] || input[0].length === 0) return true;
    const channel = input[0];
    this.buffer.push(...channel);
    const neededInput = Math.ceil(this.FRAME_SIZE / this.ratio);
    while (this.buffer.length >= neededInput) {
      const output = new Int16Array(this.FRAME_SIZE);
      for (let i = 0; i < this.FRAME_SIZE; i++) {
        const src = i / this.ratio;
        const idx = Math.floor(src);
        const frac = src - idx;
        const s0 = this.buffer[idx] || 0;
        const s1 = this.buffer[idx + 1] || 0;
        const sample = s0 + (s1 - s0) * frac;
        const clamped = Math.max(-1, Math.min(1, sample));
        output[i] = clamped < 0 ? clamped * 0x8000 : clamped * 0x7FFF;
      }
      this.buffer.splice(0, neededInput);
      this.port.postMessage(output.buffer, [output.buffer]);
    }
    return true;
  }
}
registerProcessor('pcm-resampler', PCMResampler);
