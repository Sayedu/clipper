"""Plan a subject-tracked 9:16 crop path for a segment of a video.

Usage:
  python reframe.py --video SRC.mp4 --start 12.0 --end 55.0 --out crop.json
      [--target-w 1080 --target-h 1920 --sample-fps 6 --model yunet.onnx]

Result:
  {
    "sourceWidth": int, "sourceHeight": int,
    "cropWidth": int, "cropHeight": int,
    "method": "tracked" | "center-fallback",
    "keyframes": [{"t": sec_from_segment_start, "x": left_px, "y": top_px}, ...]
  }
"""

from __future__ import annotations

import argparse

import numpy as np

from common import emit_result, log, main, progress

# ---- letterbox vs crop -------------------------------------------------
PROMINENT_FACE_WIDTH = 0.11  # YuNet box at least this wide (frac of source width) = a real
#                              talking head, not a corner facecam (~210px on a 1920 source)
PROMINENT_MIN_FRAC = 0.50    # need a real talking head in half+ the frames to justify a crop;
#                              below this (gameplay w/ facecam, wide/action shots, screen-share,
#                              group scenes, dark footage) → letterbox so nothing is cut off.
#                              CLIP can't reliably tell modern game renders from real footage,
#                              so face size is the signal we trust.
WIDE_SPREAD_FRAC = 0.25      # above this share of frames with people spread wide → letterbox


def decide_letterbox(mode: str, prominent_frac: float, wide_frac: float) -> tuple[bool, str]:
    """Whether to letterbox (fit whole frame with bars) instead of cropping.

    `mode` is the user setting: 'always-crop' | 'always-letterbox' | 'auto'.
    In 'auto' we letterbox unless a single talking head is large and consistent
    enough that cropping to it keeps the point of the shot. Gameplay, screen
    recordings, wide/group/action shots and dark scenes all letterbox — better to
    see the whole frame than cut something off. Pure — unit-tested.
    """
    if mode == "always-letterbox":
        return True, "forced by settings"
    if mode == "always-crop":
        return False, ""
    if prominent_frac < PROMINENT_MIN_FRAC:
        return True, f"no single subject big enough to crop to in {1 - prominent_frac:.0%} of frames — keeping the whole frame"
    if wide_frac > WIDE_SPREAD_FRAC:
        return True, "multiple people spread across the frame"
    return False, ""


# ---- One-Euro filter -----------------------------------------------------
class OneEuro:
    def __init__(self, freq: float, min_cutoff=1.0, beta=0.0, d_cutoff=1.0):
        self.freq = freq
        self.min_cutoff = min_cutoff
        self.beta = beta
        self.d_cutoff = d_cutoff
        self.x_prev = None
        self.dx_prev = 0.0

    @staticmethod
    def _alpha(cutoff: float, freq: float) -> float:
        tau = 1.0 / (2 * np.pi * cutoff)
        te = 1.0 / freq
        return 1.0 / (1.0 + tau / te)

    def __call__(self, x: float) -> float:
        if self.x_prev is None:
            self.x_prev = x
            return x
        dx = (x - self.x_prev) * self.freq
        a_d = self._alpha(self.d_cutoff, self.freq)
        dx_hat = a_d * dx + (1 - a_d) * self.dx_prev
        cutoff = self.min_cutoff + self.beta * abs(dx_hat)
        a = self._alpha(cutoff, self.freq)
        x_hat = a * x + (1 - a) * self.x_prev
        self.x_prev = x_hat
        self.dx_prev = dx_hat
        return x_hat


def reframe() -> None:
    ap = argparse.ArgumentParser()
    ap.add_argument("--video", required=True)
    ap.add_argument("--start", type=float, required=True)
    ap.add_argument("--end", type=float, required=True)
    ap.add_argument("--out")
    ap.add_argument("--target-w", type=int, default=1080)
    ap.add_argument("--target-h", type=int, default=1920)
    ap.add_argument("--sample-fps", type=float, default=6.0)
    ap.add_argument("--model", default="")
    ap.add_argument("--mode", choices=["auto", "always-crop", "always-letterbox"], default="auto")
    args = ap.parse_args()

    import cv2

    cap = cv2.VideoCapture(args.video)
    if not cap.isOpened():
        raise RuntimeError(f"cannot open video: {args.video}")

    W = int(cap.get(cv2.CAP_PROP_FRAME_WIDTH))
    H = int(cap.get(cv2.CAP_PROP_FRAME_HEIGHT))
    src_fps = cap.get(cv2.CAP_PROP_FPS) or 30.0
    seg_dur = max(args.end - args.start, 0.1)

    target_ar = args.target_w / args.target_h
    src_ar = W / H
    if src_ar > target_ar:
        crop_h = H
        crop_w = int(round(H * target_ar))
    else:
        crop_w = W
        crop_h = int(round(W / target_ar))
    crop_w = min(crop_w, W)
    crop_h = min(crop_h, H)

    # A source that's already portrait (Shorts, phone clips) never needs letterboxing —
    # a centred fill crop just works. Skip all the subject/letterbox logic.
    already_vertical = src_ar <= target_ar * 1.02
    if already_vertical:
        log(f"source {W}x{H} is already ~vertical → centred fill crop {crop_w}x{crop_h}")
        progress(1.0, "vertical source")
        emit_result(
            {
                "sourceWidth": W, "sourceHeight": H,
                "cropWidth": crop_w, "cropHeight": crop_h,
                "method": "center-fallback",
                "keyframes": [],
            },
            args.out,
        )
        return

    log(f"source {W}x{H} @ {src_fps:.2f}fps · crop window {crop_w}x{crop_h} · segment {seg_dur:.1f}s")

    # ---- face detector ------------------------------------------------
    detector = None
    if args.model:
        try:
            detector = cv2.FaceDetectorYN.create(args.model, "", (W, H), 0.6, 0.3, 50)
            detector.setInputSize((W, H))
            log("using YuNet face detector")
        except Exception as exc:  # noqa: BLE001
            log(f"YuNet unavailable ({exc}); trying Haar cascade")
    if detector is None:
        try:
            haar_path = cv2.data.haarcascades + "haarcascade_frontalface_default.xml"
            cascade = cv2.CascadeClassifier(haar_path)
            if cascade.empty():
                raise RuntimeError("cascade file missing")

            def detect_haar(frame):
                gray = cv2.cvtColor(frame, cv2.COLOR_BGR2GRAY)
                found = cascade.detectMultiScale(gray, 1.1, 5, minSize=(int(H * 0.06), int(H * 0.06)))
                return [(float(x), float(y), float(w), float(h), 1.0) for (x, y, w, h) in found]

            detector = ("haar", detect_haar)
            log("using Haar cascade face detector")
        except Exception as exc:  # noqa: BLE001
            log(f"no face detector available ({exc}); static centre crop")

    # ---- sample frames & detect ------------------------------------
    n_samples = max(int(seg_dur * args.sample_fps), 2)
    times = np.linspace(0.0, seg_dur, n_samples)
    raw_cx: list[float | None] = []
    raw_cy: list[float | None] = []
    prev = None
    detections = 0
    prominent = 0        # frames whose main face is large enough to crop to
    wide_multi = 0       # frames with >=2 large faces spread across the frame
    prom_cx: list[float] = []  # x-centre of the prominent face, per frame it appeared

    for i, t in enumerate(times):
        cap.set(cv2.CAP_PROP_POS_MSEC, (args.start + t) * 1000.0)
        ok, frame = cap.read()
        if not ok or frame is None:
            raw_cx.append(prev[0] if prev else None)
            raw_cy.append(prev[1] if prev else None)
            continue

        boxes = []
        if detector is not None and not isinstance(detector, tuple):
            detector.setInputSize((frame.shape[1], frame.shape[0]))
            _, faces = detector.detect(frame)
            if faces is not None:
                boxes = [(f[0], f[1], f[2], f[3], f[14]) for f in faces]
        elif isinstance(detector, tuple):
            boxes = detector[1](frame)

        if boxes:
            # pick face nearest to previous centre, else largest & most central
            def key(b):
                bx, by, bw, bh, sc = b
                cx, cy = bx + bw / 2, by + bh / 2
                if prev is not None:
                    return -(((cx - prev[0]) ** 2 + (cy - prev[1]) ** 2) ** 0.5)
                central = 1.0 - abs(cx - W / 2) / (W / 2)
                return bw * bh * (0.5 + 0.5 * central)

            bx, by, bw, bh, _ = max(boxes, key=key)
            cx = bx + bw / 2
            cy = by + bh / 2 - 0.12 * crop_h  # headroom: keep face in upper third
            prev = (cx, cy)
            raw_cx.append(cx)
            raw_cy.append(cy)
            detections += 1

            # is the chosen face a real fraction of the frame (a talking head,
            # not a corner facecam) so a crop to it keeps the interesting content?
            if bw >= W * PROMINENT_FACE_WIDTH and bw <= crop_w * 0.9 and bh <= crop_h * 0.9:
                prominent += 1
                prom_cx.append(cx)
            # multiple sizeable faces spread wide -> can't crop without losing someone
            big = [b for b in boxes if b[2] * b[3] >= (bw * bh) * 0.4]
            if len(big) >= 2:
                xs_c = [b[0] + b[2] / 2 for b in big]
                if (max(xs_c) - min(xs_c)) > W * 0.55:
                    wide_multi += 1
        else:
            raw_cx.append(prev[0] if prev else None)
            raw_cy.append(prev[1] if prev else None)

        if i % 5 == 0:
            progress(0.1 + 0.75 * i / n_samples, f"{i}/{n_samples} frames")

    cap.release()

    # ---- crop vs letterbox decision ------------------------------
    prominent_frac = prominent / n_samples
    wide_frac = wide_multi / n_samples

    # A face that stays locked to one side and never comes near centre is a pinned
    # facecam over gameplay / a screen-share — cropping to it throws away the actual
    # content. Letterbox instead so the whole frame shows.
    facecam_locked = False
    if args.mode == "auto" and len(prom_cx) >= max(4, 0.5 * n_samples):
        near_centre = sum(1 for x in prom_cx if abs(x - W / 2) <= W * 0.12)
        same_side = all(x < W / 2 for x in prom_cx) or all(x > W / 2 for x in prom_cx)
        if same_side and near_centre / len(prom_cx) < 0.12:
            off = np.mean([abs(x - W / 2) for x in prom_cx]) / W
            log(f"prominent face is side-locked ({off:.0%} off-centre, never centred) → facecam over content")
            facecam_locked = True

    want_letterbox, reason = decide_letterbox(args.mode, prominent_frac, wide_frac)
    if facecam_locked and not want_letterbox:
        want_letterbox, reason = True, "a facecam pinned over gameplay / a screen — keeping the whole frame"

    if want_letterbox:
        fit_h = int(round(args.target_w * H / W))
        fit_h -= fit_h % 2
        bar = max(0, (args.target_h - fit_h) // 2)
        log(f"letterbox: {reason} — {args.target_w}x{fit_h} video, {bar}px bars")
        progress(1.0, "letterbox")
        emit_result(
            {
                "sourceWidth": W,
                "sourceHeight": H,
                "cropWidth": args.target_w,
                "cropHeight": args.target_h,
                "method": "letterbox",
                "keyframes": [],
                "fitHeight": fit_h,
                "barHeight": bar,
                "reason": reason,
            },
            args.out,
        )
        return

    method = "tracked" if detections >= max(3, n_samples * 0.15) else "center-fallback"
    log(f"{detections}/{n_samples} frames had a face · prominent {prominent_frac:.0%} → {method}")

    # ---- fill gaps -------------------------------------------------
    cx_arr = _fill(np.array([np.nan if v is None else v for v in raw_cx], dtype=float), W / 2)
    cy_arr = _fill(np.array([np.nan if v is None else v for v in raw_cy], dtype=float), H / 2 - 0.12 * crop_h)

    if method == "center-fallback":
        cx_arr[:] = W / 2
        cy_arr[:] = H / 2

    # ---- smooth (One-Euro) + velocity clamp ---------------------
    freq = args.sample_fps
    fx = OneEuro(freq, min_cutoff=0.7, beta=0.10)
    fy = OneEuro(freq, min_cutoff=0.5, beta=0.05)
    sm_cx = np.array([fx(v) for v in cx_arr])
    sm_cy = np.array([fy(v) for v in cy_arr])

    max_pan = 0.55 * crop_w / freq   # px per sample
    max_tilt = 0.30 * crop_h / freq
    for i in range(1, len(sm_cx)):
        sm_cx[i] = np.clip(sm_cx[i], sm_cx[i - 1] - max_pan, sm_cx[i - 1] + max_pan)
        sm_cy[i] = np.clip(sm_cy[i], sm_cy[i - 1] - max_tilt, sm_cy[i - 1] + max_tilt)

    # ---- centre -> top-left, clamp to frame --------------------
    xs = np.clip(sm_cx - crop_w / 2, 0, max(W - crop_w, 0))
    ys = np.clip(sm_cy - crop_h / 2, 0, max(H - crop_h, 0))

    # ---- thin keyframes (drop near-duplicates) -----------------
    keyframes = [{"t": 0.0, "x": float(round(xs[0], 1)), "y": float(round(ys[0], 1))}]
    for i in range(1, len(times)):
        if abs(xs[i] - keyframes[-1]["x"]) > 1.0 or abs(ys[i] - keyframes[-1]["y"]) > 1.0 or i == len(times) - 1:
            keyframes.append({"t": float(round(times[i], 3)), "x": float(round(xs[i], 1)), "y": float(round(ys[i], 1))})

    progress(1.0, f"{len(keyframes)} keyframes")
    emit_result(
        {
            "sourceWidth": W,
            "sourceHeight": H,
            "cropWidth": crop_w,
            "cropHeight": crop_h,
            "method": method,
            "keyframes": keyframes,
        },
        args.out,
    )


def _fill(arr: np.ndarray, default: float) -> np.ndarray:
    n = len(arr)
    if np.all(np.isnan(arr)):
        return np.full(n, default)
    idx = np.arange(n)
    good = ~np.isnan(arr)
    return np.interp(idx, idx[good], arr[good])


if __name__ == "__main__":
    main(reframe)
