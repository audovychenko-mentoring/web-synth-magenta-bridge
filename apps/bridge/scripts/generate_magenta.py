#!/usr/bin/env python3
"""Generate Magenta RT audio and write interleaved float32 PCM to stdout."""

from __future__ import annotations

import argparse
import contextlib
import logging
import sys
import time

import numpy as np


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("--prompt", default="ambient plant music with soft evolving synths")
    parser.add_argument("--model", default="mrt2_base")
    parser.add_argument("--duration", type=float, default=4.0)
    parser.add_argument("--temperature", type=float, default=1.3)
    parser.add_argument("--top-k", type=int, default=40)
    parser.add_argument("--cfg-musiccoca", type=float, default=3.0)
    parser.add_argument("--cfg-notes", type=float, default=1.0)
    args = parser.parse_args()

    logging.basicConfig(level=logging.INFO, stream=sys.stderr, force=True)

    with contextlib.redirect_stdout(sys.stderr):
        from magenta_rt import MagentaRT2Mlxfn

        started = time.time()
        print(f"loading {args.model}", file=sys.stderr, flush=True)
        mrt = MagentaRT2Mlxfn(
            size=args.model,
            temperature=args.temperature,
            top_k=args.top_k,
            cfg_musiccoca=args.cfg_musiccoca,
            cfg_notes=args.cfg_notes,
        )

        print(f"embedding prompt: {args.prompt}", file=sys.stderr, flush=True)
        style = mrt.embed_style(args.prompt, use_mapper=True)
        frames = max(1, round(args.duration * 25))

        print(f"generating {frames} frames", file=sys.stderr, flush=True)
        waveform, _state = mrt.generate(style=style, frames=frames)
        elapsed = time.time() - started
        print(f"done in {elapsed:.1f}s", file=sys.stderr, flush=True)

    samples = np.asarray(waveform.samples, dtype=np.float32)
    if samples.ndim == 1:
        samples = np.stack([samples, samples], axis=1)
    elif samples.shape[1] == 1:
        samples = np.repeat(samples, 2, axis=1)
    elif samples.shape[1] > 2:
        samples = samples[:, :2]

    sys.stdout.buffer.write(np.ascontiguousarray(samples).tobytes())
    sys.stdout.buffer.flush()
    return 0


if __name__ == "__main__":
    raise SystemExit(main())

