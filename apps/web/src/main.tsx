import React, { useRef, useState } from "react";
import { createRoot } from "react-dom/client";
import { Play, Square } from "lucide-react";
import "./styles.css";

type MidiInputLike = {
  id: string;
  name?: string | null;
  manufacturer?: string | null;
  onmidimessage: ((event: { data: Uint8Array }) => void) | null;
};

type MidiAccessLike = {
  inputs: {
    values: () => IterableIterator<MidiInputLike>;
    forEach: (callback: (input: MidiInputLike) => void) => void;
  };
  onstatechange: ((event?: unknown) => void) | null;
};

type NavigatorWithMidi = Navigator & {
  requestMIDIAccess?: () => Promise<unknown>;
};

type MidiVoice = {
  oscillator: OscillatorNode;
  gain: GainNode;
  filter: BiquadFilterNode;
};

function db(level: number) {
  return `${Math.max(-60, Math.round(20 * Math.log10(Math.max(level, 0.0001))))} dB`;
}

function midiFrequency(note: number) {
  return 440 * 2 ** ((note - 69) / 12);
}

function errorMessage(error: unknown) {
  if (error instanceof Error) return `${error.name}: ${error.message}`;
  return String(error);
}

function midiPermissionMessage(error: unknown) {
  const message = errorMessage(error);
  if (message.includes("NotAllowedError")) {
    return "MIDI permission is blocked. Open site settings for localhost, allow MIDI devices, reload, then press Play.";
  }
  if (message.includes("SecurityError")) {
    return "Web MIDI is blocked by the browser security settings. Open this app in Chrome or Edge on localhost.";
  }
  return `Browser MIDI permission failed (${message})`;
}

function App() {
  const audioRef = useRef<AudioContext | null>(null);
  const masterRef = useRef<GainNode | null>(null);
  const captureRef = useRef<AudioWorkletNode | null>(null);
  const playerRef = useRef<AudioWorkletNode | null>(null);
  const socketRef = useRef<WebSocket | null>(null);
  const connectPromiseRef = useRef<Promise<WebSocket> | null>(null);
  const midiAccessRef = useRef<MidiAccessLike | null>(null);
  const midiInputRef = useRef<MidiInputLike | null>(null);
  const midiVoicesRef = useRef<Map<number, MidiVoice>>(new Map());

  const [armed, setArmed] = useState(false);
  const [live, setLive] = useState(false);
  const [level, setLevel] = useState(0);
  const [capturedFrames, setCapturedFrames] = useState(0);
  const [status, setStatus] = useState("Connect TouchMe and start the live stream.");

  async function ensureAudio() {
    if (audioRef.current) {
      await audioRef.current.resume();
      return audioRef.current;
    }

    const context = new AudioContext({ sampleRate: 48000 });
    await context.audioWorklet.addModule("/worklets/capture-processor.js");
    await context.audioWorklet.addModule("/worklets/stream-player-processor.js");

    const master = context.createGain();
    master.gain.value = 0.45;
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
    generatedGain.gain.value = 0.6;
    player.connect(generatedGain).connect(context.destination);

    audioRef.current = context;
    masterRef.current = master;
    captureRef.current = capture;
    playerRef.current = player;
    setStatus("Audio engine ready.");
    return context;
  }

  const captureEnabledRef = useRef(false);
  const armedRef = useRef(false);
  const liveRef = useRef(false);

  function syncMidiInputs(access = midiAccessRef.current) {
    if (!access) return;
    const inputs = Array.from(access.inputs.values());
    if (midiInputRef.current && !inputs.some((input) => input.id === midiInputRef.current?.id)) {
      midiInputRef.current = null;
    }
  }

  function looksLikeTouchMe(input: MidiInputLike) {
    const label = `${input.name || ""} ${input.manufacturer || ""}`.toLowerCase();
    return label.includes("touchme") || label.includes("playtronica");
  }

  function pickTouchMeInput(inputs: MidiInputLike[]) {
    const namedTouchMe = inputs.find(looksLikeTouchMe);
    if (namedTouchMe) return namedTouchMe;
    if (inputs.length === 1) return inputs[0];
    return null;
  }

  async function ensureMidiAccess() {
    if (midiAccessRef.current) return midiAccessRef.current;
    const midiNavigator = navigator as NavigatorWithMidi;
    if (!midiNavigator.requestMIDIAccess) {
      setStatus("This browser does not support Web MIDI. Use Chrome or Edge.");
      return null;
    }
    let access: MidiAccessLike;
    try {
      access = await midiNavigator.requestMIDIAccess() as MidiAccessLike;
    } catch (error) {
      throw new Error(midiPermissionMessage(error));
    }
    access.onstatechange = () => syncMidiInputs(access);
    midiAccessRef.current = access;
    syncMidiInputs(access);
    return access;
  }

  async function connectTouchMeMidi(quiet = false) {
    await ensureAudio();
    const access = await ensureMidiAccess();
    if (!access) return false;

    const inputs = Array.from(access.inputs.values());
    const input = pickTouchMeInput(inputs);
    if (!input) {
      if (!quiet) {
        setStatus(inputs.length > 0
          ? "TouchMe was not detected. Disconnect other MIDI devices or reconnect the TouchMe board."
          : "No TouchMe MIDI input found. Connect the board and retry.");
      }
      return false;
    }

    inputs.forEach((device) => {
      device.onmidimessage = null;
    });
    input.onmidimessage = handleMidiMessage;
    midiInputRef.current = input;
    captureEnabledRef.current = true;
    if (!quiet) setStatus(`TouchMe MIDI connected: ${input.name || "MIDI input"}.`);
    return true;
  }

  function disconnectTouchMeMidi() {
    midiAccessRef.current?.inputs.forEach((input) => {
      input.onmidimessage = null;
    });
    midiInputRef.current = null;
    captureEnabledRef.current = false;
    midiVoicesRef.current.forEach(({ oscillator, gain }) => {
      const context = audioRef.current;
      if (!context) return;
      gain.gain.setTargetAtTime(0, context.currentTime, 0.02);
      oscillator.stop(context.currentTime + 0.08);
    });
    midiVoicesRef.current.clear();
    setStatus("TouchMe MIDI disconnected.");
  }

  function handleMidiMessage(event: { data: Uint8Array }) {
    const [statusByte, data1 = 0, data2 = 0] = event.data;
    const command = statusByte & 0xf0;
    const note = data1;
    const velocity = data2 / 127;

    if (command === 0x90 && data2 > 0) {
      startMidiVoice(note, velocity);
      void startStreamFromMidiSignal();
      return;
    }
    if (command === 0x80 || (command === 0x90 && data2 === 0)) {
      stopMidiVoice(note);
      return;
    }
    if (command === 0xb0) {
      updateMidiControl(data1, velocity);
      if (data2 > 0) void startStreamFromMidiSignal();
    }
  }

  function startMidiVoice(note: number, velocity: number) {
    const context = audioRef.current;
    if (!context || !masterRef.current) return;
    stopMidiVoice(note);

    const oscillator = context.createOscillator();
    const gain = context.createGain();
    const filter = context.createBiquadFilter();
    oscillator.type = note % 2 === 0 ? "triangle" : "sine";
    oscillator.frequency.value = midiFrequency(note);
    filter.type = "lowpass";
    filter.frequency.value = 500 + velocity * 2400;
    filter.Q.value = 0.8;
    gain.gain.value = 0;
    oscillator.connect(filter).connect(gain).connect(masterRef.current);
    oscillator.start();
    gain.gain.setTargetAtTime(0.04 + velocity * 0.22, context.currentTime, 0.025);
    midiVoicesRef.current.set(note, { oscillator, gain, filter });
  }

  function stopMidiVoice(note: number) {
    const context = audioRef.current;
    const voice = midiVoicesRef.current.get(note);
    if (!context || !voice) return;
    voice.gain.gain.cancelScheduledValues(context.currentTime);
    voice.gain.gain.setTargetAtTime(0, context.currentTime, 0.025);
    voice.oscillator.stop(context.currentTime + 0.12);
    midiVoicesRef.current.delete(note);
  }

  function updateMidiControl(controller: number, value: number) {
    const context = audioRef.current;
    if (!context) return;
    const cutoff = 260 + value * 3400;
    midiVoicesRef.current.forEach((voice) => {
      voice.filter.frequency.setTargetAtTime(cutoff, context.currentTime, 0.04);
    });
    if (controller === 1 && masterRef.current) {
      masterRef.current.gain.setTargetAtTime(0.2 + value * 0.55, context.currentTime, 0.06);
    }
  }

  function connectBridge() {
    if (socketRef.current?.readyState === WebSocket.OPEN) {
      return Promise.resolve(socketRef.current);
    }
    if (connectPromiseRef.current) return connectPromiseRef.current;

    const socket = new WebSocket("ws://localhost:8787");
    socket.binaryType = "arraybuffer";
    const promise = new Promise<WebSocket>((resolve, reject) => {
      socket.onopen = () => {
        setStatus("Bridge connected.");
        connectPromiseRef.current = null;
        resolve(socket);
      };
      socket.onerror = () => {
        setStatus("Bridge connection failed. Is npm run dev running?");
        connectPromiseRef.current = null;
        reject(new Error("Bridge connection failed"));
      };
    });
    socket.onclose = () => {
      liveRef.current = false;
      setLive(false);
      setStatus("Bridge disconnected.");
      connectPromiseRef.current = null;
    };
    socket.onmessage = (event) => {
      if (typeof event.data === "string") {
        const message = JSON.parse(event.data);
        if (message.type === "capture:meter") {
          setLevel(message.rms);
          setCapturedFrames(message.frames);
        } else if (message.type === "magenta:generate:start") {
          setStatus(`Generating ${message.duration.toFixed(1)}s with ${message.model}: "${message.prompt}"`);
        } else if (message.type === "magenta:audio:start") {
          setStatus(`Receiving ${message.model} audio from Magenta.`);
        } else if (message.type === "magenta:audio:end") {
          setStatus("Real Magenta audio received.");
        } else if (message.type === "magenta:live:start") {
          liveRef.current = true;
          setLive(true);
          setStatus(`Live stream running with ${message.model}.`);
        } else if (message.type === "magenta:live:chunk") {
          setStatus(`Live Magenta stream: "${message.prompt}"`);
        } else if (message.type === "magenta:live:stop") {
          liveRef.current = false;
          setLive(false);
          setStatus("Live stream stopped.");
        } else if (message.type === "bridge:ready") {
          setStatus(`Bridge ready in ${message.mode} mode (${message.model}).`);
        } else if (message.type === "error") {
          setStatus(message.message);
        }
        return;
      }
      const audio = new Float32Array(event.data);
      playerRef.current?.port.postMessage(audio, [audio.buffer]);
    };
    socketRef.current = socket;
    connectPromiseRef.current = promise;
    return promise;
  }

  async function startStreamFromMidiSignal() {
    if (!armedRef.current || liveRef.current) return;
    try {
      const socket = await connectBridge();
      liveRef.current = true;
      setLive(true);
      setArmed(false);
      armedRef.current = false;
      setStatus("Starting live Magenta stream.");
      socket.send(JSON.stringify({ type: "magenta:stream:start" }));
    } catch {
      liveRef.current = false;
      setLive(false);
      setStatus("Live stream could not start. Check that the bridge is running.");
    }
  }

  async function startLiveStream() {
    if (armedRef.current || liveRef.current) return;
    try {
      await ensureAudio();
      const inputReady = await connectTouchMeMidi();
      if (!inputReady) return;
      armedRef.current = true;
      setArmed(true);
      setStatus("Waiting for TouchMe MIDI signal.");
    } catch (error) {
      armedRef.current = false;
      setArmed(false);
      setStatus(`TouchMe MIDI was not opened: ${error instanceof Error ? error.message : errorMessage(error)}`);
    }
  }

  function stopLiveStream() {
    const wasLive = liveRef.current;
    const wasArmed = armedRef.current;
    armedRef.current = false;
    setArmed(false);
    liveRef.current = false;
    setLive(false);
    captureEnabledRef.current = false;
    midiAccessRef.current?.inputs.forEach((input) => {
      input.onmidimessage = null;
    });
    midiInputRef.current = null;
    midiVoicesRef.current.forEach(({ oscillator, gain }) => {
      const context = audioRef.current;
      if (!context) return;
      gain.gain.setTargetAtTime(0, context.currentTime, 0.02);
      oscillator.stop(context.currentTime + 0.08);
    });
    midiVoicesRef.current.clear();
    playerRef.current?.port.postMessage({ type: "reset" });
    if (socketRef.current?.readyState === WebSocket.OPEN) {
      socketRef.current.send(JSON.stringify({ type: "magenta:stream:stop" }));
    }
    setLevel(0);
    setCapturedFrames(0);
    setStatus(wasLive ? "Stopping live stream." : wasArmed ? "Waiting cancelled." : "Stopped.");
  }

  return (
    <main className="shell">
      <section className="topbar">
        <div>
          <h1>Web Synth Magenta Bridge</h1>
          <p>{status}</p>
        </div>
      </section>

      <section className="transport">
        <button
          aria-label="Play live stream"
          className="playAction"
          onClick={startLiveStream}
          disabled={armed || live}
          title="Play"
        >
          <Play size={26} fill="currentColor" />
        </button>
        <button className="primaryAction stopAction" onClick={stopLiveStream}>
          <Square size={18} />
          Stop
        </button>
      </section>

      <section className="workspace">
        <div className="meterPanel">
          <div>
            <span className="label">Metered</span>
            <strong>{(capturedFrames / 48000).toFixed(1)}s</strong>
          </div>
          <div>
            <span className="label">Input</span>
            <strong>{db(level)}</strong>
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
