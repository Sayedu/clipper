"""Plain-assert tests for the pure crop-vs-letterbox decision.

Run with the venv python:  python/.venv/bin/python python/test_reframe.py
(no pytest needed — kept dependency-free so `npm test` can shell out to it).
"""

from __future__ import annotations

import sys

from reframe import PROMINENT_MIN_FRAC, WIDE_SPREAD_FRAC, decide_letterbox

CASES = [
    # (mode, prominent_frac, wide_frac) -> want_letterbox
    (("always-crop", 0.0, 1.0), False),          # forced crop wins even with no subject
    (("always-letterbox", 1.0, 0.0), True),      # forced letterbox wins even with a clean subject
    (("auto", 0.95, 0.0), False),                # big talking-head face in most frames -> crop
    (("auto", 0.05, 0.0), True),                 # only a corner facecam / gameplay -> letterbox
    (("auto", 0.0, 0.0), True),                  # no face at all -> letterbox, don't blind-crop
    (("auto", 0.40, 0.0), True),                 # face present but not in enough frames -> letterbox
    (("auto", 0.80, 0.60), True),                # subject ok but people spread wide -> letterbox
    (("auto", PROMINENT_MIN_FRAC, 0.0), False),  # exactly at the threshold is still croppable
    (("auto", PROMINENT_MIN_FRAC - 1e-9, 0.0), True),
    (("auto", 0.9, WIDE_SPREAD_FRAC), False),    # exactly at the wide threshold -> crop
    (("auto", 0.9, WIDE_SPREAD_FRAC + 1e-9), True),
]


def main() -> int:
    failures = 0
    for args, want in CASES:
        got, reason = decide_letterbox(*args)
        ok = got == want
        if not ok:
            failures += 1
        print(f"{'ok  ' if ok else 'FAIL'} decide_letterbox{args} -> {got!r} ({reason or 'no reason'})")
    if failures:
        print(f"\n{failures} failing case(s)")
        return 1
    print(f"\nall {len(CASES)} cases passed")
    return 0


if __name__ == "__main__":
    sys.exit(main())
