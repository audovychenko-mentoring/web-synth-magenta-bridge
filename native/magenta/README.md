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
- output: 48 kHz stereo Float32 PCM, interleaved

The current bridge uses the Python/MLX package as an interim real-audio path. The native replacement should:

1. Load resources from `~/Documents/Magenta/magenta-rt-v2/resources`.
2. Load `mrt2_small` by default, with `mrt2_base` as an option.
3. Start a persistent `RealtimeRunner`.
4. Map plant/Web Synth events to `set_note_on`, `set_note_off`, prompt weights, and sampling parameters.
5. Stream `RealtimeRunner::read_audio_stereo(...)` chunks back to the browser.
6. Keep `prefill_state(...)` optional for phrase-seeded continuation.
