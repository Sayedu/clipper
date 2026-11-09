"""Demucs stem separation.

  python demucs_split.py --audio in.wav --mode detect --out verdict.json
      -> {"likelyMusic": bool, "musicRatio": 0.42, "durationSec": 60.0}

  python demucs_split.py --audio in.wav --mode full --out-dir stems/ --out result.json
      -> writes stems/vocals.wav + stems/accompaniment.wav; {"vocals": "...", "accompaniment": "..."}

`--device` defaults to mps on Apple Silicon, falls back to cpu on error.
"""

from __future__ import annotations

import argparse
import os

from common import emit_result, log, main, progress, quiet_stdout

MUSIC_RATIO_THRESHOLD = 0.32


def _rms(t):
    import torch

    return float(torch.sqrt(torch.mean(t.float() ** 2)) + 1e-9)


def _separate(path: str, device: str, model: str):
    from demucs.api import Separator

    try:
        sep = Separator(model=model, device=device, progress=False)
        _, stems = sep.separate_audio_file(path)
        return stems, sep.samplerate, device
    except Exception as exc:  # noqa: BLE001 — MPS can be flaky; retry on CPU
        if device != "cpu":
            log(f"{device} separation failed ({exc}); retrying on cpu")
            sep = Separator(model=model, device="cpu", progress=False)
            _, stems = sep.separate_audio_file(path)
            return stems, sep.samplerate, "cpu"
        raise


def run() -> None:
    ap = argparse.ArgumentParser()
    ap.add_argument("--audio", required=True)
    ap.add_argument("--mode", choices=["detect", "full"], default="detect")
    ap.add_argument("--out")
    ap.add_argument("--out-dir")
    ap.add_argument("--device", default="mps")
    # htdemucs = fast · htdemucs_ft = cleaner isolation (bags 4 models, ~4x slower)
    ap.add_argument("--model", default=os.environ.get("DEMUCS_MODEL", "htdemucs"))
    args = ap.parse_args()
    with quiet_stdout():  # demucs / torch print progress + warnings to stdout
        _run_inner(args)


def _save_wav(path: str, tensor, sr: int) -> None:
    """Write a (channels, samples) float tensor as a 16-bit WAV — no torchaudio/codec deps."""
    import numpy as np
    from scipy.io import wavfile

    arr = tensor.detach().cpu().float().numpy()
    if arr.ndim == 1:
        arr = arr[None, :]
    arr = np.transpose(arr)  # -> (samples, channels)
    arr = np.clip(arr, -1.0, 1.0)
    wavfile.write(path, int(sr), (arr * 32767.0).astype(np.int16))


def _run_inner(args) -> None:
    import torch

    progress(0.1, f"loading demucs ({args.model})")
    stems, sr, used_device = _separate(args.audio, args.device, args.model)
    log(f"separated with {args.model} on {used_device} @ {sr}Hz: {list(stems.keys())}")
    progress(0.8, "analysing stems")

    vocals = stems["vocals"]
    music = sum(stems[k] for k in stems if k != "vocals")

    if args.mode == "detect":
        vr, mr = _rms(vocals), _rms(music)
        ratio = mr / (mr + vr)
        dur = vocals.shape[-1] / sr
        likely = ratio >= MUSIC_RATIO_THRESHOLD
        log(f"music ratio {ratio:.3f} over {dur:.0f}s -> {'MUSIC' if likely else 'clean'}")
        progress(1.0, "done")
        emit_result({"likelyMusic": bool(likely), "musicRatio": round(float(ratio), 3),
                     "durationSec": round(float(dur), 1)}, args.out)
        return

    out_dir = args.out_dir or os.path.dirname(args.audio)
    os.makedirs(out_dir, exist_ok=True)
    vpath = os.path.join(out_dir, "vocals.wav")
    apath = os.path.join(out_dir, "accompaniment.wav")
    _save_wav(vpath, vocals, sr)
    _save_wav(apath, music, sr)
    log(f"wrote {vpath}")
    progress(1.0, "done")
    emit_result({"vocals": vpath, "accompaniment": apath, "sampleRate": sr}, args.out)


if __name__ == "__main__":
    main(run)
