class CaptureProcessor extends AudioWorkletProcessor {
  constructor() {
    super();
    this.buffer = new Float32Array(4096 * 2);
    this.index = 0;
  }

  process(inputs) {
    const input = inputs[0];
    if (!input || input.length === 0) return true;

    const left = input[0];
    const right = input[1] || input[0];
    for (let i = 0; i < left.length; i += 1) {
      this.buffer[this.index++] = left[i];
      this.buffer[this.index++] = right[i];
      if (this.index >= this.buffer.length) {
        const payload = this.buffer.slice(0);
        this.port.postMessage(payload, [payload.buffer]);
        this.index = 0;
      }
    }
    return true;
  }
}

registerProcessor("capture-processor", CaptureProcessor);

