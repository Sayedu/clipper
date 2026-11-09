#!/usr/bin/env bash
# Synthesize a small CC0 sound-effect pack with ffmpeg (no downloads, no licensing).
# Output: assets/sfx/starter/*.wav  (48kHz stereo)
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
OUT="$ROOT/assets/sfx/starter"
mkdir -p "$OUT"

gen() { # gen <name> <ffmpeg-input-args...> -af <filters>
  local name="$1"; shift
  if [ -f "$OUT/$name.wav" ]; then
    printf '  = %s\n' "$name.wav"
    return
  fi
  ffmpeg -hide_banner -loglevel error -y "$@" -ar 48000 -ac 2 "$OUT/$name.wav"
  printf '  + %s\n' "$name.wav"
}

# whoosh — pink-noise burst, band-limited, quick swell then fall
gen whoosh \
  -f lavfi -i "anoisesrc=d=0.55:c=pink:a=0.7" \
  -af "highpass=f=250,lowpass=f=7500,afade=t=in:st=0:d=0.12:curve=ipar,afade=t=out:st=0.2:d=0.35:curve=exp,volume=1.4"

# pop — short mid sine blip
gen pop \
  -f lavfi -i "sine=f=660:d=0.09" \
  -af "afade=t=out:st=0:d=0.09:curve=exp,volume=0.7"

# tick — very short high click (transition marker)
gen tick \
  -f lavfi -i "sine=f=2100:d=0.035" \
  -af "afade=t=out:st=0:d=0.035:curve=exp,volume=0.5"

# riser — sweeping tone rising in pitch, swells then cuts
gen riser \
  -f lavfi -i "aevalsrc=exprs=sin(2*PI*t*(260+220*t)):s=48000:d=1.30" \
  -af "afade=t=in:st=0:d=0.15,afade=t=out:st=1.05:d=0.25:curve=exp,volume=0.55"

# impact — low sine thud with fast attack / exponential decay
gen impact \
  -f lavfi -i "sine=f=72:d=0.7" \
  -af "afade=t=in:st=0:d=0.006,afade=t=out:st=0.06:d=0.64:curve=exp,volume=1.6"

# ding — two-tone chime, long exponential decay
if [ ! -f "$OUT/ding.wav" ]; then
  ffmpeg -hide_banner -loglevel error -y \
    -f lavfi -i "sine=f=880:d=0.9" \
    -f lavfi -i "sine=f=1320:d=0.9" \
    -filter_complex "[0][1]amix=inputs=2:weights=1 0.5[m];[m]afade=t=out:st=0.1:d=0.8:curve=exp,volume=0.6[o]" \
    -map "[o]" -ar 48000 -ac 2 "$OUT/ding.wav"
  printf '  + ding.wav\n'
else
  printf '  = ding.wav\n'
fi

cat > "$OUT/LICENSE.txt" <<'EOF'
These sound effects were synthesized locally with ffmpeg oscillators/noise
generators as part of project setup. They contain no third-party recordings.
Released to the public domain (CC0 1.0). Do whatever you like with them.

Drop your own .wav / .mp3 files into any folder under assets/sfx/<packname>/
and they will show up as a selectable pack in the dashboard.
EOF

printf 'sfx pack ready: %s\n' "$OUT"
