# Ableton Extension

This workspace is the staging area for moving the plant-to-Magenta workflow into Ableton Live as an Ableton Extension.

## Current Status

The repo is configured, but implementation is intentionally paused until the Ableton Extensions SDK beta package is downloaded locally. Ableton currently provides the SDK through the Live 12.4.5 Suite Beta program, not as a normal public npm dependency.

Check local readiness:

```bash
npm run ableton:check
```

## Required Local Setup

1. Install Ableton Live 12 Suite Beta, version 12.4.5 or later.
2. Download the Extensions SDK and Documentation from Ableton Centercode.
3. Copy the SDK `.tgz` files into:

```text
vendor/ableton-sdk/
```

Do not commit the SDK tarballs. They are ignored by git.

## Product Direction

Ableton Extensions are JavaScript/TypeScript tools that run from Live's context menus and act on Set objects such as tracks, clips, MIDI notes, devices, and arrangement structure. They are not VSTs, Max for Live devices, or continuous real-time audio processors.

For this project, the extension should start as a Live workflow tool that:

- reads the selected MIDI clip or selected track context.
- talks to the local Magenta bridge when needed.
- creates or updates a MIDI/audio clip in Live from the plant-pattern/Magenta output.
- keeps the existing browser app as a development harness until the Ableton SDK package is available.

The continuous TouchMe/Web MIDI capture path may need to remain in a companion local process unless the SDK beta exposes a suitable real-time input surface.
