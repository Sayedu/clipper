#!/usr/bin/env bash
# ---------------------------------------------------------------------------
# One-shot setup for the Personal YouTube Auto-Clipper.
# Idempotent: safe to re-run. Heavy steps (model pulls) are skipped if present.
# ---------------------------------------------------------------------------
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT"

log()  { printf '\n\033[1;34m▸ %s\033[0m\n' "$*"; }
ok()   { printf '  \033[1;32m✓\033[0m %s\n' "$*"; }
warn() { printf '  \033[1;33m!\033[0m %s\n' "$*"; }
die()  { printf '\n\033[1;31m✗ %s\033[0m\n' "$*" >&2; exit 1; }

# Load .env values we care about (OLLAMA_MODEL / WHISPER_MODEL) if present.
[ -f .env ] && set -a && . ./.env && set +a || true
OLLAMA_MODEL="${OLLAMA_MODEL:-llama3.1:8b}"
WHISPER_MODEL="${WHISPER_MODEL:-large-v3}"
WHISPER_COMPUTE="${WHISPER_COMPUTE:-int8}"
OLLAMA_URL="${OLLAMA_URL:-http://127.0.0.1:11434}"

# ---------------------------------------------------------------------------
log "Core tools"
command -v brew   >/dev/null || die "Homebrew not found — https://brew.sh"
command -v node   >/dev/null || die "Node.js not found (brew install node)"
command -v npm    >/dev/null || die "npm not found"
command -v uv     >/dev/null || die "uv not found (brew install uv)"
PY312="$(command -v python3.12 || true)"
[ -n "$PY312" ] || die "python3.12 not found (brew install python@3.12)"
ok "node $(node -v) · uv $(uv --version | awk '{print $2}') · $($PY312 -V)"

# ---------------------------------------------------------------------------
log "ffmpeg-full + yt-dlp + ollama (Homebrew)"
# The slim `ffmpeg` formula has no libass/freetype, so captions can't be burned.
# ffmpeg-full has them; it is keg-only (not symlinked) — the worker finds it directly.
if brew list ffmpeg-full >/dev/null 2>&1; then
  ok "ffmpeg-full $(/opt/homebrew/opt/ffmpeg-full/bin/ffmpeg -version 2>/dev/null | head -1 | awk '{print $3}')"
else
  brew install ffmpeg-full && ok "ffmpeg-full installed"
fi
/opt/homebrew/opt/ffmpeg-full/bin/ffmpeg -hide_banner -filters 2>/dev/null | grep -q ' ass ' \
  && ok "libass 'ass' filter present" || warn "ffmpeg-full missing the 'ass' filter — captions will fail"
if brew list yt-dlp >/dev/null 2>&1; then ok "yt-dlp $(yt-dlp --version)"; else brew install yt-dlp && ok "yt-dlp installed"; fi
if brew list ollama >/dev/null 2>&1; then ok "ollama present";            else brew install ollama && ok "ollama installed"; fi

# ---------------------------------------------------------------------------
log "Ollama service + model ($OLLAMA_MODEL)"
if ! curl -sf "$OLLAMA_URL/api/version" >/dev/null 2>&1; then
  brew services start ollama >/dev/null 2>&1 || nohup ollama serve >/tmp/ollama-serve.log 2>&1 &
  for _ in $(seq 1 30); do curl -sf "$OLLAMA_URL/api/version" >/dev/null 2>&1 && break; sleep 1; done
fi
curl -sf "$OLLAMA_URL/api/version" >/dev/null 2>&1 || die "Ollama did not come up at $OLLAMA_URL"
ok "ollama serving at $OLLAMA_URL"
if ollama list 2>/dev/null | awk '{print $1}' | grep -qx "$OLLAMA_MODEL"; then
  ok "model $OLLAMA_MODEL already pulled"
else
  warn "pulling $OLLAMA_MODEL — several GB, one time only"
  ollama pull "$OLLAMA_MODEL"
  ok "model ready"
fi

# ---------------------------------------------------------------------------
log "Python 3.12 venv + ML packages"
[ -d python/.venv ] || uv venv --python "$PY312" python/.venv
VENV_PY="$ROOT/python/.venv/bin/python"
uv pip install --python "$VENV_PY" -r <(cat <<'REQ'
faster-whisper>=1.1.0
scenedetect>=0.6.4
opencv-python>=4.10
mediapipe>=0.10.14
numpy>=1.26
torch>=2.2
torchaudio>=2.2
demucs>=4.0
insightface>=0.7
open_clip_torch>=2.24
onnxruntime>=1.17
kokoro-onnx>=0.4
soundfile>=0.12
REQ
)
"$VENV_PY" - <<'PY'
import faster_whisper, scenedetect, cv2, mediapipe, numpy, torch, demucs, insightface, open_clip
import kokoro_onnx, soundfile
print(f"  faster-whisper {faster_whisper.__version__} · scenedetect {scenedetect.__version__} · "
      f"opencv {cv2.__version__} · torch {torch.__version__} (mps={torch.backends.mps.is_available()}) · kokoro-onnx ok")
PY
ok "ML packages installed (transcription + content-filter stack)"

# ---------------------------------------------------------------------------
log "Whisper models warm-up ($WHISPER_MODEL + large-v3-turbo, $WHISPER_COMPUTE)"
WHISPER_MODEL="$WHISPER_MODEL" WHISPER_COMPUTE="$WHISPER_COMPUTE" "$VENV_PY" - <<'PY'
import os
from faster_whisper import WhisperModel
c = os.environ["WHISPER_COMPUTE"]
for m in {os.environ["WHISPER_MODEL"], "large-v3-turbo"}:
    print(f"  fetching '{m}' CTranslate2 weights (cached after first run)...")
    WhisperModel(m, device="cpu", compute_type=c)
print("  models cached")
PY
ok "whisper ready (large-v3 for accuracy, large-v3-turbo for ~5x speed)"

# ---------------------------------------------------------------------------
log "Content-filter models (Demucs · InsightFace · CLIP — ~2 GB, one time)"
"$VENV_PY" - <<'PY'
import warnings; warnings.filterwarnings("ignore")
from demucs.pretrained import get_model
get_model("htdemucs"); print("  demucs htdemucs")
from insightface.app import FaceAnalysis
FaceAnalysis(name="buffalo_l", providers=["CPUExecutionProvider"]).prepare(ctx_id=-1, det_size=(640, 640))
print("  insightface buffalo_l")
import open_clip
open_clip.create_model_and_transforms("ViT-B-32", pretrained="laion2b_s34b_b79k")
print("  open_clip ViT-B-32")
PY
ok "content-filter models cached"

# ---------------------------------------------------------------------------
log "Kokoro-82M TTS model (Storyteller mode — ~340 MB, one time)"
mkdir -p assets/kokoro
KOKORO_BASE="https://github.com/thewh1teagle/kokoro-onnx/releases/download/model-files-v1.0"
[ -s assets/kokoro/kokoro-v1.0.onnx ] || curl -fL --progress-bar -o assets/kokoro/kokoro-v1.0.onnx "$KOKORO_BASE/kokoro-v1.0.onnx"
[ -s assets/kokoro/voices-v1.0.bin ]  || curl -fL --progress-bar -o assets/kokoro/voices-v1.0.bin  "$KOKORO_BASE/voices-v1.0.bin"
"$VENV_PY" - <<'PY'
from kokoro_onnx import Kokoro
Kokoro("assets/kokoro/kokoro-v1.0.onnx", "assets/kokoro/voices-v1.0.bin")
print("  kokoro-onnx v1.0 loads")
PY
ok "Kokoro TTS ready"

# ---------------------------------------------------------------------------
log "Caption fonts (OFL — redistributable)"
mkdir -p assets/fonts
font() {
  local name="$1" url="$2"
  [ -s "assets/fonts/$name" ] && { ok "$name"; return; }
  if curl -sfL --retry 2 "$url" -o "assets/fonts/$name" && [ -s "assets/fonts/$name" ]; then
    ok "$name"
  else
    rm -f "assets/fonts/$name"
    warn "could not fetch $name — drop a .ttf into assets/fonts/ manually"
  fi
}
font "Anton-Regular.ttf"          "https://github.com/google/fonts/raw/main/ofl/anton/Anton-Regular.ttf"
font "Montserrat-Bold.ttf"        "https://github.com/google/fonts/raw/main/apache/montserrat/static/Montserrat-Bold.ttf"
font "Montserrat-VariableFont.ttf" "https://github.com/google/fonts/raw/main/ofl/montserrat/Montserrat%5Bwght%5D.ttf"

# ---------------------------------------------------------------------------
log "Face-detection model (OpenCV YuNet — subject-tracked reframe)"
mkdir -p assets/models
if [ -s assets/models/face_detection_yunet.onnx ]; then
  ok "face_detection_yunet.onnx"
elif curl -sfL --retry 2 \
  "https://github.com/opencv/opencv_zoo/raw/main/models/face_detection_yunet/face_detection_yunet_2023mar.onnx" \
  -o assets/models/face_detection_yunet.onnx && [ -s assets/models/face_detection_yunet.onnx ]; then
  ok "face_detection_yunet.onnx"
else
  rm -f assets/models/face_detection_yunet.onnx
  warn "could not fetch YuNet model — reframe will fall back to OpenCV Haar cascade (bundled)"
fi

# ---------------------------------------------------------------------------
log "Sound-effect pack"
bash scripts/make-sfx.sh

# ---------------------------------------------------------------------------
log "npm workspaces"
npm install --no-fund --no-audit
# npm >= 11.5 gates native install scripts; better-sqlite3 + esbuild(tsx) need theirs.
if npm approve-scripts --allow-scripts-pending 2>/dev/null | grep -q .; then
  npm approve-scripts better-sqlite3 esbuild prebuild-install >/dev/null 2>&1 || true
fi
node -e "require('better-sqlite3')" 2>/dev/null && ok "better-sqlite3 native build ok" || warn "better-sqlite3 failed to load — run: npm approve-scripts better-sqlite3 && npm rebuild better-sqlite3"
ok "node_modules ready"

# ---------------------------------------------------------------------------
# Headless Chromium for the browser-based renderers (3D marble race — Three.js +
# Rapier; Laser Nations — 2D Canvas)
log "Playwright Chromium (marble race / laser nations renderer)"
if node -e "const{chromium}=require('playwright-core');require('fs').accessSync(chromium.executablePath())" 2>/dev/null; then
  ok "Chrome for Testing already installed"
else
  npx --yes playwright install chromium 2>&1 | tail -2 && ok "Chromium installed" \
    || warn "playwright chromium install failed — 'marblerace' / 'lasernations' content types will not render until: npx playwright install chromium"
fi

# ---------------------------------------------------------------------------
log ".env"
if [ -f .env ]; then
  ok ".env exists"
else
  cp .env.example .env
  warn "created .env from template — add your YT_API_KEY before running the pipeline"
fi

mkdir -p data/work data/library && touch data/.gitkeep

# ---------------------------------------------------------------------------
log "Doctor"
npm run doctor || warn "doctor found issues (see above) — fix and re-run 'npm run doctor'"

printf '\n\033[1;32m✔ Setup complete.\033[0m\n'
printf '  1. Put your YouTube Data API key in \033[1m.env\033[0m  (YT_API_KEY=...)\n'
printf '  2. \033[1mnpm run dev\033[0m   then open http://localhost:%s\n\n' "${WEB_PORT:-3000}"
