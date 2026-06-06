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
const __dirname = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(__dirname, "../../..");
const pythonBin = resolve(repoRoot, ".venv/bin/python");
const generatorScript = resolve(__dirname, "../scripts/generate_magenta.py");

const server = new WebSocketServer({ port: PORT });

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

function generateMagenta({ prompt, duration }) {
  return new Promise((resolvePromise, reject) => {
    if (!existsSync(pythonBin)) {
      reject(new Error(`Python virtualenv not found at ${pythonBin}`));
      return;
    }
    if (!existsSync(generatorScript)) {
      reject(new Error(`Generator script not found at ${generatorScript}`));
      return;
    }

    const child = spawn(
      pythonBin,
      [
        generatorScript,
        "--model",
        MODEL,
        "--prompt",
        prompt,
        "--duration",
        String(duration)
      ],
      {
        cwd: repoRoot,
        env: {
          ...process.env,
          PYTHONUNBUFFERED: "1"
        },
        stdio: ["ignore", "pipe", "pipe"]
      }
    );

    const stdout = [];
    const stderr = [];
    child.stdout.on("data", (chunk) => stdout.push(chunk));
    child.stderr.on("data", (chunk) => stderr.push(chunk));
    child.on("error", reject);
    child.on("close", (code) => {
      const logs = Buffer.concat(stderr).toString("utf8").trim();
      if (code !== 0) {
        reject(new Error(logs || `Magenta generator exited with ${code}`));
        return;
      }
      resolvePromise({
        audio: Buffer.concat(stdout),
        logs
      });
    });
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
        ? Math.max(1, Math.min(12, Number(message.duration)))
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
        const generated = await generateMagenta({ prompt, duration });
        const audioFrames = generated.audio.byteLength / Float32Array.BYTES_PER_ELEMENT / CHANNELS;
        sendJson(socket, {
          type: "magenta:audio:start",
          frames: audioFrames,
          sampleRate: SAMPLE_RATE,
          channels: CHANNELS,
          mode: "magenta",
          model: MODEL
        });
        socket.send(generated.audio);
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
