"""Transcribe audio to word-level timestamps with faster-whisper.

Usage:
  python transcribe.py --audio A.wav [B.wav ...] --out a.json [b.json ...]
      [--model large-v3] [--compute int8] [--language en]

With multiple --audio/--out pairs the model is loaded once and reused. The last
file's transcript is also printed to stdout.
"""

from __future__ import annotations

import argparse
import json

from common import emit_result, log, main, progress


def _transcribe_one(model, path: str, language, beam: int) -> dict:
    segments, info = model.transcribe(
        path,
        language=language,
        word_timestamps=True,
        vad_filter=True,
        vad_parameters={"min_silence_duration_ms": 400},
        beam_size=beam,
        condition_on_previous_text=True,
    )
    total = max(float(info.duration), 0.1)
    out_segments = []
    for seg in segments:
        words = [
            {
                "start": round(float(w.start), 3),
                "end": round(float(w.end), 3),
                "word": w.word,
                "prob": round(float(w.probability), 3),
            }
            for w in (seg.words or [])
            if w.start is not None and w.end is not None
        ]
        out_segments.append(
            {
                "start": round(float(seg.start), 3),
                "end": round(float(seg.end), 3),
                "text": seg.text.strip(),
                "words": words,
            }
        )
        progress(min(seg.end / total, 0.99), f"{seg.end:.0f}s / {total:.0f}s")
    return {"language": info.language, "durationSec": round(total, 3), "segments": out_segments}


def transcribe() -> None:
    ap = argparse.ArgumentParser()
    ap.add_argument("--audio", required=True, nargs="+")
    ap.add_argument("--out", nargs="*", default=[])
    ap.add_argument("--model", default="large-v3")
    ap.add_argument("--compute", default="int8")
    ap.add_argument("--language", default=None)
    args = ap.parse_args()

    from faster_whisper import WhisperModel

    log(f"loading whisper model '{args.model}' ({args.compute}, cpu)")
    model = WhisperModel(args.model, device="cpu", compute_type=args.compute, cpu_threads=0)

    # Turbo is built for greedy decoding — beam search barely helps and is ~3x slower.
    beam = 1 if "turbo" in args.model else 5
    log(f"transcribing {len(args.audio)} file(s) (beam_size={beam})")

    last = None
    for i, audio in enumerate(args.audio):
        result = _transcribe_one(model, audio, args.language, beam)
        n_words = sum(len(s["words"]) for s in result["segments"])
        if i < len(args.out):
            with open(args.out[i], "w", encoding="utf-8") as fh:
                json.dump(result, fh, ensure_ascii=False)
            log(f"  [{i + 1}/{len(args.audio)}] {n_words} words → {args.out[i]}")
        else:
            log(f"  [{i + 1}/{len(args.audio)}] {n_words} words")
        last = result

    progress(1.0, "done")
    emit_result(last, None)  # last transcript to stdout for single-file callers


if __name__ == "__main__":
    main(transcribe)
