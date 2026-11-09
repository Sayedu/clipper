"""Visual content screening: faces + gender (InsightFace) and configurable
zero-shot concept detection (CLIP / open_clip).

Usage:
  python screen.py --out verdict.json --concepts "a woman" "alcohol" \
      ( --images a.jpg b.jpg ... | --video src.mp4 --sample-fps 0.3 --max-frames 20 )

Result (ScreenVerdict):
  {
    "frames": [{"image": "a.jpg", "faces": [{"box":[x,y,w,h],"gender":"female",
                "genderConf":0.9,"areaFrac":0.07}], "concepts": {"a woman": 0.31}}],
    "women":  [{"image":"a.jpg","box":[...],"conf":0.9,"mainSubject":true}],
    "conceptHits": [{"concept":"alcohol","image":"b.jpg","score":0.44}]
  }
"""

from __future__ import annotations

import argparse
import os

from common import emit_result, log, main, progress, quiet_stdout

# Each concept scored as a binary CLIP zero-shot:
#   softmax(T * [ sim(img, "a photo showing <C>"), sim(img, "...that does not show <C>") ])[0]
# T=100 (raw CLIP scale) turns a 0.02 cosine gap into ~0.9 — far too trigger-happy on
# ambiguous frames. A gentler T keeps the ranking but only lets genuinely strong matches
# approach 1.0. Downstream treats a hit as "pause for review", never an auto-reject.
CONCEPT_SOFTMAX_TEMP = 30.0
CONCEPT_THRESHOLD = 0.6
MAIN_SUBJECT_AREA = 0.05


def _load_frames(args):
    import cv2

    if args.images:
        for p in args.images:
            img = cv2.imread(p)
            if img is not None:
                yield os.path.basename(p), img
        return

    cap = cv2.VideoCapture(args.video)
    if not cap.isOpened():
        raise RuntimeError(f"cannot open {args.video}")
    fps = cap.get(cv2.CAP_PROP_FPS) or 30.0
    total = int(cap.get(cv2.CAP_PROP_FRAME_COUNT)) or 1
    dur = total / fps

    # Optional windows — screen only the chosen clip(s), not the whole source video.
    # --windows "start:end" may repeat (one per candidate clip); they can be far apart.
    windows: list[tuple[float, float]] = []
    for w in (args.windows or []):
        a, _, b = w.partition(":")
        try:
            windows.append((float(a), float(b)))
        except ValueError:
            pass
    windows = [(max(0.0, a), min(dur, b)) for a, b in windows if b > a]
    if not windows:
        windows = [(0.0, dur)]

    total_span = sum(b - a for a, b in windows) or dur
    n_total = min(args.max_frames, max(2, int(total_span * args.sample_fps)))
    for a, b in windows:
        n = max(1, round(n_total * (b - a) / total_span))
        for i in range(n):
            t = a + (b - a) * (i + 0.5) / n
            cap.set(cv2.CAP_PROP_POS_MSEC, t * 1000.0)
            ok, frame = cap.read()
            if ok and frame is not None:
                yield f"t{t:06.1f}.jpg", frame
    cap.release()


def screen() -> None:
    ap = argparse.ArgumentParser()
    ap.add_argument("--out")
    ap.add_argument("--concepts", nargs="*", default=[])
    ap.add_argument("--images", nargs="*")
    ap.add_argument("--video")
    ap.add_argument("--sample-fps", type=float, default=0.3)
    ap.add_argument("--max-frames", type=int, default=20)
    ap.add_argument("--windows", nargs="*", default=[],
                    help='"start:end" seconds, repeatable — screen only these slices (the chosen clips)')
    ap.add_argument("--save-frames-dir", help="write the sampled jpgs here (for the review UI)")
    args = ap.parse_args()

    # InsightFace / onnxruntime / open_clip print load chatter to stdout — keep it
    # off the JSON result channel the Node worker reads.
    with quiet_stdout():
        _screen_inner(args)


def _screen_inner(args) -> None:
    import cv2
    import numpy as np

    progress(0.05, "loading models")
    from insightface.app import FaceAnalysis

    face_app = FaceAnalysis(name="buffalo_l", providers=["CPUExecutionProvider"],
                            allowed_modules=["detection", "genderage"])
    face_app.prepare(ctx_id=-1, det_size=(640, 640))

    clip_model = clip_pre = text_feat = None
    concepts = [c for c in args.concepts if c.strip()]
    if concepts:
        import torch
        import open_clip

        clip_model, _, clip_pre = open_clip.create_model_and_transforms(
            "ViT-B-32", pretrained="laion2b_s34b_b79k"
        )
        clip_model.eval()
        clip_tok = open_clip.get_tokenizer("ViT-B-32")
        # two prompts per concept: positive then negative
        prompts = []
        for c in concepts:
            prompts += [f"a photo showing {c}", f"a photo that does not show {c}"]
        with torch.no_grad():
            tf = clip_model.encode_text(clip_tok(prompts))
            text_feat = tf / tf.norm(dim=-1, keepdim=True)

    frames_out, women, concept_hits = [], [], []
    frames = list(_load_frames(args))
    if args.save_frames_dir:
        os.makedirs(args.save_frames_dir, exist_ok=True)

    for idx, (name, bgr) in enumerate(frames):
        progress(0.1 + 0.85 * idx / max(len(frames), 1), f"frame {idx + 1}/{len(frames)}")
        h, w = bgr.shape[:2]
        frame_area = float(w * h)

        faces = []
        for f in face_app.get(bgr):
            x1, y1, x2, y2 = [float(v) for v in f.bbox]
            bw, bh = max(0.0, x2 - x1), max(0.0, y2 - y1)
            area_frac = (bw * bh) / frame_area if frame_area else 0.0
            sex = "female" if getattr(f, "sex", "M") == "F" else "male"
            conf = float(getattr(f, "det_score", 0.6))
            faces.append({"box": [x1, y1, bw, bh], "gender": sex, "genderConf": round(conf, 3),
                          "areaFrac": round(area_frac, 4)})
            # skip specks (game HUD avatars, leaderboard thumbnails) — gender on a
            # <0.8%-of-frame face is a coin toss and it's never a "main subject" anyway
            if sex == "female" and area_frac >= 0.008:
                women.append({"image": name, "box": [x1, y1, bw, bh], "conf": round(conf, 3),
                              "areaFrac": round(area_frac, 4),
                              "mainSubject": area_frac >= MAIN_SUBJECT_AREA})

        concept_scores = {}
        if concepts and clip_model is not None:
            import torch
            from PIL import Image

            rgb = cv2.cvtColor(bgr, cv2.COLOR_BGR2RGB)
            tensor = clip_pre(Image.fromarray(rgb)).unsqueeze(0)
            with torch.no_grad():
                im = clip_model.encode_image(tensor)
                im = im / im.norm(dim=-1, keepdim=True)
                sims = (im @ text_feat.T)[0]  # 2 per concept
            for i, c in enumerate(concepts):
                pos, neg = sims[2 * i], sims[2 * i + 1]
                p = float(torch.softmax(torch.stack([pos, neg]) * CONCEPT_SOFTMAX_TEMP, dim=0)[0])
                concept_scores[c] = round(p, 3)
                if p >= CONCEPT_THRESHOLD:
                    concept_hits.append({"concept": c, "image": name, "score": round(p, 3)})

        if args.save_frames_dir and (faces or any(v >= CONCEPT_THRESHOLD for v in concept_scores.values())):
            cv2.imwrite(os.path.join(args.save_frames_dir, name), bgr)

        frames_out.append({"image": name, "faces": faces, "concepts": concept_scores})

    log(f"{len(frames)} frames · {len(women)} female face(s) · {len(concept_hits)} concept hit(s)")
    progress(1.0, "done")
    emit_result({"frames": frames_out, "women": women, "conceptHits": concept_hits}, args.out)


if __name__ == "__main__":
    main(screen)
