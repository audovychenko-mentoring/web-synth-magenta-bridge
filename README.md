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
4. In this app, click `Magenta` or `Suno` and allow MIDI access if Chrome asks.
5. Wait for the status text to say the app is waiting for TouchMe MIDI signal.
6. Touch or play the plant signal through TouchMe. Generation starts after the first real MIDI signal.
7. Click `Stop` to stop waiting, stop the continuous stream, or stop Suno playback.

The `Magenta` and `Suno` buttons open the browser audio engine and connect directly to TouchMe MIDI. They do not use a mock signal. If TouchMe does not send plant MIDI, the app stays armed and silent. After the first real signal, Magenta starts a paced local live stream. Suno sends the same plant-pattern prompt as an instrumental style prompt to the Suno API, polls until an `audio_url` is available, then plays the returned track.

The performance UI is intentionally minimal: Magenta, Suno, Stop, status text, and the input meter.

If Play reports that MIDI permission is blocked, open the browser site settings for `localhost:5173`, allow MIDI devices, reload the app, and press Play again. If the setting already says allowed but the app still reports blocked, reload this exact tab or open the app in the same Chrome profile where MIDI is allowed.

If the app says it is waiting for TouchMe MIDI signal, it has opened the MIDI device but has not received plant data yet. Touch the plant/TouchMe input and watch the status text: it should change to `TouchMe MIDI received: ...`. The app listens to every Playtron/TouchMe MIDI port it can see. If it stays waiting, the TouchMe board is connected but not sending MIDI into the browser.

The MIDI monitor shows `PORTS`, `MESSAGES`, and `LAST MIDI`. After pressing Play, `MESSAGES` should increase when you touch TouchMe. If it stays `0`, the browser sees the ports but no MIDI bytes are arriving.

The MIDI input readout also shows raw MIDI bytes, normalized value, baseline delta, boosted plant amount, and whether the event is still baseline or an active plant change.

Play calibrates the TouchMe baseline for about one second. Keep hands still during calibration; after that, the app starts Magenta only when TouchMe values change from the baseline.

Small plant deviations are strongly amplified after calibration so subtle leaf/soil changes can still become musical movement.

The spectrogram visualizes the same synthesized plant input that is captured for Magenta, scrolling left over time with low frequencies at the bottom and higher frequencies at the top.

The web app sends plant-pattern metadata to the bridge, and the bridge chooses a restrained prompt that fits sparse, moderate, or active plant movement instead of using one generic prompt for every signal. Magenta uses that prompt for live generation. Suno uses the same prompt as `style` with `instrumental: true`.

## Suno Setup

The Suno API key must stay in the local bridge environment. Do not put it in browser code.

```bash
SUNO_API_KEY=sk_live_your_key npm run dev
```

The bridge submits Suno jobs with `POST https://api.suno.com/v0/audio`, then polls `GET /v0/audio/{id}` until Suno returns `audio_url`.

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
