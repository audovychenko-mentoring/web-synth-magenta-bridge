class StreamPlayerProcessor extends AudioWorkletProcessor {
  constructor() {
    super();
    this.queue = [];
    this.readIndex = 0;
    this.port.onmessage = (event) => {
      if (event.data instanceof Float32Array) {
        this.queue.push(event.data);
      }
    };
  }

  process(_, outputs) {
    const output = outputs[0];
    const left = output[0];
    const right = output[1] || output[0];

    for (let i = 0; i < left.length; i += 1) {
      while (this.queue.length && this.readIndex >= this.queue[0].length) {
        this.queue.shift();
        this.readIndex = 0;
      }

      if (!this.queue.length) {
        left[i] = 0;
        right[i] = 0;
        continue;
      }

      const chunk = this.queue[0];
      left[i] = chunk[this.readIndex++] || 0;
      right[i] = chunk[this.readIndex++] || 0;
    }

    return true;
  }
}

registerProcessor("stream-player-processor", StreamPlayerProcessor);

