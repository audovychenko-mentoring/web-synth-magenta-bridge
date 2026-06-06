# Web Synth Magenta Bridge

A browser-based synth collection designed to feed audio into Magenta RealTime 2 through a local bridge process.

This repo starts with a working browser-to-bridge audio path:

- `apps/web`: Vite + React Web Audio synth collection.
- `apps/bridge`: local WebSocket bridge that receives stereo Float32 PCM and streams a mock continuation back.
- `native/magenta`: placeholder for the C++ Magenta RT integration.

## Run

```bash
npm install
npm run dev
```

Open the web app at `http://localhost:5173` and keep the bridge running at `ws://localhost:8787`.

## Integration Plan

The bridge currently returns a mock generated signal. Replace that mock with Magenta RT by wiring the captured 48 kHz stereo PCM into:

- `RealtimeRunner::set_audio_prompt_samples(...)` for style conditioning.
- `RealtimeRunner::prefill_state(...)` for continuation from the captured synth phrase.
- `RealtimeRunner::read_audio_stereo(...)` to stream generated audio back to the browser.

For realtime work, use the MacBook with Apple Silicon. `mrt2_small` is the reliable realtime target; `mrt2_base` should be benchmarked locally before relying on it.

