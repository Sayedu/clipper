"""Shared helpers for the ML helper scripts.

Protocol with the Node worker:
  * progress  -> a line on stderr:  @progress {"pct": 0.42, "msg": "..."}
  * logging   -> any other stderr line (surfaced in the UI "details" disclosure)
  * result    -> JSON written to the path given by --out; also printed to stdout
  * failure   -> non-zero exit, human-readable reason on stderr
"""

from __future__ import annotations

import contextlib
import json
import sys
import traceback
from typing import Any, Callable, Iterator


@contextlib.contextmanager
def quiet_stdout() -> Iterator[None]:
    """Redirect anything written to stdout onto stderr for the duration.

    ML libraries (InsightFace, onnxruntime, demucs) print load/progress chatter
    straight to stdout, which would corrupt the JSON result channel. Wrap model
    loading and inference in this so that noise lands in the log stream instead.
    `emit_result` always writes to the real stdout, so it is unaffected.
    """
    real = sys.stdout
    sys.stdout = sys.stderr
    try:
        yield
    finally:
        sys.stdout = real


def progress(pct: float, msg: str = "") -> None:
    pct = max(0.0, min(1.0, float(pct)))
    sys.stderr.write("@progress " + json.dumps({"pct": pct, "msg": msg}) + "\n")
    sys.stderr.flush()


def log(msg: str) -> None:
    sys.stderr.write(str(msg).rstrip() + "\n")
    sys.stderr.flush()


def emit_result(data: Any, out_path: str | None) -> None:
    text = json.dumps(data, ensure_ascii=False)
    if out_path:
        with open(out_path, "w", encoding="utf-8") as fh:
            fh.write(text)
    # the real stdout even if a script swapped sys.stdout via quiet_stdout()
    out = sys.__stdout__ if sys.__stdout__ is not None else sys.stdout
    out.write(text)
    out.flush()


def main(fn: Callable[[], Any]) -> None:
    """Run `fn`, converting exceptions into a non-zero exit with a readable reason."""
    try:
        fn()
    except KeyboardInterrupt:
        log("interrupted")
        sys.exit(130)
    except Exception as exc:  # noqa: BLE001 — deliberate top-level guard
        log(f"error: {exc}")
        log(traceback.format_exc())
        sys.exit(1)
