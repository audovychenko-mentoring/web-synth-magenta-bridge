# Native Magenta Adapter

This folder is reserved for the C++ bridge that will link against Magenta RT:

```cmake
FetchContent_Declare(
  magenta_rt
  GIT_REPOSITORY https://github.com/magenta/magenta-realtime.git
  GIT_TAG main
)
FetchContent_MakeAvailable(magenta_rt)
target_link_libraries(magenta_bridge PRIVATE magentart::core)
```

The browser bridge contract is already established by `apps/bridge`:

- input: 48 kHz stereo Float32 PCM, interleaved `[L, R, L, R, ...]`
- capture cap: 28 seconds, matching Magenta RT's current SpectroStream prefill encoder shape
- output: 48 kHz stereo Float32 PCM, interleaved

The first native replacement should:

1. Load resources from `~/Documents/Magenta/magenta-rt-v2/resources`.
2. Load `mrt2_small` by default.
3. Call `RealtimeRunner::load_prefill_model(...)`.
4. On `magenta:prefill`, call `RealtimeRunner::prefill_state(...)`.
5. Stream `RealtimeRunner::read_audio_stereo(...)` chunks back to the browser.

