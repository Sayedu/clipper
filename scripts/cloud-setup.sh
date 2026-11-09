#!/usr/bin/env bash
# ===========================================================================
#  Clipper — one-shot provisioning for an Oracle Cloud "Always Free" VM.
#  Target:  Ubuntu 24.04 (aarch64), Ampere A1  ·  4 OCPU / 24 GB recommended.
#  Idempotent: safe to re-run. Heavy steps (model pulls) skip if already done.
#
#  Usage (on the VM, as the default 'ubuntu' user):
#     git clone <your repo> ~/clipping && cd ~/clipping
#     bash scripts/cloud-setup.sh
# ===========================================================================
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT"
RUN_USER="$(id -un)"

log()  { printf '\n\033[1;34m▸ %s\033[0m\n' "$*"; }
ok()   { printf '  \033[1;32m✓\033[0m %s\n' "$*"; }
warn() { printf '  \033[1;33m!\033[0m %s\n' "$*"; }
die()  { printf '\n\033[1;31m✗ %s\033[0m\n' "$*" >&2; exit 1; }

[ "$(uname -s)" = "Linux" ] || die "This script is for the Linux VM. Use scripts/setup.sh on macOS."
command -v apt-get >/dev/null || die "Expected an apt-based distro (Ubuntu 24.04)."

# --- env we care about -----------------------------------------------------
[ -f .env ] && set -a && . ./.env && set +a || true
OLLAMA_MODEL="${OLLAMA_MODEL:-llama3.1:8b}"
WHISPER_MODEL="${WHISPER_MODEL:-large-v3-turbo}"
WHISPER_COMPUTE="${WHISPER_COMPUTE:-int8}"
WEB_PORT="${WEB_PORT:-3100}"
OLLAMA_URL="${OLLAMA_URL:-http://127.0.0.1:11434}"
LLM_PROVIDER="${LLM_PROVIDER:-ollama}"

# ---------------------------------------------------------------------------
log "System packages (apt)"
sudo apt-get update -qq
sudo DEBIAN_FRONTEND=noninteractive apt-get install -y -qq \
  ffmpeg python3.12 python3.12-venv python3.12-dev \
  build-essential pkg-config git curl jq ca-certificates unzip \
  libgl1 libglib2.0-0 >/dev/null
ffmpeg -hide_banner -filters 2>/dev/null | grep -q ' ass ' \
  && ok "ffmpeg $(ffmpeg -version | head -1 | awk '{print $3}') + libass" \
  || die "apt ffmpeg is missing the 'ass' filter — unexpected on Ubuntu"
ok "python $(python3.12 -V | awk '{print $2}')"

# ---------------------------------------------------------------------------
log "Swap (safety headroom for Whisper + Demucs + Ollama at once)"
if ! swapon --show | grep -q .; then
  sudo fallocate -l 6G /swapfile && sudo chmod 600 /swapfile
  sudo mkswap /swapfile >/dev/null && sudo swapon /swapfile
  echo '/swapfile none swap sw 0 0' | sudo tee -a /etc/fstab >/dev/null
  ok "6 GB swapfile added"
else
  ok "swap already configured"
fi

# ---------------------------------------------------------------------------
log "Node.js 20 (NodeSource)"
if ! command -v node >/dev/null || [ "$(node -v | cut -c2- | cut -d. -f1)" -lt 20 ]; then
  curl -fsSL https://deb.nodesource.com/setup_20.x | sudo -E bash - >/dev/null
  sudo apt-get install -y -qq nodejs >/dev/null
fi
ok "node $(node -v) · npm $(npm -v)"

# ---------------------------------------------------------------------------
log "uv (Python package manager)"
if ! command -v uv >/dev/null; then
  curl -LsSf https://astral.sh/uv/install.sh | sh >/dev/null
  export PATH="$HOME/.local/bin:$PATH"
fi
command -v uv >/dev/null || die "uv install failed"
ok "uv $(uv --version | awk '{print $2}')"

# ---------------------------------------------------------------------------
log "yt-dlp (latest — self-updating binary)"
if ! command -v yt-dlp >/dev/null; then
  sudo curl -fsSL https://github.com/yt-dlp/yt-dlp/releases/latest/download/yt-dlp_linux_aarch64 \
    -o /usr/local/bin/yt-dlp && sudo chmod a+rx /usr/local/bin/yt-dlp
fi
ok "yt-dlp $(yt-dlp --version)"

# ---------------------------------------------------------------------------
if [ "$LLM_PROVIDER" = "ollama" ]; then
  log "Ollama (installs its own systemd service)"
  if ! command -v ollama >/dev/null; then
    curl -fsSL https://ollama.com/install.sh | sh
  fi
  sudo systemctl enable --now ollama >/dev/null 2>&1 || true
  for _ in $(seq 1 30); do curl -sf "$OLLAMA_URL/api/version" >/dev/null 2>&1 && break; sleep 1; done
  curl -sf "$OLLAMA_URL/api/version" >/dev/null 2>&1 || die "Ollama did not start"
  ok "ollama serving at $OLLAMA_URL"
  if ollama list 2>/dev/null | awk '{print $1}' | grep -qx "$OLLAMA_MODEL"; then
    ok "model $OLLAMA_MODEL present"
  else
    warn "pulling $OLLAMA_MODEL (~5 GB, one time — slow on first run)"
    ollama pull "$OLLAMA_MODEL"
    ok "model ready"
  fi
else
  log "LLM: using a hosted OpenAI-compatible API (LLM_PROVIDER=$LLM_PROVIDER) — skipping Ollama"
  ok "make sure LLM_BASE_URL / LLM_MODEL / LLM_API_KEY are set in .env"
fi

# ---------------------------------------------------------------------------
log "Python venv + ML packages (aarch64 wheels)"
[ -d python/.venv ] || uv venv --python "$(command -v python3.12)" python/.venv
VENV_PY="$ROOT/python/.venv/bin/python"
# mediapipe wheels for aarch64 can lag — install it best-effort, the rest are required.
uv pip install --python "$VENV_PY" \
  "faster-whisper>=1.1.0" "scenedetect>=0.6.4" "opencv-python-headless>=4.10" "numpy>=1.26" \
  "torch>=2.2" "torchaudio>=2.2" "demucs>=4.0" "insightface>=0.7" "open_clip_torch>=2.24" \
  "onnxruntime>=1.17" "soundfile>=0.12"
uv pip install --python "$VENV_PY" "mediapipe>=0.10.14" 2>/dev/null && ok "mediapipe ok" \
  || warn "mediapipe unavailable for aarch64 — fine, reframe uses OpenCV YuNet"
"$VENV_PY" - <<'PY'
import faster_whisper, scenedetect, cv2, numpy, torch, demucs, insightface, open_clip
print(f"  faster-whisper {faster_whisper.__version__} · torch {torch.__version__} (cpu) · "
      f"opencv {cv2.__version__} · demucs · insightface · open_clip")
PY
ok "ML stack installed"

# ---------------------------------------------------------------------------
log "Model warm-up (Whisper · Demucs · InsightFace · CLIP — ~3 GB, one time)"
WHISPER_MODEL="$WHISPER_MODEL" WHISPER_COMPUTE="$WHISPER_COMPUTE" "$VENV_PY" - <<'PY'
import os, warnings; warnings.filterwarnings("ignore")
from faster_whisper import WhisperModel
for m in {os.environ["WHISPER_MODEL"], "large-v3-turbo"}:
    print(f"  whisper '{m}' ..."); WhisperModel(m, device="cpu", compute_type=os.environ["WHISPER_COMPUTE"])
from demucs.pretrained import get_model
get_model("htdemucs"); print("  demucs htdemucs")
from insightface.app import FaceAnalysis
FaceAnalysis(name="buffalo_l", providers=["CPUExecutionProvider"]).prepare(ctx_id=-1, det_size=(640,640))
print("  insightface buffalo_l")
import open_clip
open_clip.create_model_and_transforms("ViT-B-32", pretrained="laion2b_s34b_b79k"); print("  open_clip ViT-B-32")
PY
ok "models cached under ~/.cache and ~/.insightface"

# ---------------------------------------------------------------------------
log "Fonts · face model · SFX"
mkdir -p assets/fonts assets/models
_get() { [ -s "$2" ] && return 0; curl -sfL --retry 2 "$1" -o "$2" && [ -s "$2" ] || { rm -f "$2"; return 1; }; }
_get "https://github.com/google/fonts/raw/main/ofl/anton/Anton-Regular.ttf"            assets/fonts/Anton-Regular.ttf          && ok "Anton" || warn "Anton font failed"
_get "https://github.com/google/fonts/raw/main/apache/montserrat/static/Montserrat-Bold.ttf" assets/fonts/Montserrat-Bold.ttf   && ok "Montserrat-Bold" || true
_get "https://github.com/google/fonts/raw/main/ofl/montserrat/Montserrat%5Bwght%5D.ttf" assets/fonts/Montserrat-VariableFont.ttf && ok "Montserrat" || true
_get "https://github.com/opencv/opencv_zoo/raw/main/models/face_detection_yunet/face_detection_yunet_2023mar.onnx" \
  assets/models/face_detection_yunet.onnx && ok "YuNet face model" || warn "YuNet failed — Haar fallback"
bash scripts/make-sfx.sh || warn "SFX pack step had issues"

# ---------------------------------------------------------------------------
log ".env"
if [ ! -f .env ]; then
  cp .env.example .env
  # sensible cloud default: turbo Whisper (CPU-only box)
  sed -i 's/^WHISPER_MODEL=.*/WHISPER_MODEL=large-v3-turbo/' .env
  warn "created .env — you MUST add YT_API_KEY and (recommended) YTDLP_COOKIES_FILE"
else
  ok ".env exists"
fi
mkdir -p data/work data/library secrets

# ---------------------------------------------------------------------------
log "npm workspaces + web build"
npm install --no-fund --no-audit
npm approve-scripts better-sqlite3 esbuild prebuild-install >/dev/null 2>&1 || true
npm rebuild better-sqlite3 >/dev/null 2>&1 || true
node -e "require('better-sqlite3')" 2>/dev/null && ok "better-sqlite3 native ok" || die "better-sqlite3 failed to build"
npm run build --workspace web
ok "dashboard built"

# ---------------------------------------------------------------------------
log "systemd services (worker + dashboard, auto-restart, start on boot)"
for unit in clipper-worker clipper-web; do
  sed -e "s|__USER__|$RUN_USER|g" -e "s|__REPO__|$ROOT|g" -e "s|__WEBPORT__|$WEB_PORT|g" \
    "deploy/$unit.service" | sudo tee "/etc/systemd/system/$unit.service" >/dev/null
done
sudo systemctl daemon-reload
sudo systemctl enable clipper-worker clipper-web >/dev/null
ok "installed — start them after you set YT_API_KEY:  sudo systemctl start clipper-worker clipper-web"

# ---------------------------------------------------------------------------
log "Instance firewall — open the dashboard port ($WEB_PORT)"
# OCI Ubuntu images ship strict iptables rules that block everything but SSH.
if sudo iptables -C INPUT -p tcp --dport "$WEB_PORT" -j ACCEPT 2>/dev/null; then
  ok "port $WEB_PORT already allowed"
else
  sudo iptables -I INPUT 6 -p tcp --dport "$WEB_PORT" -j ACCEPT
  sudo netfilter-persistent save >/dev/null 2>&1 || sudo sh -c 'iptables-save > /etc/iptables/rules.v4' 2>/dev/null || true
  ok "port $WEB_PORT opened on the instance (also add an ingress rule in the OCI console — see CLOUD.md)"
fi
warn "the worker stays bound to 127.0.0.1 — only the dashboard port is exposed"

cat <<EOF

$(printf '\033[1;32m✔ Cloud setup complete.\033[0m')

Next:
  1. nano .env            → set YT_API_KEY=...   (and YTDLP_COOKIES_FILE — see CLOUD.md)
  2. npm run doctor       → everything green?
  3. sudo systemctl start clipper-worker clipper-web
  4. From your laptop, reach the dashboard — pick ONE (CLOUD.md has the details):
       • Tailscale (recommended): http://<vm-tailscale-name>:$WEB_PORT
       • SSH tunnel:  ssh -N -L $WEB_PORT:localhost:$WEB_PORT ubuntu@<vm-ip>  → http://localhost:$WEB_PORT
       • Public IP:   add an OCI ingress rule for TCP $WEB_PORT → http://<vm-public-ip>:$WEB_PORT

Logs:   journalctl -u clipper-worker -f      journalctl -u clipper-web -f
Update: git pull && npm install && npm run build --workspace web && sudo systemctl restart clipper-worker clipper-web
EOF
