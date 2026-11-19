"""One line of speech with edge-tts (Microsoft Edge neural voices, online).

Usage:
  python edge_tts_line.py --text "Which police car has the sirens?" \
      --voice en-US-AndrewNeural --rate +10% --out line.mp3

Writes an MP3 and prints {"path": "...", "voice": "...", "rate": "..."}.
Exits 1 with a message on stderr if the service can't be reached.
"""

from __future__ import annotations

import argparse
import asyncio
import json
import sys

import edge_tts


async def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--text", required=True)
    ap.add_argument("--voice", default="en-US-AndrewNeural")
    ap.add_argument("--rate", default="+10%")
    ap.add_argument("--pitch", default="+0Hz")
    ap.add_argument("--out", required=True)
    a = ap.parse_args()
    # the online service now and then answers with no audio at all (the same
    # text works on the next try), so retry a few times before giving up
    last = ""
    for attempt in range(1, 6):
        try:
            await edge_tts.Communicate(a.text, a.voice, rate=a.rate, pitch=a.pitch).save(a.out)
            print(json.dumps({"path": a.out, "voice": a.voice, "rate": a.rate, "attempts": attempt}))
            return 0
        except Exception as exc:  # noqa: BLE001 — network, bad voice name, no audio
            last = str(exc)
            await asyncio.sleep(0.5 * attempt)
    print(f"edge-tts failed after 5 tries: {last}", file=sys.stderr)
    return 1


if __name__ == "__main__":
    raise SystemExit(asyncio.run(main()))
