#!/usr/bin/env python3
"""Keep Magenta RT loaded and stream generated PCM frames to stdout.

Protocol:
  stdin: JSON lines, currently {"type": "generate", "prompt": str, "frames": int}
  stdout: repeated little-endian uint32 byte length + interleaved float32 PCM.
          A zero-length frame marks the end of one generate request.
  stderr: human-readable model logs.
"""

from __future__ import annotations

import argparse
import contextlib
import json
import logging
import struct
import sys
import time

import numpy as np


def write_packet(payload: bytes) -> None:
    sys.stdout.buffer.write(struct.pack("<I", len(payload)))
    sys.stdout.buffer.write(payload)
    sys.stdout.buffer.flush()


def waveform_to_interleaved_bytes(waveform) -> bytes:
    samples = np.asarray(waveform.samples, dtype=np.float32)
    if samples.ndim == 1:
        samples = np.stack([samples, samples], axis=1)
    elif samples.shape[1] == 1:
        samples = np.repeat(samples, 2, axis=1)
    elif samples.shape[1] > 2:
        samples = samples[:, :2]
    return np.ascontiguousarray(samples).tobytes()


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("--model", default="mrt2_base")
    parser.add_argument("--temperature", type=float, default=1.3)
    parser.add_argument("--top-k", type=int, default=40)
    parser.add_argument("--cfg-musiccoca", type=float, default=3.0)
    parser.add_argument("--cfg-notes", type=float, default=1.0)
    args = parser.parse_args()

    logging.basicConfig(level=logging.INFO, stream=sys.stderr, force=True)

    with contextlib.redirect_stdout(sys.stderr):
        from magenta_rt import MagentaRT2Mlxfn

        print(f"loading {args.model}", file=sys.stderr, flush=True)
        mrt = MagentaRT2Mlxfn(
            size=args.model,
            temperature=args.temperature,
            top_k=args.top_k,
            cfg_musiccoca=args.cfg_musiccoca,
            cfg_notes=args.cfg_notes,
        )

    state = None
    style_cache: dict[str, object] = {}

    for line in sys.stdin:
        try:
            message = json.loads(line)
            if message.get("type") != "generate":
                raise ValueError(f"unknown message type: {message.get('type')}")

            prompt = str(message.get("prompt") or "").strip()
            frames = max(1, int(message.get("frames") or 1))
            reset = bool(message.get("reset", False))
            if reset:
                state = None

            with contextlib.redirect_stdout(sys.stderr):
                if prompt not in style_cache:
                    print(f"embedding prompt: {prompt}", file=sys.stderr, flush=True)
                    style_cache[prompt] = mrt.embed_style(prompt, use_mapper=True)
                style = style_cache[prompt]

            started = time.time()
            print(f"streaming {frames} frames", file=sys.stderr, flush=True)
            for _ in range(frames):
                with contextlib.redirect_stdout(sys.stderr):
                    waveform, state = mrt.generate(style=style, frames=1, state=state)
                write_packet(waveform_to_interleaved_bytes(waveform))

            elapsed = time.time() - started
            print(f"stream done in {elapsed:.1f}s", file=sys.stderr, flush=True)
            write_packet(b"")
        except Exception as exc:  # noqa: BLE001 - keep worker alive and report to bridge.
            print(f"ERROR: {exc}", file=sys.stderr, flush=True)
            write_packet(b"")

    return 0


if __name__ == "__main__":
    raise SystemExit(main())
