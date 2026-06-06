import { WebSocketServer } from "ws";
import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const PORT = Number(process.env.BRIDGE_PORT || 8787);
const SAMPLE_RATE = 48000;
const CHANNELS = 2;
const MAX_CAPTURE_FRAMES = SAMPLE_RATE * 28;
const MODEL = process.env.MAGENTA_MODEL || "mrt2_base";
const DEFAULT_PROMPT =
  process.env.MAGENTA_PROMPT || "ambient plant music with soft evolving synths";
const DEFAULT_DURATION = Number(process.env.MAGENTA_DURATION || 4);
const MAX_DURATION = Number(process.env.MAGENTA_MAX_DURATION || 20);
const MAGENTA_FRAME_RATE = 25;
const __dirname = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(__dirname, "../../..");
const pythonBin = resolve(repoRoot, ".venv/bin/python");
const streamScript = resolve(__dirname, "../scripts/stream_magenta.py");

const server = new WebSocketServer({ port: PORT });
let worker = null;

function rms(float32) {
  if (!float32.length) return 0;
  let sum = 0;
  for (let i = 0; i < float32.length; i += 1) sum += float32[i] * float32[i];
  return Math.sqrt(sum / float32.length);
}

function sendJson(socket, payload) {
  if (socket.readyState === socket.OPEN) {
    socket.send(JSON.stringify(payload));
  }
}

function plantPrompt(level) {
  if (level > 0.08) {
    return `${DEFAULT_PROMPT}, dense and reactive, strong pulsing rhythm`;
  }
  if (level > 0.025) {
    return `${DEFAULT_PROMPT}, gently pulsing, organic electronic texture`;
  }
  return DEFAULT_PROMPT;
}

function workerLogs() {
  return worker?.logs.slice(-40).join("\n") || "";
}

function rejectWorkerRequest(error) {
  if (!worker?.active) return;
  const active = worker.active;
  worker.active = null;
  active.reject(error);
}

function finishWorkerRequest() {
  if (!worker?.active) return;
  const active = worker.active;
  worker.active = null;
  active.resolve({ logs: workerLogs() });
}

function parseWorkerStdout(chunk) {
  if (!worker) return;
  worker.output = Buffer.concat([worker.output, chunk]);

  while (worker.output.length >= 4) {
    const byteLength = worker.output.readUInt32LE(0);
    if (worker.output.length < 4 + byteLength) return;

    const payload = worker.output.subarray(4, 4 + byteLength);
    worker.output = worker.output.subarray(4 + byteLength);

    if (byteLength === 0) {
      finishWorkerRequest();
      continue;
    }

    const active = worker.active;
    if (active?.socket.readyState === active.socket.OPEN) {
      active.socket.send(payload);
    }
  }
}

function ensureWorker() {
  if (worker?.child.exitCode === null) return worker;

  if (!existsSync(pythonBin)) {
    throw new Error(`Python virtualenv not found at ${pythonBin}`);
  }
  if (!existsSync(streamScript)) {
    throw new Error(`Streaming worker not found at ${streamScript}`);
  }

  const child = spawn(
    pythonBin,
    [
      streamScript,
      "--model",
      MODEL
    ],
    {
      cwd: repoRoot,
      env: {
        ...process.env,
        PYTHONUNBUFFERED: "1"
      },
      stdio: ["pipe", "pipe", "pipe"]
    }
  );

  worker = {
    child,
    output: Buffer.alloc(0),
    logs: [],
    active: null
  };

  child.stdout.on("data", parseWorkerStdout);
  child.stderr.on("data", (chunk) => {
    const text = chunk.toString("utf8");
    worker?.logs.push(...text.split(/\r?\n/).filter(Boolean));
    if (worker && worker.logs.length > 200) worker.logs = worker.logs.slice(-200);
  });
  child.on("error", (error) => rejectWorkerRequest(error));
  child.on("close", (code) => {
    rejectWorkerRequest(new Error(`Magenta stream worker exited with ${code}`));
    worker = null;
  });

  return worker;
}

function streamMagenta(socket, { prompt, duration }) {
  return new Promise((resolvePromise, reject) => {
    const activeWorker = ensureWorker();
    if (activeWorker.active) {
      reject(new Error("Magenta stream worker is already generating"));
      return;
    }

    activeWorker.active = {
      socket,
      resolve: resolvePromise,
      reject
    };

    activeWorker.child.stdin.write(`${JSON.stringify({
      type: "generate",
      prompt,
      frames: Math.max(1, Math.round(duration * MAGENTA_FRAME_RATE))
    })}\n`);
  });
}

server.on("connection", (socket) => {
  let capture = new Float32Array(0);
  let packetCount = 0;
  let lastLevel = 0;
  let isGenerating = false;

  sendJson(socket, {
    type: "bridge:ready",
    sampleRate: SAMPLE_RATE,
    channels: CHANNELS,
    mode: "magenta",
    model: MODEL
  });

  socket.on("message", async (data, isBinary) => {
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

    if (message.type === "magenta:prefill" || message.type === "magenta:generate") {
      if (isGenerating) {
        sendJson(socket, { type: "error", message: "Magenta is already generating" });
        return;
      }

      const frames = capture.length / CHANNELS;
      const prompt = typeof message.prompt === "string" && message.prompt.trim()
        ? message.prompt.trim()
        : plantPrompt(lastLevel || rms(capture));
      const duration = Number.isFinite(Number(message.duration))
        ? Math.max(1, Math.min(MAX_DURATION, Number(message.duration)))
        : DEFAULT_DURATION;

      sendJson(socket, {
        type: "magenta:generate:start",
        frames,
        seconds: frames / SAMPLE_RATE,
        prompt,
        duration,
        mode: "magenta",
        model: MODEL
      });

      isGenerating = true;
      try {
        const audioFrames = Math.round(duration * SAMPLE_RATE);
        sendJson(socket, {
          type: "magenta:audio:start",
          frames: audioFrames,
          sampleRate: SAMPLE_RATE,
          channels: CHANNELS,
          mode: "magenta",
          model: MODEL
        });
        const generated = await streamMagenta(socket, { prompt, duration });
        sendJson(socket, {
          type: "magenta:audio:end",
          logs: generated.logs
        });
      } catch (error) {
        sendJson(socket, {
          type: "error",
          message: error instanceof Error ? error.message : String(error)
        });
      } finally {
        isGenerating = false;
      }
      return;
    }

    sendJson(socket, { type: "error", message: `Unknown message type: ${message.type}` });
  });
});

console.log(`Magenta bridge listening on ws://localhost:${PORT} (${MODEL})`);
