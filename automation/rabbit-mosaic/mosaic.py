#!/usr/bin/env python3
"""대왕토끼 얼굴 모자이크 도구 — 사진/영상 속 얼굴을 토끼 스티커로 가리고,
영상은 기본으로 무음 처리한다.

왜 이 스크립트가 있는가: 육아 블로그에 올릴 사진/영상마다 Claude한테 얼굴을 한 프레임씩
찾아 가려달라고 시키면 토큰을 엄청나게 먹는다. 이 작업은 사실 얼굴 인식 + 스티커 합성일
뿐이라 로컬에서 OpenCV로 훨씬 빠르고 싸게 처리할 수 있다. 이 스크립트를 한 번 돌리면
끝난다.

준비물 (최초 1회):
    pip3 install -r automation/rabbit-mosaic/requirements.txt

사용법:
    # 파일 하나
    python3 automation/rabbit-mosaic/mosaic.py ~/Downloads/IMG_1234.jpg

    # 폴더째로 (하위 폴더까지 재귀적으로 사진+영상 전부 처리)
    python3 automation/rabbit-mosaic/mosaic.py ~/Downloads/안산나들이/

    # 결과를 다른 폴더에 모아서 저장 (기본은 입력 파일 옆에 -rabbit 접미사)
    python3 automation/rabbit-mosaic/mosaic.py ~/Downloads/안산나들이/ --output public/images/ansan-2

    # 이미 있는 파일을 덮어써도 될 때 (원본을 직접 mute+모자이크)
    python3 automation/rabbit-mosaic/mosaic.py public/videos/some-clip.mp4 --in-place

    # 영상 오디오를 남기고 싶을 때 (기본은 무조건 무음)
    python3 automation/rabbit-mosaic/mosaic.py clip.mp4 --keep-audio

지원 형식: 사진 .jpg/.jpeg/.png/.webp, 영상 .mp4/.mov/.m4v
결과: 사진은 원래 확장자 그대로, 영상은 항상 .mp4 (h264 재인코딩) + 기본 무음.

주의: 화질이 아주 낮거나(블록 깨짐) 얼굴이 옆모습/역광이면 자동 인식이 놓칠 수 있다.
스크립트가 끝나면 얼굴을 못 찾은 프레임 비율을 요약해서 보여주니, 비율이 높으면 결과
영상을 직접 눈으로 한 번 확인하는 걸 권장한다.
"""

import argparse
import shutil
import subprocess
import sys
from pathlib import Path

import cv2
import numpy as np

HERE = Path(__file__).resolve().parent
BUNNY_PATH = HERE / "bunny.png"
MODEL_PATH = HERE / "models" / "face_detection_yunet_2023mar.onnx"

IMAGE_EXTS = {".jpg", ".jpeg", ".png", ".webp"}
VIDEO_EXTS = {".mp4", ".mov", ".m4v"}

# 얼굴 박스보다 얼마나 크게 스티커를 씌울지 (귀 포함해서 얼굴을 확실히 덮도록 넉넉하게)
FACE_MARGIN = 1.9
# 영상에서 프레임 사이 위치를 얼마나 부드럽게 따라갈지 (0=고정, 1=매 프레임 그대로)
SMOOTHING_ALPHA = 0.45
# 얼굴을 못 찾은 프레임에서 직전 위치를 몇 프레임까지 유지할지
MAX_MISSED_FRAMES = 6


def load_bunny():
    bunny = cv2.imread(str(BUNNY_PATH), cv2.IMREAD_UNCHANGED)
    if bunny is None:
        sys.exit(f"토끼 스티커 이미지를 못 찾았습니다: {BUNNY_PATH}")
    return bunny


def make_detector(input_size=(320, 320)):
    if not MODEL_PATH.exists():
        sys.exit(f"얼굴 인식 모델을 못 찾았습니다: {MODEL_PATH}")
    return cv2.FaceDetectorYN.create(str(MODEL_PATH), "", input_size, score_threshold=0.6)


def detect_faces(detector, frame, min_face_frac=0.0):
    """반환: [(cx, cy, r), ...] — 감지된 얼굴들의 중심좌표와 반경(짧은 변 기준).

    min_face_frac: 프레임 너비 대비 얼굴 반지름*2 가 이 비율보다 작으면 무시한다.
    전시관 안내판/스크린 속 인물 사진처럼 '사진 속 사진'을 걸러낼 때 쓴다."""
    h, w = frame.shape[:2]
    detector.setInputSize((w, h))
    _, faces = detector.detect(frame)
    if faces is None:
        return []
    out = []
    for f in faces:
        x, y, fw, fh = f[:4]
        r = max(fw, fh) / 2
        if min_face_frac > 0 and (r * 2 / w) < min_face_frac:
            continue
        cx, cy = x + fw / 2, y + fh / 2
        out.append((float(cx), float(cy), float(r)))
    return out


def overlay_bunny(frame, bunny_rgba, cx, cy, r):
    h, w = frame.shape[:2]
    diam = int(r * 2 * FACE_MARGIN)
    if diam < 8:
        return
    sprite = cv2.resize(bunny_rgba, (diam, diam), interpolation=cv2.INTER_AREA)
    # 스프라이트는 귀가 위쪽에 있어서, 얼굴 원 중심이 cy에 오도록 위로 살짝 올려서 배치
    bx0 = int(cx - diam / 2)
    by0 = int(cy - diam * 0.56)
    bx1, by1 = bx0 + diam, by0 + diam

    sx0, sy0 = max(0, -bx0), max(0, -by0)
    fx0, fy0 = max(0, bx0), max(0, by0)
    fx1, fy1 = min(w, bx1), min(h, by1)
    if fx1 <= fx0 or fy1 <= fy0:
        return
    sx1, sy1 = sx0 + (fx1 - fx0), sy0 + (fy1 - fy0)

    roi = frame[fy0:fy1, fx0:fx1]
    patch = sprite[sy0:sy1, sx0:sx1]
    alpha = patch[:, :, 3:4].astype(np.float32) / 255.0
    roi[:] = (roi.astype(np.float32) * (1 - alpha) + patch[:, :, :3].astype(np.float32) * alpha).astype(np.uint8)


class Track:
    __slots__ = ("cx", "cy", "r", "missed")

    def __init__(self, cx, cy, r):
        self.cx, self.cy, self.r = cx, cy, r
        self.missed = 0

    def dist_to(self, cx, cy):
        return ((self.cx - cx) ** 2 + (self.cy - cy) ** 2) ** 0.5

    def update(self, cx, cy, r):
        a = SMOOTHING_ALPHA
        self.cx = self.cx * (1 - a) + cx * a
        self.cy = self.cy * (1 - a) + cy * a
        self.r = self.r * (1 - a) + r * a
        self.missed = 0


def process_image(path: Path, out_path: Path, detector, bunny, min_face_frac=0.0):
    img = cv2.imread(str(path))
    if img is None:
        print(f"  ⚠️  이미지를 열 수 없음: {path}")
        return False
    faces = detect_faces(detector, img, min_face_frac)
    for cx, cy, r in faces:
        overlay_bunny(img, bunny, cx, cy, r)
    out_path.parent.mkdir(parents=True, exist_ok=True)
    cv2.imwrite(str(out_path), img)
    print(f"  ✅ {path.name} → 얼굴 {len(faces)}개 처리 → {out_path}")
    return True


def process_video(path: Path, out_path: Path, detector, bunny, mute: bool, min_face_frac=0.0):
    cap = cv2.VideoCapture(str(path))
    if not cap.isOpened():
        print(f"  ⚠️  영상을 열 수 없음: {path}")
        return False
    fps = cap.get(cv2.CAP_PROP_FPS) or 30
    w = int(cap.get(cv2.CAP_PROP_FRAME_WIDTH))
    h = int(cap.get(cv2.CAP_PROP_FRAME_HEIGHT))
    total = int(cap.get(cv2.CAP_PROP_FRAME_COUNT))

    out_path.parent.mkdir(parents=True, exist_ok=True)
    tmp_video = out_path.with_suffix(".noaudio.mp4")
    writer = cv2.VideoWriter(str(tmp_video), cv2.VideoWriter_fourcc(*"mp4v"), fps, (w, h))

    tracks: list[Track] = []
    frames_done = 0
    frames_with_face = 0

    while True:
        ok, frame = cap.read()
        if not ok:
            break
        dets = detect_faces(detector, frame, min_face_frac)
        used = set()
        for t in tracks:
            best_i, best_d = -1, w * 0.12  # 매칭 허용 거리(프레임 폭의 12%)
            for i, (cx, cy, r) in enumerate(dets):
                if i in used:
                    continue
                d = t.dist_to(cx, cy)
                if d < best_d:
                    best_d, best_i = d, i
            if best_i >= 0:
                t.update(*dets[best_i])
                used.add(best_i)
            else:
                t.missed += 1
        for i, (cx, cy, r) in enumerate(dets):
            if i not in used:
                tracks.append(Track(cx, cy, r))
        tracks = [t for t in tracks if t.missed <= MAX_MISSED_FRAMES]

        if dets:
            frames_with_face += 1
        for t in tracks:
            overlay_bunny(frame, bunny, t.cx, t.cy, t.r)

        writer.write(frame)
        frames_done += 1
        if frames_done % 60 == 0:
            print(f"    … {frames_done}/{total} 프레임", end="\r")

    cap.release()
    writer.release()
    print(" " * 40, end="\r")

    cmd = ["ffmpeg", "-y", "-i", str(tmp_video)]
    if not mute:
        cmd += ["-i", str(path), "-map", "0:v:0", "-map", "1:a:0?", "-c:a", "aac", "-b:a", "128k"]
    else:
        cmd += ["-an"]
    cmd += ["-map", "0:v:0" if mute else "0:v:0", "-c:v", "libx264", "-preset", "medium", "-crf", "20",
            "-shortest", str(out_path)]
    # (mute일 때 -map 중복 지정돼도 ffmpeg는 마지막 값을 쓰므로 문제 없음)
    result = subprocess.run(cmd, capture_output=True, text=True)
    tmp_video.unlink(missing_ok=True)
    if result.returncode != 0:
        print(f"  ⚠️  ffmpeg 인코딩 실패: {path}\n{result.stderr[-800:]}")
        return False

    ratio = frames_with_face / frames_done if frames_done else 0
    flag = "✅" if ratio > 0.8 else "⚠️ "
    print(f"  {flag} {path.name} → {frames_done}프레임 중 {frames_with_face}프레임 얼굴 인식"
          f" ({ratio*100:.0f}%) {'· 무음' if mute else ''} → {out_path}")
    if ratio < 0.5:
        print(f"      → 인식률이 낮습니다. 결과 영상을 직접 확인해 얼굴이 잘 가려졌는지 점검하세요.")
    return True


def collect_inputs(paths):
    files = []
    for p in paths:
        p = Path(p)
        if p.is_dir():
            for f in sorted(p.rglob("*")):
                if f.suffix.lower() in IMAGE_EXTS | VIDEO_EXTS:
                    files.append(f)
        elif p.is_file():
            files.append(p)
        else:
            print(f"⚠️  경로를 찾을 수 없음: {p}")
    return files


def main():
    ap = argparse.ArgumentParser(description="사진/영상 얼굴을 토끼 스티커로 모자이크하고 영상은 기본 무음 처리")
    ap.add_argument("inputs", nargs="+", help="파일 또는 폴더 (폴더면 하위까지 재귀 처리)")
    ap.add_argument("--output", help="결과를 저장할 폴더 (기본: 입력 파일 옆에 <이름>-rabbit.<확장자>)")
    ap.add_argument("--in-place", action="store_true", help="원본 파일을 직접 덮어쓴다")
    ap.add_argument("--keep-audio", action="store_true", help="영상 오디오를 지우지 않고 남긴다 (기본은 무음)")
    ap.add_argument("--min-face-frac", type=float, default=0.0,
                     help="프레임 너비 대비 이 비율보다 작은 얼굴은 무시 (전시판/포스터 속 인물사진 오탐 거를 때, 예: 0.08)")
    args = ap.parse_args()

    if args.in_place and args.output:
        sys.exit("--in-place 와 --output 은 같이 쓸 수 없습니다.")

    files = collect_inputs(args.inputs)
    if not files:
        sys.exit("처리할 사진/영상을 찾지 못했습니다.")

    print(f"모델 로딩 중… ({len(files)}개 파일)")
    detector = make_detector()
    bunny = load_bunny()

    ok_count = 0
    for f in files:
        ext = f.suffix.lower()
        if args.in_place:
            out_path = f
            src_for_read = f  # 그대로 덮어쓰되, 비디오는 임시 파일 경유라 안전
        elif args.output:
            out_dir = Path(args.output)
            out_path = out_dir / f.name
        else:
            out_path = f.with_name(f"{f.stem}-rabbit{f.suffix}")

        if ext in IMAGE_EXTS:
            if process_image(f, out_path, detector, bunny, args.min_face_frac):
                ok_count += 1
        elif ext in VIDEO_EXTS:
            # in-place로 영상을 덮어쓸 땐 out_path==f 이지만 process_video는 원본을
            # 오디오 소스로도 참조하므로, 임시 이름으로 만들고 나서 교체한다.
            real_out = out_path
            if args.in_place:
                real_out = f.with_name(f".{f.stem}.tmp{f.suffix}")
            if process_video(f, real_out, detector, bunny, mute=not args.keep_audio,
                              min_face_frac=args.min_face_frac):
                ok_count += 1
                if args.in_place:
                    shutil.move(str(real_out), str(out_path))
        else:
            continue

    print(f"\n완료: {ok_count}/{len(files)}개 처리됨")


if __name__ == "__main__":
    main()
