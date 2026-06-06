# Web Synth Magenta Bridge

A browser-based synth collection connected to Magenta RealTime 2 through a local bridge process.

This repo currently has a working browser-to-bridge-to-Magenta path:

- `apps/web`: Vite + React Web Audio synth collection.
- `apps/bridge`: local WebSocket bridge that keeps a Python/MLX Magenta RT worker alive and streams stereo Float32 PCM frames back to the browser.
- `native/magenta`: notes for the lower-latency C++ `RealtimeRunner` integration.

## Run

```bash
npm install
npm run dev
```

Open the web app at `http://localhost:5173` and keep the bridge running at `ws://localhost:8787`.

In the browser:

1. Attach the plant clip/sensor to the plant.
2. Connect the sensor to the Playtronica TouchMe MIDI controller board.
3. Connect TouchMe to the laptop over USB.
4. In this app, click `Start Audio` and allow MIDI access if Chrome asks.
5. Pick the TouchMe board from the MIDI input menu if it is not already selected.
6. Wait for the `MIDI`, `Source`, and `Live` pills to turn on.
7. Click `Stop Live` to stop the continuous stream.

`Start Audio` opens the browser audio engine, connects the local bridge, opens the TouchMe MIDI input, turns on metering, and starts a paced Magenta stream. The TouchMe MIDI gestures drive the local web synth signal that Magenta listens to. The first generation loads and warms up the model, so it can take a few seconds. After that, the worker stays alive and streams 40 ms Magenta frames to the browser as they are generated.

If you want Magenta to listen to the exact sound of a synth on [synth.playtronica.com](https://synth.playtronica.com/), open that synth in another tab, click `Playtronica Tab`, and share that tab with audio enabled. If your plant sensor appears as a normal audio interface, use `Audio Input` and choose it from the input menu.

`Generate Clip` is still available for one-off finite clips. Choose `4s`, `8s`, `12s`, or `20s`, then click `Generate Clip`.

## Magenta Setup

The bridge expects Magenta RT to be installed in `.venv` and the model assets to exist under `~/Documents/Magenta/magenta-rt-v2/`:

```bash
uv venv --python 3.12
source .venv/bin/activate
uv pip install "magenta-rt[mlx]"
mrt models init
mrt models download
```

By default, the bridge uses `mrt2_small` because it is the reliable realtime model for live streaming on Apple Silicon laptops. Use base explicitly when you want higher-quality offline/clip generation and your machine can keep up:

```bash
MAGENTA_MODEL=mrt2_base npm run dev
```

## Integration Plan

The current bridge uses a persistent Python/MLX worker. That gives us real incremental Magenta audio without reloading the model on every request. The next production step is a native bridge using `magentart::core::RealtimeRunner` for lower latency and stronger realtime behavior:

- plant/Web Synth events map to live note and parameter controls.
- `RealtimeRunner::read_audio_stereo(...)` streams generated audio back to the browser.
- optional audio phrase seeding can use `set_audio_prompt_samples(...)` or `prefill_state(...)`.

For realtime work, use the MacBook with Apple Silicon. `mrt2_small` is the reliable realtime target; `mrt2_base` should be benchmarked locally before relying on it because underruns sound like distortion or crackling.
