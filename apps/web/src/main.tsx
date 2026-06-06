import React, { useMemo, useRef, useState } from "react";
import { createRoot } from "react-dom/client";
import { Cable, Check, Circle, ExternalLink, Mic, Music2, Play, Radio, RotateCcw, Sparkles, Square } from "lucide-react";
import "./styles.css";

type VoiceId = "bass" | "pad" | "pluck" | "drone";

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

type MidiVoice = {
  oscillator: OscillatorNode;
  gain: GainNode;
  filter: BiquadFilterNode;
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

function midiFrequency(note: number) {
  return 440 * 2 ** ((note - 69) / 12);
}

function App() {
  const audioRef = useRef<AudioContext | null>(null);
  const masterRef = useRef<GainNode | null>(null);
  const captureRef = useRef<AudioWorkletNode | null>(null);
  const playerRef = useRef<AudioWorkletNode | null>(null);
  const inputSourceRef = useRef<MediaStreamAudioSourceNode | null>(null);
  const inputStreamRef = useRef<MediaStream | null>(null);
  const socketRef = useRef<WebSocket | null>(null);
  const connectPromiseRef = useRef<Promise<WebSocket> | null>(null);
  const runningRef = useRef<Map<VoiceId, RunningVoice>>(new Map());
  const midiAccessRef = useRef<MidiAccessLike | null>(null);
  const midiVoicesRef = useRef<Map<number, MidiVoice>>(new Map());

  const [audioReady, setAudioReady] = useState(false);
  const [connected, setConnected] = useState(false);
  const [capturing, setCapturing] = useState(false);
  const [plantConnected, setPlantConnected] = useState(false);
  const [inputDevices, setInputDevices] = useState<MediaDeviceInfo[]>([]);
  const [selectedInputId, setSelectedInputId] = useState("");
  const [sourceLabel, setSourceLabel] = useState("");
  const [midiConnected, setMidiConnected] = useState(false);
  const [midiInputs, setMidiInputs] = useState<MidiInputLike[]>([]);
  const [selectedMidiId, setSelectedMidiId] = useState("");
  const [live, setLive] = useState(false);
  const [activeVoices, setActiveVoices] = useState<Record<VoiceId, boolean>>({
    bass: false,
    pad: false,
    pluck: false,
    drone: false
  });
  const [level, setLevel] = useState(0);
  const [capturedFrames, setCapturedFrames] = useState(0);
  const [duration, setDuration] = useState(8);
  const [status, setStatus] = useState("Start audio to begin the live Magenta stream.");

  const activeCount = useMemo(
    () => Object.values(activeVoices).filter(Boolean).length,
    [activeVoices]
  );
  const sourceConnected = plantConnected || midiConnected;

  async function ensureAudio() {
    if (audioRef.current) {
      await audioRef.current.resume();
      setAudioReady(true);
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
    setAudioReady(true);
    setStatus("Audio engine ready.");
    return context;
  }

  const captureEnabledRef = useRef(false);
  const liveRef = useRef(false);

  function syncMidiInputs(access = midiAccessRef.current) {
    if (!access) return;
    const inputs = Array.from(access.inputs.values());
    setMidiInputs(inputs);
    if (!selectedMidiId && inputs[0]?.id) {
      setSelectedMidiId(inputs[0].id);
    }
  }

  async function ensureMidiAccess() {
    if (midiAccessRef.current) return midiAccessRef.current;
    const midiNavigator = navigator as NavigatorWithMidi;
    if (!midiNavigator.requestMIDIAccess) {
      setStatus("This browser does not support Web MIDI. Use Chrome or Edge.");
      return null;
    }
    const access = await midiNavigator.requestMIDIAccess() as MidiAccessLike;
    access.onstatechange = () => syncMidiInputs(access);
    midiAccessRef.current = access;
    syncMidiInputs(access);
    return access;
  }

  async function connectTouchMeMidi(inputId = selectedMidiId) {
    await ensureAudio();
    const access = await ensureMidiAccess();
    if (!access) return false;

    const inputs = Array.from(access.inputs.values());
    const input = inputs.find((device) => device.id === inputId) || inputs[0];
    if (!input) {
      setStatus("No MIDI input found. Connect the TouchMe board and retry.");
      return false;
    }

    inputs.forEach((device) => {
      device.onmidimessage = null;
    });
    inputSourceRef.current?.disconnect();
    inputSourceRef.current = null;
    inputStreamRef.current?.getTracks().forEach((track) => track.stop());
    inputStreamRef.current = null;
    input.onmidimessage = handleMidiMessage;
    setSelectedMidiId(input.id);
    setMidiConnected(true);
    setPlantConnected(false);
    captureEnabledRef.current = true;
    setCapturing(true);
    setSourceLabel(input.name || "TouchMe MIDI");
    setStatus(`TouchMe MIDI connected: ${input.name || "MIDI input"}.`);
    return true;
  }

  function disconnectTouchMeMidi() {
    midiAccessRef.current?.inputs.forEach((input) => {
      input.onmidimessage = null;
    });
    midiVoicesRef.current.forEach(({ oscillator, gain }) => {
      const context = audioRef.current;
      if (!context) return;
      gain.gain.setTargetAtTime(0, context.currentTime, 0.02);
      oscillator.stop(context.currentTime + 0.08);
    });
    midiVoicesRef.current.clear();
    setMidiConnected(false);
    setStatus("TouchMe MIDI disconnected.");
  }

  async function changeMidiInput(inputId: string) {
    setSelectedMidiId(inputId);
    if (midiConnected) {
      await connectTouchMeMidi(inputId);
    }
  }

  function handleMidiMessage(event: { data: Uint8Array }) {
    const [statusByte, data1 = 0, data2 = 0] = event.data;
    const command = statusByte & 0xf0;
    const note = data1;
    const velocity = data2 / 127;

    if (command === 0x90 && data2 > 0) {
      startMidiVoice(note, velocity);
      return;
    }
    if (command === 0x80 || (command === 0x90 && data2 === 0)) {
      stopMidiVoice(note);
      return;
    }
    if (command === 0xb0) {
      updateMidiControl(data1, velocity);
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

  async function refreshInputDevices() {
    if (!navigator.mediaDevices?.enumerateDevices) return;
    const devices = await navigator.mediaDevices.enumerateDevices();
    const audioInputs = devices.filter((device) => device.kind === "audioinput");
    setInputDevices(audioInputs);
    if (!selectedInputId && audioInputs[0]?.deviceId) {
      setSelectedInputId(audioInputs[0].deviceId);
    }
  }

  function replaceInputSource(stream: MediaStream, label: string) {
    const context = audioRef.current!;
    inputSourceRef.current?.disconnect();
    inputStreamRef.current?.getTracks().forEach((track) => track.stop());

    const source = context.createMediaStreamSource(stream);
    source.connect(captureRef.current!);

    inputSourceRef.current = source;
    inputStreamRef.current = stream;
    captureEnabledRef.current = true;
    setCapturing(true);
    setPlantConnected(true);
    setMidiConnected(false);
    setSourceLabel(label);

    stream.getTracks().forEach((track) => {
      track.onended = () => {
        disconnectPlantInput();
      };
    });
  }

  async function connectPlantInput(deviceId = selectedInputId) {
    const context = await ensureAudio();
    if (!navigator.mediaDevices?.getUserMedia) {
      setStatus("This browser cannot open an audio input.");
      return false;
    }

    const stream = await navigator.mediaDevices.getUserMedia({
      audio: {
        deviceId: deviceId ? { exact: deviceId } : undefined,
        channelCount: 2,
        echoCancellation: false,
        noiseSuppression: false,
        autoGainControl: false
      }
    });
    await refreshInputDevices();
    const label = stream.getAudioTracks()[0]?.label || "audio input";
    replaceInputSource(stream, label);
    setStatus(`Audio input connected: ${label}.`);
    return true;
  }

  async function connectPlaytronicaTab() {
    await ensureAudio();
    if (!navigator.mediaDevices?.getDisplayMedia) {
      setStatus("This browser cannot capture tab audio.");
      return false;
    }

    const stream = await navigator.mediaDevices.getDisplayMedia({
      video: true,
      audio: {
        echoCancellation: false,
        noiseSuppression: false,
        autoGainControl: false
      }
    });

    if (stream.getAudioTracks().length === 0) {
      stream.getTracks().forEach((track) => track.stop());
      setStatus("No tab audio was shared. Choose the Playtronica tab and enable audio sharing.");
      return false;
    }

    replaceInputSource(stream, "Playtronica tab audio");
    setStatus("Playtronica tab audio connected.");
    return true;
  }

  function disconnectPlantInput() {
    inputSourceRef.current?.disconnect();
    inputSourceRef.current = null;
    inputStreamRef.current?.getTracks().forEach((track) => track.stop());
    inputStreamRef.current = null;
    setPlantConnected(false);
    setSourceLabel("");
    setStatus("Input source disconnected.");
  }

  async function changePlantInput(deviceId: string) {
    setSelectedInputId(deviceId);
    if (plantConnected) {
      await connectPlantInput(deviceId);
    }
  }

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
    setStatus(`${voice.label} running. Live Magenta is listening to the synth signal.`);
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
        setConnected(true);
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
      setConnected(false);
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
    setStatus(next ? "Metering synth output for Magenta context." : "Meter paused.");
  }

  async function continueWithMagenta() {
    await ensureAudio();
    socketRef.current?.send(JSON.stringify({ type: "magenta:generate", duration }));
  }

  async function toggleLiveStream() {
    if (liveRef.current) {
      liveRef.current = false;
      setLive(false);
      socketRef.current?.send(JSON.stringify({ type: "magenta:stream:stop" }));
      setStatus("Stopping live stream.");
      return;
    }

    try {
      await ensureAudio();
      if (!sourceConnected) {
        const inputReady = await connectTouchMeMidi();
        if (!inputReady) return;
      }
      const socket = await connectBridge();
      liveRef.current = true;
      setLive(true);
      setStatus("Starting live Magenta stream.");
      socket.send(JSON.stringify({ type: "magenta:stream:start" }));
    } catch {
      liveRef.current = false;
      setLive(false);
      setStatus("Input source was not opened. Connect TouchMe MIDI, share Playtronica tab audio, or choose an audio input.");
    }
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
          <span className={sourceConnected ? "pill on" : "pill"}>
            <Mic size={14} /> Source
          </span>
          <span className={midiConnected ? "pill on" : "pill"}>
            <Music2 size={14} /> MIDI
          </span>
          <span className={live ? "pill on" : "pill"}>
            <Radio size={14} /> Live
          </span>
        </div>
      </section>

      <section className="transport">
        <button className={live ? "active" : ""} onClick={toggleLiveStream}>
          {live ? <Square size={18} /> : audioReady ? <Check size={18} /> : <Play size={18} />}
          {live ? "Stop Live" : "Start Audio"}
        </button>
        <button onClick={() => void connectBridge().catch(() => undefined)}>
          <Radio size={18} /> Connect
        </button>
        <button
          className={midiConnected ? "active" : ""}
          onClick={() => midiConnected ? disconnectTouchMeMidi() : void connectTouchMeMidi()}
        >
          {midiConnected ? <Check size={18} /> : <Music2 size={18} />} TouchMe MIDI
        </button>
        <select
          aria-label="TouchMe MIDI input"
          className="inputSelect"
          value={selectedMidiId}
          onChange={(event) => void changeMidiInput(event.target.value)}
          onFocus={() => void ensureMidiAccess()}
        >
          {midiInputs.length === 0 ? (
            <option value="">MIDI input</option>
          ) : midiInputs.map((input, index) => (
            <option key={input.id} value={input.id}>
              {input.name || input.manufacturer || `MIDI ${index + 1}`}
            </option>
          ))}
        </select>
        <button
          className={plantConnected ? "active" : ""}
          onClick={() => {
            if (plantConnected) {
              disconnectPlantInput();
            } else {
              void connectPlantInput().catch(() => {
                setStatus("Input source was not opened. Check the browser permission and selected input.");
              });
            }
          }}
        >
          {plantConnected ? <Check size={18} /> : <Mic size={18} />} Audio Input
        </button>
        <button
          className={plantConnected && sourceLabel.includes("Playtronica") ? "active" : ""}
          onClick={() => void connectPlaytronicaTab().catch(() => {
            setStatus("Playtronica tab audio was not shared.");
          })}
        >
          <ExternalLink size={18} /> Playtronica Tab
        </button>
        <select
          aria-label="Audio input"
          className="inputSelect"
          value={selectedInputId}
          onChange={(event) => void changePlantInput(event.target.value)}
          onFocus={() => void refreshInputDevices()}
        >
          {inputDevices.length === 0 ? (
            <option value="">Default input</option>
          ) : inputDevices.map((device, index) => (
            <option key={device.deviceId} value={device.deviceId}>
              {device.label || `Input ${index + 1}`}
            </option>
          ))}
        </select>
        <button className={capturing ? "active" : ""} onClick={toggleCapture}>
          {capturing ? <Square size={18} /> : <Circle size={18} />} Meter
        </button>
        <div className="durationControl" aria-label="Generated audio length">
          {[4, 8, 12, 20].map((seconds) => (
            <button
              key={seconds}
              className={duration === seconds ? "active" : ""}
              onClick={() => setDuration(seconds)}
              type="button"
            >
              {seconds}s
            </button>
          ))}
        </div>
        <button onClick={continueWithMagenta} disabled={!connected || live}>
          <Sparkles size={18} /> Generate Clip
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
            <span className="label">Metered</span>
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
