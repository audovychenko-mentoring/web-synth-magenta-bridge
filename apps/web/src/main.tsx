import React, { useMemo, useRef, useState } from "react";
import { createRoot } from "react-dom/client";
import { Cable, Check, Circle, Play, Radio, RotateCcw, Sparkles, Square } from "lucide-react";
import "./styles.css";

type VoiceId = "bass" | "pad" | "pluck" | "drone";

type Voice = {
  id: VoiceId;
  label: string;
  note: number;
  wave: OscillatorType;
  gain: number;
  color: string;
};

type RunningVoice = {
  oscillator: OscillatorNode;
  gain: GainNode;
};

const voices: Voice[] = [
  { id: "bass", label: "Bass", note: 43.65, wave: "sawtooth", gain: 0.22, color: "#db4f4a" },
  { id: "pad", label: "Pad", note: 174.61, wave: "triangle", gain: 0.16, color: "#3b82f6" },
  { id: "pluck", label: "Pluck", note: 329.63, wave: "square", gain: 0.08, color: "#14b8a6" },
  { id: "drone", label: "Drone", note: 65.41, wave: "sine", gain: 0.18, color: "#d97706" }
];

function db(level: number) {
  return `${Math.max(-60, Math.round(20 * Math.log10(Math.max(level, 0.0001))))} dB`;
}

function App() {
  const audioRef = useRef<AudioContext | null>(null);
  const masterRef = useRef<GainNode | null>(null);
  const captureRef = useRef<AudioWorkletNode | null>(null);
  const playerRef = useRef<AudioWorkletNode | null>(null);
  const socketRef = useRef<WebSocket | null>(null);
  const runningRef = useRef<Map<VoiceId, RunningVoice>>(new Map());

  const [audioReady, setAudioReady] = useState(false);
  const [connected, setConnected] = useState(false);
  const [capturing, setCapturing] = useState(false);
  const [activeVoices, setActiveVoices] = useState<Record<VoiceId, boolean>>({
    bass: false,
    pad: false,
    pluck: false,
    drone: false
  });
  const [level, setLevel] = useState(0);
  const [capturedFrames, setCapturedFrames] = useState(0);
  const [status, setStatus] = useState("Start audio, connect the bridge, then capture a phrase.");

  const activeCount = useMemo(
    () => Object.values(activeVoices).filter(Boolean).length,
    [activeVoices]
  );

  async function ensureAudio() {
    if (audioRef.current) {
      await audioRef.current.resume();
      setAudioReady(true);
      setStatus("Audio engine ready. Start a voice or route plant synth audio, then capture.");
      return audioRef.current;
    }

    const context = new AudioContext({ sampleRate: 48000 });
    await context.audioWorklet.addModule("/worklets/capture-processor.js");
    await context.audioWorklet.addModule("/worklets/stream-player-processor.js");

    const master = context.createGain();
    master.gain.value = 0.75;
    master.connect(context.destination);

    const capture = new AudioWorkletNode(context, "capture-processor", {
      numberOfInputs: 1,
      numberOfOutputs: 0,
      channelCount: 2
    });
    master.connect(capture);
    capture.port.onmessage = (event: MessageEvent<Float32Array>) => {
      const socket = socketRef.current;
      if (!socket || socket.readyState !== WebSocket.OPEN) return;
      if (!captureEnabledRef.current) return;
      socket.send(event.data);
    };

    const player = new AudioWorkletNode(context, "stream-player-processor", {
      numberOfInputs: 0,
      numberOfOutputs: 1,
      outputChannelCount: [2]
    });
    const generatedGain = context.createGain();
    generatedGain.gain.value = 0.85;
    player.connect(generatedGain).connect(context.destination);

    audioRef.current = context;
    masterRef.current = master;
    captureRef.current = capture;
    playerRef.current = player;
    setAudioReady(true);
    setStatus("Audio engine ready. Start a voice or route plant synth audio, then capture.");
    return context;
  }

  const captureEnabledRef = useRef(false);

  async function toggleVoice(voice: Voice) {
    const context = await ensureAudio();
    const running = runningRef.current.get(voice.id);
    if (running) {
      const now = context.currentTime;
      running.gain.gain.cancelScheduledValues(now);
      running.gain.gain.setTargetAtTime(0, now, 0.025);
      running.oscillator.stop(now + 0.12);
      runningRef.current.delete(voice.id);
      setActiveVoices((state) => ({ ...state, [voice.id]: false }));
      setStatus(`${voice.label} stopped.`);
      return;
    }

    const oscillator = context.createOscillator();
    const gain = context.createGain();
    const filter = context.createBiquadFilter();
    oscillator.type = voice.wave;
    oscillator.frequency.value = voice.note;
    filter.type = "lowpass";
    filter.frequency.value = voice.id === "pluck" ? 1300 : 720;
    filter.Q.value = 0.7;
    gain.gain.value = 0;
    oscillator.connect(filter).connect(gain).connect(masterRef.current!);
    oscillator.start();
    gain.gain.setTargetAtTime(voice.gain, context.currentTime, voice.id === "pad" ? 0.4 : 0.04);
    runningRef.current.set(voice.id, { oscillator, gain });
    setActiveVoices((state) => ({ ...state, [voice.id]: true }));
    setStatus(`${voice.label} running. Capture will send the mixed synth output to the bridge.`);
  }

  function connectBridge() {
    if (socketRef.current?.readyState === WebSocket.OPEN) return;
    const socket = new WebSocket("ws://localhost:8787");
    socket.binaryType = "arraybuffer";
    socket.onopen = () => {
      setConnected(true);
      setStatus("Bridge connected.");
    };
    socket.onclose = () => {
      setConnected(false);
      setStatus("Bridge disconnected.");
    };
    socket.onerror = () => setStatus("Bridge connection failed. Is npm run dev running?");
    socket.onmessage = (event) => {
      if (typeof event.data === "string") {
        const message = JSON.parse(event.data);
        if (message.type === "capture:meter") {
          setLevel(message.rms);
          setCapturedFrames(message.frames);
        } else if (message.type === "magenta:prefill:start") {
          setStatus(`Mock Magenta prefill: ${message.seconds.toFixed(1)}s captured.`);
        } else if (message.type === "magenta:audio:start") {
          setStatus("Streaming mock continuation back from bridge.");
        } else if (message.type === "magenta:audio:end") {
          setStatus("Continuation received. Native Magenta will replace this mock.");
        } else if (message.type === "bridge:ready") {
          setStatus(`Bridge ready in ${message.mode} mode.`);
        }
        return;
      }
      const audio = new Float32Array(event.data);
      playerRef.current?.port.postMessage(audio, [audio.buffer]);
    };
    socketRef.current = socket;
  }

  function clearCapture() {
    socketRef.current?.send(JSON.stringify({ type: "capture:clear" }));
    setCapturedFrames(0);
    setLevel(0);
    setStatus("Capture buffer cleared.");
  }

  async function toggleCapture() {
    await ensureAudio();
    const next = !capturing;
    captureEnabledRef.current = next;
    setCapturing(next);
    setStatus(next ? "Capturing synth output for Magenta." : "Capture paused.");
  }

  async function continueWithMagenta() {
    await ensureAudio();
    socketRef.current?.send(JSON.stringify({ type: "magenta:prefill" }));
  }

  return (
    <main className="shell">
      <section className="topbar">
        <div>
          <h1>Web Synth Magenta Bridge</h1>
          <p>{status}</p>
        </div>
        <div className="statusStrip">
          <span className={audioReady ? "pill on" : "pill"}>
            <Circle size={12} fill="currentColor" /> Audio
          </span>
          <span className={connected ? "pill on" : "pill"}>
            <Cable size={14} /> Bridge
          </span>
        </div>
      </section>

      <section className="transport">
        <button className={audioReady ? "active" : ""} onClick={ensureAudio}>
          {audioReady ? <Check size={18} /> : <Play size={18} />}
          {audioReady ? "Audio Ready" : "Start Audio"}
        </button>
        <button onClick={connectBridge}>
          <Radio size={18} /> Connect
        </button>
        <button className={capturing ? "active" : ""} onClick={toggleCapture}>
          {capturing ? <Square size={18} /> : <Circle size={18} />} Capture
        </button>
        <button onClick={continueWithMagenta} disabled={!connected || capturedFrames === 0}>
          <Sparkles size={18} /> Continue
        </button>
        <button className="ghost" onClick={clearCapture}>
          <RotateCcw size={18} /> Clear
        </button>
      </section>

      <section className="workspace">
        <div className="synthGrid">
          {voices.map((voice) => (
            <button
              key={voice.id}
              className={`voice ${activeVoices[voice.id] ? "playing" : ""}`}
              style={{ "--accent": voice.color } as React.CSSProperties}
              onClick={() => toggleVoice(voice)}
            >
              <span>{voice.label}</span>
              <strong>{voice.wave}</strong>
            </button>
          ))}
        </div>

        <div className="meterPanel">
          <div>
            <span className="label">Captured</span>
            <strong>{(capturedFrames / 48000).toFixed(1)}s</strong>
          </div>
          <div>
            <span className="label">Input</span>
            <strong>{db(level)}</strong>
          </div>
          <div>
            <span className="label">Voices</span>
            <strong>{activeCount}</strong>
          </div>
          <div className="meter">
            <span style={{ transform: `scaleX(${Math.min(1, level * 12)})` }} />
          </div>
        </div>
      </section>
    </main>
  );
}

createRoot(document.getElementById("root")!).render(<App />);
