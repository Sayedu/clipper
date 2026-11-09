# Running Clipper on an Oracle Cloud VM (Always Free)

Goal: the whole pipeline — LLM, Whisper, Demucs, ffmpeg — runs on a free Oracle Cloud
instance, and you open the dashboard from your Mac over a private link. Nothing heavy runs
on your laptop.

---

## Two decisions first

### 1. Which LLM?

The model does segment ranking, hook writing, the halal check, and the trending-topic pick.

| Option | Cost | Speed on the free VM | Quality |
|---|---|---|---|
| **Local Ollama** `llama3.1:8b` | free, no key | slow (CPU only, ~5–10 tok/s) — adds minutes per run | ok |
| Local Ollama `qwen2.5:3b` | free, no key | ~3× faster | ok for JSON tasks |
| **Google Gemini** `gemini-2.5-flash` | **free tier** (you already have a Google Cloud project) | instant | best — recommended |
| Groq `llama-3.3-70b` | free tier | instant | very good |

**Recommendation: Gemini free tier.** It's smart, instant, uses no VM compute, and the free
limits (≈15 req/min, ~1M tokens/day) are far more than a personal clipper needs. Get a key at
<https://aistudio.google.com/apikey>. This also means the VM can be smaller and cooler.

### 2. How do you reach the dashboard from your Mac?

| Option | Setup | Security |
|---|---|---|
| **Tailscale** | install on the VM + your Mac, both join your tailnet | private, no open ports, works from anywhere — **recommended** |
| SSH tunnel | one command, nothing to install | private, but the terminal must stay open |
| Public IP | open a port in the OCI console + instance firewall | exposed to the internet — only with a strong setup |

---

## Step 1 — Create the instance (OCI Console)

1. **Compute → Instances → Create instance.**
2. **Image:** *Canonical Ubuntu 24.04* (make sure it's the **aarch64 / Arm** build).
3. **Shape:** *Change shape* → **Ampere** → `VM.Standard.A1.Flex` → set **4 OCPUs** and
   **24 GB memory** (the whole Always-Free Arm allowance in one box). If you picked Gemini for
   the LLM you can go smaller — 2 OCPU / 12 GB is fine.
4. **Networking:** let it create a VCN + subnet. Assign a **public IPv4** (you need it for
   SSH even if you'll use Tailscale afterwards).
5. **SSH keys:** upload your public key (`~/.ssh/id_ed25519.pub` — or *Generate a key pair*
   and download both).
6. **Boot volume:** 100 GB is plenty (models are ~5 GB, clips get wiped).
7. Create. Note the **public IP**.

## Step 2 — First SSH + get the code on the box

```bash
ssh ubuntu@<public-ip>

# on the VM:
sudo apt-get update -qq && sudo apt-get install -y -qq git
git clone <your-repo-url> ~/clipping        # or: scp -r ~/Desktop/clipping ubuntu@<ip>:~/clipping
cd ~/clipping
```

> No repo yet? From your Mac: `cd ~/Desktop/clipping && rsync -av --exclude node_modules --exclude data --exclude .next --exclude python/.venv ./ ubuntu@<ip>:~/clipping/`

## Step 3 — Configure `.env` before provisioning

```bash
cp .env.example .env
nano .env
```

Set at least:

```ini
YT_API_KEY=AIza...            # your existing YouTube Data API key

# --- pick your LLM ---
# A) Gemini free tier (recommended):
LLM_PROVIDER=openai
LLM_BASE_URL=https://generativelanguage.googleapis.com/v1beta/openai
LLM_MODEL=gemini-2.5-flash
LLM_API_KEY=AIza...           # from aistudio.google.com/apikey (a different key is fine)
# B) or leave LLM_PROVIDER=ollama to run llama3.1:8b locally on the VM

WHISPER_MODEL=large-v3-turbo  # CPU-friendly
```

## Step 4 — Provision

```bash
bash scripts/cloud-setup.sh
```

This installs ffmpeg, Node 20, `uv`, yt-dlp, the Python ML stack (Whisper / Demucs /
InsightFace / CLIP), Ollama *only if* `LLM_PROVIDER=ollama`, downloads all the models
(~3–5 GB, one time), builds the dashboard, and installs two **systemd services** that start
on boot and auto-restart. It also adds a 6 GB swapfile and opens the dashboard port on the
instance firewall.

First run takes 15–40 min (model downloads). Re-running is fast.

## Step 5 — Check + start

```bash
npm run doctor        # everything green?
sudo systemctl start clipper-worker clipper-web
systemctl status clipper-worker clipper-web
```

## Step 6 — Reach it from your Mac

### Tailscale (recommended)

```bash
# on the VM:
curl -fsSL https://tailscale.com/install.sh | sh
sudo tailscale up            # opens a login URL — approve it in your browser

# on your Mac: install Tailscale (brew install --cask tailscale) and sign in to the same account
```

Then open **`http://<vm-name>:3100`** in your Mac browser (the VM name shows in `tailscale
status`, e.g. `http://clipper:3100`). No ports exposed to the internet.

If `next` still refuses the origin, add the tailnet name to `.env`:
`DEV_ORIGINS=clipper,clipper.<tailnet>.ts.net` — but the built server (what systemd runs)
doesn't need this.

### SSH tunnel (nothing to install)

```bash
# on your Mac, leave this running:
ssh -N -L 3100:localhost:3100 ubuntu@<public-ip>
```

Open **`http://localhost:3100`** on your Mac.

### Public IP (least private)

1. OCI Console → your instance's **VCN → Security Lists → Default** → *Add Ingress Rule*:
   Source `0.0.0.0/0`, IP Protocol TCP, Destination port **3100**.
2. `cloud-setup.sh` already opened it on the instance firewall.
3. Open **`http://<public-ip>:3100`**. Anyone who finds the IP can see it — prefer Tailscale.

---

## Day to day

```bash
journalctl -u clipper-worker -f          # live worker log (the pipeline)
journalctl -u clipper-web -f             # dashboard log
sudo systemctl restart clipper-worker    # after changing .env
```

**Update to a new version:**

```bash
cd ~/clipping
git pull                                  # or rsync again from your Mac
npm install
npm run build --workspace web
sudo systemctl restart clipper-worker clipper-web
```

**Saved clips** live in `~/clipping/data/library/` on the VM. Pull them to your Mac:

```bash
rsync -av ubuntu@<ip>:~/clipping/data/library/ ~/Desktop/clips/
```

---

## Troubleshooting

**"Confirm you're not a bot" on every download.** YouTube blocks datacenter IPs hard. Fix:
export cookies from a logged-in browser on your Mac and upload them.

```bash
# Mac: install the "Get cookies.txt LOCALLY" browser extension, export youtube.com → cookies.txt
scp ~/Downloads/cookies.txt ubuntu@<ip>:~/clipping/secrets/cookies.txt
# VM .env:
YTDLP_COOKIES_FILE=/home/ubuntu/clipping/secrets/cookies.txt
sudo systemctl restart clipper-worker
```

Re-export every week or two (cookies expire). If it's still blocked, YouTube has flagged the
IP — reboot the instance to get a new ephemeral IP, or run the pipeline in bursts.

**A run takes forever.** With local Ollama on CPU each LLM call is 30–60 s and a run makes
several. Switch to Gemini (Step 3). Whisper/Demucs are also slower than on your Mac — that's
expected; `WHISPER_MODEL=large-v3-turbo` keeps it tolerable.

**`mediapipe` failed to install.** Fine — Arm wheels lag. The reframe step uses OpenCV YuNet
instead; `npm run doctor` will say `(mediapipe n/a)`.

**Demucs is very slow.** Stem separation on CPU is ~3–5× realtime for the 60 s probe. If it's
unbearable, you can accept it (it only runs once per candidate) or edit
`worker/src/pipeline/steps/filter.ts` to skip the music strip and only reject.

**Out of memory.** The swapfile covers spikes. If it still OOMs, don't run Top-5 (five passes
at once) and set `WHISPER_MODEL=medium`.

---

## Lighter alternative — stay on your Mac, just move the LLM

If the *only* pain is Ollama, you don't need the VM at all:

```ini
# ~/Desktop/clipping/.env  (on your Mac)
LLM_PROVIDER=openai
LLM_BASE_URL=https://generativelanguage.googleapis.com/v1beta/openai
LLM_MODEL=gemini-2.5-flash
LLM_API_KEY=...
```

`npm run dev` now skips local Ollama entirely and calls Gemini. Whisper/Demucs still run on
your Mac (they were never the Ollama problem), but your machine stops loading an 8B model.
