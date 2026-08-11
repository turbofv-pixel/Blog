# 대왕토끼 얼굴 모자이크 도구

사진/영상 속 얼굴을 토끼 스티커로 가리고, 영상은 기본으로 무음 처리하는 로컬 스크립트.
Claude한테 프레임 하나하나 봐달라고 시키는 대신 이걸로 한 번에 돌리면 된다.

## 준비 (최초 1회)

```bash
pip3 install -r automation/rabbit-mosaic/requirements.txt
```

`ffmpeg`도 필요하다 (영상 처리에 사용). 없으면:

```bash
# macOS
brew install ffmpeg
# Ubuntu/Debian
sudo apt install ffmpeg
```

## 사용법

```bash
# 파일 하나
python3 automation/rabbit-mosaic/mosaic.py ~/Downloads/IMG_1234.jpg

# 폴더째로 (하위 폴더까지 재귀적으로 사진+영상 전부 처리)
python3 automation/rabbit-mosaic/mosaic.py ~/Downloads/안산나들이/

# 결과를 다른 폴더에 모아서 저장 (기본은 입력 파일 옆에 -rabbit 접미사)
python3 automation/rabbit-mosaic/mosaic.py ~/Downloads/안산나들이/ --output public/images/ansan-2

# 이미 블로그에 있는 파일을 직접 덮어쓸 때
python3 automation/rabbit-mosaic/mosaic.py public/videos/some-clip.mp4 --in-place

# 영상 오디오를 지우지 않고 남기고 싶을 때 (기본은 무조건 무음)
python3 automation/rabbit-mosaic/mosaic.py clip.mp4 --keep-audio

# 전시판/포스터/화면 속 인물 사진까지 얼굴로 오인식할 때 (작은 얼굴 무시)
python3 automation/rabbit-mosaic/mosaic.py photo.jpg --min-face-frac 0.08
```

- 지원 형식: 사진 `.jpg/.jpeg/.png/.webp`, 영상 `.mp4/.mov/.m4v`
- 결과물: 사진은 원래 확장자 그대로, 영상은 항상 `.mp4`(h264 재인코딩) + 기본 무음
- 끝나면 파일별로 얼굴 인식 결과 요약이 찍힌다. 영상은 "전체 프레임 중 몇 %에서 얼굴을
  찾았는지"도 같이 보여주는데, 이 비율이 낮으면(대략 50% 미만) 결과를 직접 눈으로 한 번
  확인하는 걸 권장한다 — 화질이 아주 낮거나(블록 깨짐), 인물이 옆모습/역광/빠르게
  움직이는 장면에서는 자동 인식이 놓칠 수 있다.

## 알려진 한계

- **화질이 매우 낮은 영상**(예: 저비트레이트로 심하게 블록 깨진 영상)에서는 자동 얼굴
  인식이 잘 안 될 수 있다. 이런 경우 스크립트가 인식률을 경고로 알려주니, 결과를 직접
  확인하자.
- **사진 속 사진**(전시관 안내판, 벽에 걸린 인물 사진, 화면에 나온 얼굴 등)도 얼굴로
  인식될 수 있다. `--min-face-frac` 옵션으로 일정 크기 미만 얼굴을 무시하게 할 수 있다
  (단, 값을 너무 높이면 진짜 작게 나온 사람 얼굴도 같이 걸러질 수 있으니 결과를 확인하고
  조절하자).
- 빠르게 움직이는 영상에서는 스티커가 한두 프레임 살짝 어긋날 수 있다 (`SMOOTHING_ALPHA`,
  `MAX_MISSED_FRAMES` 값을 `mosaic.py` 상단에서 조절 가능).

## 구성 파일

- `mosaic.py` — 메인 스크립트
- `bunny.png` — 토끼 스티커 이미지 (투명 배경 PNG)
- `models/face_detection_yunet_2023mar.onnx` — OpenCV YuNet 얼굴 인식 모델 (약 230KB,
  저장소에 같이 커밋돼 있어서 인터넷 연결 없이도 동작)
