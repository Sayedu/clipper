"""Kokoro-82M text-to-speech (Apache-2.0, CPU, no cloud).

Usage:
  python tts.py --text-file script.txt --voice am_michael --out narration.wav \
      [--speed 1.0] [--model <path>] [--voices <path>]

Reads UTF-8 text, synthesises it a paragraph at a time (Kokoro handles ~30s
chunks best), concatenates with a short gap, and writes a 24 kHz mono WAV.
Prints a JSON result: {"path": "...", "durationSec": <float>, "voice": "..."}
"""

from __future__ import annotations

import argparse
import json
import os
import re

from common import emit_result, log, progress, quiet_stdout

SAMPLE_RATE = 24_000
GAP_SEC = 0.28  # silence between chunks


def _chunks(text: str, max_chars: int = 320) -> list[str]:
    """Split into sentence-ish chunks Kokoro narrates cleanly."""
    text = re.sub(r"\s+", " ", text).strip()
    sentences = re.findall(r"[^.!?]+[.!?]+[\"')\]]*|\S[^.!?]*$", text) or [text]
    out: list[str] = []
    buf = ""
    for s in sentences:
        s = s.strip()
        if not s:
            continue
        if buf and len(buf) + 1 + len(s) > max_chars:
            out.append(buf)
            buf = s
        else:
            buf = f"{buf} {s}" if buf else s
    if buf:
        out.append(buf)
    return out


def synth() -> None:
    ap = argparse.ArgumentParser()
    ap.add_argument("--text-file", required=True)
    ap.add_argument("--voice", default="am_michael")
    ap.add_argument("--speed", type=float, default=1.0)
    ap.add_argument("--lang", default="en-us")
    ap.add_argument("--out", required=True)
    here = os.path.dirname(os.path.abspath(__file__))
    default_model = os.path.join(here, "..", "assets", "kokoro", "kokoro-v1.0.onnx")
    default_voices = os.path.join(here, "..", "assets", "kokoro", "voices-v1.0.bin")
    ap.add_argument("--model", default=default_model)
    ap.add_argument("--voices", default=default_voices)
    args = ap.parse_args()

    with open(args.text_file, "r", encoding="utf-8") as fh:
        text = fh.read()
    if not text.strip():
        raise SystemExit("tts.py: empty text")

    for p in (args.model, args.voices):
        if not os.path.exists(p):
            raise SystemExit(f"tts.py: missing model file {p} — run scripts/setup.sh")

    with quiet_stdout():
        import numpy as np
        import soundfile as sf
        from kokoro_onnx import Kokoro

        progress(0.05, "loading Kokoro")
        kokoro = Kokoro(args.model, args.voices)

        parts = _chunks(text)
        gap = np.zeros(int(SAMPLE_RATE * GAP_SEC), dtype=np.float32)
        audio: list[np.ndarray] = []
        for i, chunk in enumerate(parts):
            progress(0.1 + 0.85 * i / max(len(parts), 1), f"narrating {i + 1}/{len(parts)}")
            samples, sr = kokoro.create(chunk, voice=args.voice, speed=args.speed, lang=args.lang)
            if sr != SAMPLE_RATE:
                raise SystemExit(f"tts.py: unexpected sample rate {sr}")
            audio.append(np.asarray(samples, dtype=np.float32))
            if i < len(parts) - 1:
                audio.append(gap)

        wav = np.concatenate(audio) if audio else np.zeros(1, dtype=np.float32)
        # gentle peak-normalise so loudnorm downstream has clean headroom
        peak = float(np.max(np.abs(wav))) or 1.0
        wav = (wav / peak) * 0.95
        sf.write(args.out, wav, SAMPLE_RATE, subtype="PCM_16")

    dur = round(len(wav) / SAMPLE_RATE, 2)
    log(f"{len(parts)} chunk(s) · {dur}s · voice {args.voice}")
    progress(1.0, "done")
    emit_result({"path": args.out, "durationSec": dur, "voice": args.voice}, None)


if __name__ == "__main__":
    synth()
