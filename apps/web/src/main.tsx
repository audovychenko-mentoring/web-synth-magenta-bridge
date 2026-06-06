import React, { useEffect, useRef, useState } from "react";
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

const PLANT_CHANGE_THRESHOLD = 0.0015;
const PLANT_CHANGE_GAIN = 46;
const PLANT_OUTPUT_BOOST = 1.65;

function errorMessage(error: unknown) {
  if (error instanceof Error) return `${error.name}: ${error.message}`;
  return String(error);
}

async function midiPermissionState() {
  try {
    const permission = await navigator.permissions?.query({ name: "midi" as PermissionName });
    return permission?.state || "unknown";
  } catch {
    return "unknown";
  }
}

function midiPermissionMessage(error: unknown, permissionState = "unknown") {
  const message = errorMessage(error);
  if (message.includes("NotAllowedError")) {
    if (permissionState === "granted") {
      return "MIDI is marked allowed, but the browser still denied access. Reload this exact tab; if it still fails, open this app in the same Chrome profile where MIDI is allowed.";
    }
    const stateNote = permissionState === "unknown" ? "" : ` Browser reports MIDI permission: ${permissionState}.`;
    return `MIDI permission is blocked.${stateNote} Open site settings for localhost, allow MIDI devices, reload, then press Play.`;
  }
  if (message.includes("SecurityError")) {
    return "Web MIDI is blocked by the browser security settings. Open this app in Chrome or Edge on localhost.";
  }
  return `Browser MIDI permission failed (${message})`;
}

function App() {
  const audioRef = useRef<AudioContext | null>(null);
  const masterRef = useRef<GainNode | null>(null);
  const analyserRef = useRef<AnalyserNode | null>(null);
  const captureRef = useRef<AudioWorkletNode | null>(null);
  const playerRef = useRef<AudioWorkletNode | null>(null);
  const spectrogramCanvasRef = useRef<HTMLCanvasElement | null>(null);
  const spectrogramFrameRef = useRef<number | null>(null);
  const frequencyDataRef = useRef<Uint8Array<ArrayBuffer> | null>(null);
  const socketRef = useRef<WebSocket | null>(null);
  const connectPromiseRef = useRef<Promise<WebSocket> | null>(null);
  const midiAccessRef = useRef<MidiAccessLike | null>(null);
  const midiInputsRef = useRef<MidiInputLike[]>([]);
  const midiVoicesRef = useRef<Map<number, MidiVoice>>(new Map());
  const plantVoiceRef = useRef<MidiVoice | null>(null);
  const plantLastAmountRef = useRef(0);
  const plantLastPulseAtRef = useRef(0);
  const plantStepRef = useRef(0);
  const lastMidiStatusAtRef = useRef(0);
  const midiMessageCountRef = useRef(0);
  const midiNoSignalTimerRef = useRef<number | null>(null);
  const midiCalibrationTimerRef = useRef<number | null>(null);
  const midiBaselineRef = useRef<Map<string, number>>(new Map());
  const midiCalibratingUntilRef = useRef(0);

  const [armed, setArmed] = useState(false);
  const [live, setLive] = useState(false);
  const [level, setLevel] = useState(0);
  const [capturedFrames, setCapturedFrames] = useState(0);
  const [midiPortNames, setMidiPortNames] = useState("none");
  const [midiMessageCount, setMidiMessageCount] = useState(0);
  const [lastMidiMessage, setLastMidiMessage] = useState("none");
  const [lastMidiRaw, setLastMidiRaw] = useState("none");
  const [midiInputValue, setMidiInputValue] = useState(0);
  const [midiBaselineDelta, setMidiBaselineDelta] = useState(0);
  const [midiPlantAmount, setMidiPlantAmount] = useState(0);
  const [midiInputState, setMidiInputState] = useState("idle");
  const [status, setStatus] = useState("Press Play to listen for TouchMe MIDI.");

  useEffect(() => () => {
    if (spectrogramFrameRef.current !== null) {
      window.cancelAnimationFrame(spectrogramFrameRef.current);
    }
  }, []);

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

    const analyser = context.createAnalyser();
    analyser.fftSize = 1024;
    analyser.smoothingTimeConstant = 0.72;
    master.connect(analyser);

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
    analyserRef.current = analyser;
    frequencyDataRef.current = new Uint8Array(analyser.frequencyBinCount);
    captureRef.current = capture;
    playerRef.current = player;
    startSpectrogramLoop();
    setStatus("Audio engine ready.");
    return context;
  }

  const captureEnabledRef = useRef(false);
  const armedRef = useRef(false);
  const liveRef = useRef(false);

  function startSpectrogramLoop() {
    if (spectrogramFrameRef.current !== null) return;

    const draw = () => {
      const canvas = spectrogramCanvasRef.current;
      const analyser = analyserRef.current;
      const data = frequencyDataRef.current;
      if (canvas && analyser && data) {
        const ratio = window.devicePixelRatio || 1;
        const width = Math.max(1, Math.floor(canvas.clientWidth * ratio));
        const height = Math.max(1, Math.floor(canvas.clientHeight * ratio));
        if (canvas.width !== width || canvas.height !== height) {
          canvas.width = width;
          canvas.height = height;
          resetSpectrogram();
        }

        const context = canvas.getContext("2d");
        if (context) {
          analyser.getByteFrequencyData(data);
          context.drawImage(canvas, -2, 0);
          context.fillStyle = "#111";
          context.fillRect(width - 2, 0, 2, height);

          for (let y = 0; y < height; y += 1) {
            const normalizedY = 1 - y / Math.max(1, height - 1);
            const bin = Math.min(data.length - 1, Math.floor(normalizedY ** 2.2 * (data.length - 1)));
            const value = data[bin] / 255;
            if (value < 0.025) continue;
            const intensity = Math.min(1, value * 1.45);
            const red = Math.floor(20 + intensity * 225);
            const green = Math.floor(40 + intensity * 180);
            const blue = Math.floor(70 + (1 - intensity) * 70);
            context.fillStyle = `rgb(${red}, ${green}, ${blue})`;
            context.fillRect(width - 2, y, 2, 1);
          }
        }
      }
      spectrogramFrameRef.current = window.requestAnimationFrame(draw);
    };

    spectrogramFrameRef.current = window.requestAnimationFrame(draw);
  }

  function resetSpectrogram() {
    const canvas = spectrogramCanvasRef.current;
    const context = canvas?.getContext("2d");
    if (!canvas || !context) return;
    context.fillStyle = "#111";
    context.fillRect(0, 0, canvas.width, canvas.height);
  }

  function syncMidiInputs(access = midiAccessRef.current) {
    if (!access) return;
    const inputs = Array.from(access.inputs.values());
    midiInputsRef.current = midiInputsRef.current.filter((activeInput) =>
      inputs.some((input) => input.id === activeInput.id)
    );
  }

  function looksLikeTouchMe(input: MidiInputLike) {
    const label = `${input.name || ""} ${input.manufacturer || ""}`.toLowerCase();
    return label.includes("touchme") || label.includes("playtronica");
  }

  function pickTouchMeInputs(inputs: MidiInputLike[]) {
    const namedTouchMe = inputs.filter(looksLikeTouchMe);
    if (namedTouchMe.length > 0) return namedTouchMe;
    if (inputs.length === 1) return inputs;
    return [];
  }

  function midiInputNames(inputs = midiInputsRef.current) {
    return inputs.map((input) => input.name || input.manufacturer || "MIDI input").join(", ");
  }

  function clearNoSignalTimer() {
    if (midiNoSignalTimerRef.current === null) return;
    window.clearTimeout(midiNoSignalTimerRef.current);
    midiNoSignalTimerRef.current = null;
  }

  function clearCalibrationTimer() {
    if (midiCalibrationTimerRef.current === null) return;
    window.clearTimeout(midiCalibrationTimerRef.current);
    midiCalibrationTimerRef.current = null;
  }

  function midiMessageText(data: Uint8Array) {
    const [statusByte, data1 = 0, data2 = 0] = data;
    const command = statusByte & 0xf0;
    if (command === 0x90 && data2 > 0) return `note ${data1}, velocity ${data2}`;
    if (command === 0x80 || (command === 0x90 && data2 === 0)) return `note ${data1} released`;
    if (command === 0xb0) return `control ${data1}, value ${data2}`;
    if (command === 0xd0) return `pressure ${data1}`;
    if (command === 0xa0) return `note pressure ${data1}, value ${data2}`;
    if (command === 0xe0) return `pitch bend ${((data2 << 7) + data1) - 8192}`;
    return `MIDI ${Array.from(data).join(", ")}`;
  }

  function midiSignalAmount(data: Uint8Array) {
    const [statusByte, data1 = 0, data2 = 0] = data;
    const command = statusByte & 0xf0;
    if (statusByte >= 0xf8) return 0;
    if (command === 0x90) return data2 / 127;
    if (command === 0x80) return 0;
    if (command === 0xb0) return data2 / 127;
    if (command === 0xd0) return data1 / 127;
    if (command === 0xa0) return data2 / 127;
    if (command === 0xe0) return Math.abs(((data2 << 7) + data1) - 8192) / 8192;
    return Math.max(data1, data2) / 127;
  }

  function midiMessageKey(data: Uint8Array) {
    const [statusByte, data1 = 0] = data;
    const command = statusByte & 0xf0;
    if (command === 0xe0) return `${command}:bend`;
    if (command === 0xd0) return `${command}:pressure`;
    return `${command}:${data1}`;
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
      throw new Error(midiPermissionMessage(error, await midiPermissionState()));
    }
    access.onstatechange = () => syncMidiInputs(access);
    midiAccessRef.current = access;
    syncMidiInputs(access);
    return access;
  }

  async function connectTouchMeMidi(quiet = false) {
    const access = await ensureMidiAccess();
    if (!access) return false;

    const inputs = Array.from(access.inputs.values());
    const touchMeInputs = pickTouchMeInputs(inputs);
    if (touchMeInputs.length === 0) {
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
    await ensureAudio();
    touchMeInputs.forEach((input) => {
      input.onmidimessage = handleMidiMessage;
    });
    midiInputsRef.current = touchMeInputs;
    setMidiPortNames(midiInputNames(touchMeInputs));
    midiMessageCountRef.current = 0;
    setMidiMessageCount(0);
    setLastMidiMessage("none");
    setLastMidiRaw("none");
    setMidiInputValue(0);
    setMidiBaselineDelta(0);
    setMidiPlantAmount(0);
    setMidiInputState("listening");
    midiBaselineRef.current.clear();
    midiCalibratingUntilRef.current = 0;
    captureEnabledRef.current = true;
    if (!quiet) setStatus(`TouchMe MIDI connected: ${midiInputNames(touchMeInputs)}.`);
    return true;
  }

  function disconnectTouchMeMidi() {
    clearNoSignalTimer();
    clearCalibrationTimer();
    midiAccessRef.current?.inputs.forEach((input) => {
      input.onmidimessage = null;
    });
    midiInputsRef.current = [];
    setMidiPortNames("none");
    midiMessageCountRef.current = 0;
    setMidiMessageCount(0);
    setLastMidiMessage("none");
    setLastMidiRaw("none");
    setMidiInputValue(0);
    setMidiBaselineDelta(0);
    setMidiPlantAmount(0);
    setMidiInputState("idle");
    midiBaselineRef.current.clear();
    midiCalibratingUntilRef.current = 0;
    captureEnabledRef.current = false;
    midiVoicesRef.current.forEach(({ oscillator, gain }) => {
      const context = audioRef.current;
      if (!context) return;
      gain.gain.setTargetAtTime(0, context.currentTime, 0.02);
      oscillator.stop(context.currentTime + 0.08);
    });
    midiVoicesRef.current.clear();
    stopPlantSignal();
    setStatus("TouchMe MIDI disconnected. Press Play to listen again.");
  }

  function handleMidiMessage(event: { data: Uint8Array }) {
    const [statusByte, data1 = 0, data2 = 0] = event.data;
    if (statusByte >= 0xf8) return;

    const command = statusByte & 0xf0;
    const note = data1;
    const velocity = data2 / 127;
    const amount = midiSignalAmount(event.data);
    const now = performance.now();
    const messageText = midiMessageText(event.data);
    const messageKey = midiMessageKey(event.data);

    midiMessageCountRef.current += 1;
    setMidiMessageCount(midiMessageCountRef.current);
    setLastMidiMessage(messageText);
    setLastMidiRaw(Array.from(event.data).join(" "));
    setMidiInputValue(amount);

    if (now < midiCalibratingUntilRef.current) {
      midiBaselineRef.current.set(messageKey, amount);
      setMidiBaselineDelta(0);
      setMidiPlantAmount(0);
      setMidiInputState("calibrating");
      releasePlantSignal();
      return;
    }

    const isNoteOn = command === 0x90 && data2 > 0;
    const hasBaseline = midiBaselineRef.current.has(messageKey);
    const baseline = midiBaselineRef.current.get(messageKey) ?? amount;
    if (!hasBaseline && !isNoteOn) {
      midiBaselineRef.current.set(messageKey, amount);
      setMidiBaselineDelta(0);
      setMidiPlantAmount(0);
      setMidiInputState("baseline");
      releasePlantSignal();
      return;
    }
    const baselineDelta = Math.abs(amount - baseline);
    const amplifiedChange = Math.min(1, Math.pow(Math.max(0, baselineDelta - PLANT_CHANGE_THRESHOLD / 2) * PLANT_CHANGE_GAIN, 0.72));
    const changedAmount = Math.max(amplifiedChange, isNoteOn ? amount : 0);
    const hasPlantChange = isNoteOn || baselineDelta > PLANT_CHANGE_THRESHOLD;
    setMidiBaselineDelta(baselineDelta);
    setMidiPlantAmount(changedAmount);
    setMidiInputState(hasPlantChange ? "plant change" : "baseline");
    if (hasPlantChange && armedRef.current && now - lastMidiStatusAtRef.current > 250) {
      setStatus(`TouchMe plant change: ${messageText}.`);
      lastMidiStatusAtRef.current = now;
    }

    if (isNoteOn) {
      clearNoSignalTimer();
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
      if (hasPlantChange) {
        clearNoSignalTimer();
        drivePlantSignal(event.data, changedAmount);
        void startStreamFromMidiSignal();
      } else {
        releasePlantSignal();
      }
      return;
    }
    if (hasPlantChange) {
      clearNoSignalTimer();
      drivePlantSignal(event.data, changedAmount);
      void startStreamFromMidiSignal();
    } else {
      releasePlantSignal();
    }
  }

  function drivePlantSignal(data: Uint8Array, amount: number) {
    const context = audioRef.current;
    if (!context || !masterRef.current) return;
    const [, data1 = 0, data2 = 0] = data;
    const boostedAmount = Math.min(1, amount * PLANT_OUTPUT_BOOST);
    const control = Math.max(data1, data2) / 127;
    const delta = Math.abs(boostedAmount - plantLastAmountRef.current);
    const elapsed = context.currentTime - plantLastPulseAtRef.current;

    if (!plantVoiceRef.current) {
      const oscillator = context.createOscillator();
      const gain = context.createGain();
      const filter = context.createBiquadFilter();
      oscillator.type = "triangle";
      oscillator.frequency.value = 130;
      filter.type = "lowpass";
      filter.frequency.value = 1200;
      filter.Q.value = 1.4;
      gain.gain.value = 0;
      oscillator.connect(filter).connect(gain).connect(masterRef.current);
      oscillator.start();
      plantVoiceRef.current = { oscillator, gain, filter };
    }

    const voice = plantVoiceRef.current;
    const scale = [48, 50, 53, 55, 57, 60, 62, 65, 67, 69];
    const shouldPulse = delta > 0.003 || elapsed > 0.38;
    if (shouldPulse) {
      plantStepRef.current += 1 + Math.floor(delta * 18);
      plantLastPulseAtRef.current = context.currentTime;
    }
    const note = scale[(Math.floor(control * scale.length) + plantStepRef.current) % scale.length];
    const frequency = midiFrequency(note) * (1 + boostedAmount * 0.11);
    voice.oscillator.frequency.setTargetAtTime(frequency, context.currentTime, 0.025);
    voice.filter.frequency.setTargetAtTime(520 + boostedAmount * 6200 + delta * 4600, context.currentTime, 0.035);

    if (shouldPulse) {
      const peak = Math.min(0.46, 0.11 + boostedAmount * 0.3 + delta * 1.45);
      voice.gain.gain.cancelScheduledValues(context.currentTime);
      voice.gain.gain.setValueAtTime(0.006, context.currentTime);
      voice.gain.gain.linearRampToValueAtTime(peak, context.currentTime + 0.025);
      voice.gain.gain.exponentialRampToValueAtTime(0.014, context.currentTime + 0.2 + boostedAmount * 0.2);
    } else {
      voice.gain.gain.setTargetAtTime(0.016 + boostedAmount * 0.065, context.currentTime, 0.08);
    }
    plantLastAmountRef.current = boostedAmount;
  }

  function releasePlantSignal() {
    const context = audioRef.current;
    const voice = plantVoiceRef.current;
    if (!context || !voice) return;
    voice.gain.gain.setTargetAtTime(0, context.currentTime, 0.04);
  }

  function stopPlantSignal() {
    const context = audioRef.current;
    const voice = plantVoiceRef.current;
    if (!context || !voice) return;
    voice.gain.gain.setTargetAtTime(0, context.currentTime, 0.02);
    voice.oscillator.stop(context.currentTime + 0.08);
    plantVoiceRef.current = null;
    plantLastAmountRef.current = 0;
    plantLastPulseAtRef.current = 0;
    plantStepRef.current = 0;
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
      const inputReady = await connectTouchMeMidi();
      if (!inputReady) return;
      armedRef.current = true;
      setArmed(true);
      midiBaselineRef.current.clear();
      midiCalibratingUntilRef.current = performance.now() + 900;
      setStatus(`Calibrating TouchMe baseline from ${midiInputNames() || "MIDI input"}. Keep hands still.`);
      clearCalibrationTimer();
      midiCalibrationTimerRef.current = window.setTimeout(() => {
        if (!armedRef.current || liveRef.current) return;
        setStatus(`Listening for plant changes from ${midiInputNames() || "MIDI input"}.`);
      }, 950);
      clearNoSignalTimer();
      midiNoSignalTimerRef.current = window.setTimeout(() => {
        if (!armedRef.current || liveRef.current) return;
        setStatus(midiMessageCountRef.current === 0
          ? `Listening on ${midiInputNames() || "MIDI input"}, but no MIDI messages received yet.`
          : `MIDI baseline is present. Touch or move the plant to create a change.`);
      }, 4500);
    } catch (error) {
      armedRef.current = false;
      setArmed(false);
      setStatus(`TouchMe MIDI was not opened: ${error instanceof Error ? error.message : errorMessage(error)}`);
    }
  }

  function stopLiveStream() {
    const wasLive = liveRef.current;
    const wasArmed = armedRef.current;
    clearNoSignalTimer();
    clearCalibrationTimer();
    armedRef.current = false;
    setArmed(false);
    liveRef.current = false;
    setLive(false);
    captureEnabledRef.current = false;
    midiAccessRef.current?.inputs.forEach((input) => {
      input.onmidimessage = null;
    });
    midiInputsRef.current = [];
    setMidiPortNames("none");
    midiVoicesRef.current.forEach(({ oscillator, gain }) => {
      const context = audioRef.current;
      if (!context) return;
      gain.gain.setTargetAtTime(0, context.currentTime, 0.02);
      oscillator.stop(context.currentTime + 0.08);
    });
    midiVoicesRef.current.clear();
    stopPlantSignal();
    playerRef.current?.port.postMessage({ type: "reset" });
    if (socketRef.current?.readyState === WebSocket.OPEN) {
      socketRef.current.send(JSON.stringify({ type: "magenta:stream:stop" }));
    }
    setLevel(0);
    setCapturedFrames(0);
    resetSpectrogram();
    midiMessageCountRef.current = 0;
    setMidiMessageCount(0);
    setLastMidiMessage("none");
    setLastMidiRaw("none");
    setMidiInputValue(0);
    setMidiBaselineDelta(0);
    setMidiPlantAmount(0);
    setMidiInputState("idle");
    midiBaselineRef.current.clear();
    midiCalibratingUntilRef.current = 0;
    setStatus(wasLive ? "Stopping live stream." : wasArmed ? "Waiting cancelled. Press Play to listen again." : "Stopped. Press Play to listen again.");
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
          <div className="spectrogramPanel">
            <span className="label">Spectrogram</span>
            <canvas ref={spectrogramCanvasRef} className="spectrogramCanvas" aria-label="Input spectrogram" />
          </div>
          <div>
            <span className="label">Ports</span>
            <strong className="debugValue">{midiPortNames}</strong>
          </div>
          <div>
            <span className="label">Messages</span>
            <strong>{midiMessageCount}</strong>
          </div>
          <div>
            <span className="label">Last MIDI</span>
            <strong className="debugValue">{lastMidiMessage}</strong>
          </div>
          <div>
            <span className="label">Raw MIDI</span>
            <strong className="debugValue">{lastMidiRaw}</strong>
          </div>
          <div>
            <span className="label">MIDI Value</span>
            <strong>{midiInputValue.toFixed(4)}</strong>
          </div>
          <div className="miniMeter">
            <span style={{ transform: `scaleX(${Math.min(1, midiInputValue)})` }} />
          </div>
          <div>
            <span className="label">Delta</span>
            <strong>{midiBaselineDelta.toFixed(4)}</strong>
          </div>
          <div className="miniMeter changeMeter">
            <span style={{ transform: `scaleX(${Math.min(1, midiPlantAmount)})` }} />
          </div>
          <div>
            <span className="label">MIDI State</span>
            <strong className="debugValue">{midiInputState}</strong>
          </div>
        </div>
      </section>
    </main>
  );
}

createRoot(document.getElementById("root")!).render(<App />);
