class StreamPlayerProcessor extends AudioWorkletProcessor {
  constructor() {
    super();
    this.queue = [];
    this.readIndex = 0;
    this.bufferedSamples = 0;
    this.started = false;
    this.prebufferSamples = 48000;
    this.port.onmessage = (event) => {
      if (event.data?.type === "reset") {
        this.queue = [];
        this.readIndex = 0;
        this.bufferedSamples = 0;
        this.started = false;
        return;
      }
      if (event.data instanceof Float32Array) {
        this.queue.push(event.data);
        this.bufferedSamples += event.data.length;
      }
    };
  }

  process(_, outputs) {
    const output = outputs[0];
    const left = output[0];
    const right = output[1] || output[0];

    if (!this.started && this.bufferedSamples >= this.prebufferSamples) {
      this.started = true;
    }

    for (let i = 0; i < left.length; i += 1) {
      while (this.queue.length && this.readIndex >= this.queue[0].length) {
        this.queue.shift();
        this.readIndex = 0;
      }

      if (!this.started || !this.queue.length) {
        left[i] = 0;
        right[i] = 0;
        continue;
      }

      const chunk = this.queue[0];
      const sampleL = chunk[this.readIndex++] || 0;
      const sampleR = chunk[this.readIndex++] || 0;
      this.bufferedSamples = Math.max(0, this.bufferedSamples - 2);
      left[i] = Math.max(-1, Math.min(1, sampleL));
      right[i] = Math.max(-1, Math.min(1, sampleR));

      if (this.bufferedSamples === 0) {
        this.started = false;
      }
    }

    return true;
  }
}

registerProcessor("stream-player-processor", StreamPlayerProcessor);
