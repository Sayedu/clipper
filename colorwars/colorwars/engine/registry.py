"""The one place that maps an event id to its Event instance. Both cli.py
and mining.py (which runs in separate worker processes, so it needs its own
import, not a shared cache) call this instead of keeping their own copy of
the if/elif list -- adding an event means one new branch here, not two.
"""

from __future__ import annotations

from .event import Event

KNOWN_EVENT_IDS = ["ring_of_doom", "shell_shuffle", "disaster_drop"]


def get_event(event_id: str) -> Event:
    if event_id == "ring_of_doom":
        from ..events.ring_of_doom.event import RingOfDoomEvent

        return RingOfDoomEvent()
    if event_id == "shell_shuffle":
        from ..events.shell_shuffle.event import ShellShuffleEvent

        return ShellShuffleEvent()
    if event_id == "disaster_drop":
        from ..events.disaster_drop.event import DisasterDropEvent

        return DisasterDropEvent()
    raise ValueError(f"unknown event: {event_id!r} (known: {', '.join(KNOWN_EVENT_IDS)})")
