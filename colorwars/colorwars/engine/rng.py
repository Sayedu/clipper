"""The one random generator a run is allowed to use. Every event takes this
in and threads it through every call that needs randomness -- never create
a second one, never reach for the module-level `random`/`numpy.random`
globals, and never iterate over a set/dict you did not build yourself in a
stable order. That is the whole determinism contract.
"""

from __future__ import annotations

import random


class Rng:
    """Thin wrapper around `random.Random` so call sites read clearly
    (`rng.uniform(...)`, `rng.pick(...)`) while guaranteeing there is
    exactly one underlying stream per run."""

    def __init__(self, seed: int) -> None:
        self.seed = seed
        self._r = random.Random(seed)

    def uniform(self, lo: float, hi: float) -> float:
        return self._r.uniform(lo, hi)

    def randint(self, lo: int, hi: int) -> int:
        """Inclusive on both ends, matching `random.randint`."""
        return self._r.randint(lo, hi)

    def random(self) -> float:
        return self._r.random()

    def pick(self, seq: list):
        """Choose one element from a *list* (never a set) so the order the
        caller built it in is the order considered."""
        return self._r.choice(seq)

    def shuffled(self, seq: list) -> list:
        out = list(seq)
        self._r.shuffle(out)
        return out

    def chance(self, p: float) -> bool:
        return self._r.random() < p
