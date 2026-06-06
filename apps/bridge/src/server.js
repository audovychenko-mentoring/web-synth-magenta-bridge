import { WebSocketServer } from "ws";

const PORT = Number(process.env.BRIDGE_PORT || 8787);
const SAMPLE_RATE = 48000;
const CHANNELS = 2;
const MAX_CAPTURE_FRAMES = SAMPLE_RATE * 28;

const server = new WebSocketServer({ port: PORT });

function rms(float32) {
  if (!float32.length) return 0;
  let sum = 0;
  for (let i = 0; i < float32.length; i += 1) sum += float32[i] * float32[i];
  return Math.sqrt(sum / float32.length);
}

function makeMockContinuation(frames, level) {
  const out = new Float32Array(frames * CHANNELS);
  const gain = Math.min(0.22, Math.max(0.04, level * 1.8));
  const base = 110 + Math.round(level * 900);
  for (let i = 0; i < frames; i += 1) {
    const t = i / SAMPLE_RATE;
    const env = Math.min(1, i / 2400) * Math.min(1, (frames - i) / 9600);
    const sample =
      Math.sin(2 * Math.PI * base * t) * 0.55 +
      Math.sin(2 * Math.PI * base * 1.5 * t) * 0.25 +
      Math.sin(2 * Math.PI * base * 2.01 * t) * 0.12;
    out[i * 2] = sample * gain * env;
    out[i * 2 + 1] = sample * gain * env;
  }
  return out;
}

function sendJson(socket, payload) {
  if (socket.readyState === socket.OPEN) {
    socket.send(JSON.stringify(payload));
  }
}

server.on("connection", (socket) => {
  let capture = new Float32Array(0);
  let packetCount = 0;
  let lastLevel = 0;

  sendJson(socket, {
    type: "bridge:ready",
    sampleRate: SAMPLE_RATE,
    channels: CHANNELS,
    mode: "mock"
  });

  socket.on("message", (data, isBinary) => {
    if (isBinary) {
      const chunk = new Float32Array(data.buffer, data.byteOffset, data.byteLength / 4);
      const availableFrames = Math.max(0, MAX_CAPTURE_FRAMES - capture.length / CHANNELS);
      const framesToAppend = Math.min(availableFrames, Math.floor(chunk.length / CHANNELS));
      if (framesToAppend > 0) {
        const next = new Float32Array(capture.length + framesToAppend * CHANNELS);
        next.set(capture);
        next.set(chunk.subarray(0, framesToAppend * CHANNELS), capture.length);
        capture = next;
      }
      packetCount += 1;
      lastLevel = rms(chunk);
      if (packetCount % 12 === 0) {
        sendJson(socket, {
          type: "capture:meter",
          frames: capture.length / CHANNELS,
          rms: lastLevel
        });
      }
      return;
    }

    let message;
    try {
      message = JSON.parse(data.toString());
    } catch {
      sendJson(socket, { type: "error", message: "Invalid JSON message" });
      return;
    }

    if (message.type === "capture:clear") {
      capture = new Float32Array(0);
      packetCount = 0;
      lastLevel = 0;
      sendJson(socket, { type: "capture:cleared" });
      return;
    }

    if (message.type === "magenta:prefill") {
      const frames = capture.length / CHANNELS;
      sendJson(socket, {
        type: "magenta:prefill:start",
        frames,
        seconds: frames / SAMPLE_RATE,
        mode: "mock"
      });

      const generated = makeMockContinuation(SAMPLE_RATE * 4, lastLevel || rms(capture));
      sendJson(socket, {
        type: "magenta:audio:start",
        frames: generated.length / CHANNELS,
        sampleRate: SAMPLE_RATE,
        channels: CHANNELS,
        mode: "mock"
      });
      socket.send(Buffer.from(generated.buffer));
      sendJson(socket, { type: "magenta:audio:end" });
      return;
    }

    sendJson(socket, { type: "error", message: `Unknown message type: ${message.type}` });
  });
});

console.log(`Magenta bridge listening on ws://localhost:${PORT}`);

