import React, { useState, useRef, useEffect } from 'react';
import {
  Upload,
  Download,
  RefreshCw,
  CheckCircle2,
  Sparkles,
  AlertTriangle,
  Rabbit,
  Grid3x3,
  Hand,
  X,
  Undo2,
} from 'lucide-react';

declare global {
  interface Window {
    faceapi: any;
  }
}

type MosaicMode = 'rabbit' | 'pixelate';
type MediaKind = 'image' | 'video';

interface DetectedFace {
  id: string;
  x: number;
  y: number;
  width: number;
  height: number;
  source: 'auto' | 'manual';
}

interface ImageItem {
  id: string;
  file: File;
  objectUrl: string;
  img: HTMLImageElement | null;
  faces: DetectedFace[];
  history: DetectedFace[][]; // "얼굴 직접 추가"로 손댈 때마다 직전 상태를 쌓아두는 되돌리기 스택
  previewUrl: string | null;
  status: 'pending' | 'detecting' | 'done' | 'error';
}

const MAX_UNDO_HISTORY = 20;

interface VideoItem {
  id: string;
  file: File;
  objectUrl: string;
  status: 'pending' | 'processing' | 'done' | 'error';
  progress: number;
  resultUrl: string | null;
  resultExt: string;
  faceRatio: number | null;
}

// GitHub Pages 배포 시 base가 '/Blog/' 이므로, 정적 자산은 항상 BASE_URL을 기준으로 찾는다
// (마크다운 본문에 박힌 "/videos/..." 같은 루트 절대경로와는 별개 — 그건 로컬 파일 조회용 규약이라
// 그대로 두고, 여기 새로 추가하는 자산만 배포 경로에 맞게 정확히 참조한다).
const MODEL_URL = `${import.meta.env.BASE_URL}models`;
const BUNNY_URL = `${import.meta.env.BASE_URL}bunny.png`;
// 얼굴 박스보다 스티커를 얼마나 넉넉하게 씌울지 (귀 포함해서 확실히 덮도록)
const FACE_MARGIN = 1.9;
// 영상에서 이 간격(ms)마다 다시 얼굴을 인식하고, 그 사이 프레임은 마지막 위치를 따라간다
const VIDEO_DETECT_INTERVAL_MS = 220;
// 프레임 간 스티커 위치 스무딩 (0=고정, 1=매번 그대로 점프)
const SMOOTHING_ALPHA = 0.4;
// 사진 얼굴 인식 옵션. 영상(실시간, 초당 여러 번 재인식)보다 사진은 한 번만 돌리면 되니
// 더 큰 inputSize + 낮은 threshold로 작은/애매한 얼굴까지 최대한 잡아낸다.
const IMAGE_DETECT_OPTS = { inputSize: 512, scoreThreshold: 0.4 };
const VIDEO_DETECT_OPTS = { inputSize: 320, scoreThreshold: 0.45 };
const THUMB_MAX_DIM = 320;

let modelsLoadingPromise: Promise<void> | null = null;
function ensureModelsLoaded(): Promise<void> {
  if (!modelsLoadingPromise) {
    modelsLoadingPromise = (async () => {
      if (!window.faceapi) throw new Error('face-api 라이브러리를 불러오지 못했습니다.');
      await window.faceapi.nets.tinyFaceDetector.loadFromUri(MODEL_URL);
    })();
  }
  return modelsLoadingPromise;
}

function loadImageEl(src: string): Promise<HTMLImageElement> {
  return new Promise((resolve, reject) => {
    const img = new Image();
    img.crossOrigin = 'anonymous';
    img.onload = () => resolve(img);
    img.onerror = reject;
    img.src = src;
  });
}

const uid = () => Math.random().toString(36).slice(2) + Date.now().toString(36);

// 얼굴 인식이 멈춰버리는 경우(모바일 브라우저에서 큰 사진을 여러 장 연달아 돌리면 WebGL
// 컨텍스트가 맛이 가는지, 에러도 안 던지고 그냥 promise가 영영 안 끝나는 케이스가 있었음)를
// 대비해서, 한 장당 이 시간을 넘기면 "얼굴 0개"로 치고 다음 사진으로 넘어가게 강제한다.
// 이게 없으면 배치 처리 중 한 장에서 멈추는 순간 뒤에 남은 사진들이 전부 영원히 "대기중"으로
// 멈춰버린다.
const DETECT_TIMEOUT_MS = 15000;

function withTimeout<T>(promise: Promise<T>, ms: number, fallback: T): Promise<T> {
  return new Promise((resolve) => {
    let settled = false;
    const timer = setTimeout(() => {
      if (!settled) {
        settled = true;
        resolve(fallback);
      }
    }, ms);
    promise.then(
      (v) => {
        if (!settled) {
          settled = true;
          clearTimeout(timer);
          resolve(v);
        }
      },
      () => {
        if (!settled) {
          settled = true;
          clearTimeout(timer);
          resolve(fallback);
        }
      }
    );
  });
}

async function detectFacesIn(
  el: HTMLImageElement | HTMLVideoElement,
  opts: { inputSize: number; scoreThreshold: number }
): Promise<Omit<DetectedFace, 'id' | 'source'>[]> {
  const faceapi = window.faceapi;
  const options = new faceapi.TinyFaceDetectorOptions(opts);
  const detections = await faceapi.detectAllFaces(el, options);
  return detections.map((d: any) => ({ x: d.box.x, y: d.box.y, width: d.box.width, height: d.box.height }));
}

function drawPixelate(
  ctx: CanvasRenderingContext2D,
  source: CanvasImageSource,
  face: { x: number; y: number; width: number; height: number },
  pixelSize: number
) {
  const cx = face.x + face.width / 2;
  const cy = face.y + face.height / 2;
  const w = face.width * FACE_MARGIN;
  const h = face.height * FACE_MARGIN;
  const x0 = Math.max(0, Math.floor(cx - w / 2));
  const y0 = Math.max(0, Math.floor(cy - h / 2));

  ctx.save();
  ctx.beginPath();
  ctx.ellipse(cx, cy, w / 2, h / 2, 0, 0, Math.PI * 2);
  ctx.clip();

  const scaledW = Math.max(1, Math.floor(w / pixelSize));
  const scaledH = Math.max(1, Math.floor(h / pixelSize));
  const tmp = document.createElement('canvas');
  tmp.width = scaledW;
  tmp.height = scaledH;
  const tctx = tmp.getContext('2d');
  if (tctx) {
    tctx.imageSmoothingEnabled = false;
    tctx.drawImage(source, x0, y0, w, h, 0, 0, scaledW, scaledH);
    ctx.imageSmoothingEnabled = false;
    ctx.drawImage(tmp, 0, 0, scaledW, scaledH, x0, y0, w, h);
  }
  ctx.restore();
}

function drawRabbit(
  ctx: CanvasRenderingContext2D,
  bunny: HTMLImageElement,
  face: { x: number; y: number; width: number; height: number }
) {
  const cx = face.x + face.width / 2;
  const cy = face.y + face.height / 2;
  const r = Math.max(face.width, face.height) / 2;
  const diam = r * 2 * FACE_MARGIN;
  // 스프라이트는 귀가 위쪽에 있어서, 얼굴 원 중심이 cy에 오도록 위로 살짝 올려서 배치
  const dx = cx - diam / 2;
  const dy = cy - diam * 0.56;
  ctx.drawImage(bunny, dx, dy, diam, diam);
}

function renderFacesToCanvas(
  canvas: HTMLCanvasElement,
  img: HTMLImageElement,
  faces: DetectedFace[],
  mode: MosaicMode,
  pixelSize: number,
  bunny: HTMLImageElement | null
) {
  canvas.width = img.naturalWidth || img.width;
  canvas.height = img.naturalHeight || img.height;
  const ctx = canvas.getContext('2d');
  if (!ctx) return;
  ctx.drawImage(img, 0, 0, canvas.width, canvas.height);
  faces.forEach((face) => {
    if (mode === 'rabbit' && bunny) drawRabbit(ctx, bunny, face);
    else drawPixelate(ctx, img, face, pixelSize);
  });
}

function renderToDataUrl(
  img: HTMLImageElement,
  faces: DetectedFace[],
  mode: MosaicMode,
  pixelSize: number,
  bunny: HTMLImageElement | null,
  maxDim?: number
): string {
  const full = document.createElement('canvas');
  renderFacesToCanvas(full, img, faces, mode, pixelSize, bunny);
  if (!maxDim || (full.width <= maxDim && full.height <= maxDim)) {
    // PNG here was lossless - for a real camera photo (already JPEG-compressed, lots of fine
    // detail/noise) that's several times the original file size. JPEG at high quality keeps
    // it visually indistinguishable from the sticker/pixelate result while landing close to
    // what the original photo weighed.
    return full.toDataURL('image/jpeg', 0.92);
  }
  const scale = maxDim / Math.max(full.width, full.height);
  const thumb = document.createElement('canvas');
  thumb.width = Math.max(1, Math.round(full.width * scale));
  thumb.height = Math.max(1, Math.round(full.height * scale));
  const tctx = thumb.getContext('2d');
  if (tctx) tctx.drawImage(full, 0, 0, thumb.width, thumb.height);
  return thumb.toDataURL('image/jpeg', 0.82);
}

function downloadDataUrl(dataUrl: string, filename: string) {
  const link = document.createElement('a');
  link.download = filename;
  link.href = dataUrl;
  link.click();
}

export const MosaicStudio: React.FC = () => {
  const [mediaKind, setMediaKind] = useState<MediaKind | null>(null);
  const [mode, setMode] = useState<MosaicMode>('rabbit');
  const [pixelSize, setPixelSize] = useState<number>(14);
  const [isProcessing, setIsProcessing] = useState<boolean>(false);
  const [statusMessage, setStatusMessage] = useState<string>(
    '사진(여러 장 가능)이나 영상을 선택하면 자동으로 얼굴을 찾아 토끼로 가려드려요.'
  );
  const [modelReady, setModelReady] = useState<boolean>(false);
  const [modelError, setModelError] = useState<string | null>(null);

  // --- 사진(여러 장) 배치 상태 ---
  const [images, setImages] = useState<ImageItem[]>([]);
  const [activeImageIndex, setActiveImageIndex] = useState<number>(0);
  const [manualAddActive, setManualAddActive] = useState<boolean>(false);
  const [manualSizePct, setManualSizePct] = useState<number>(16); // 이미지 짧은 변 대비 %

  // --- 영상(여러 개 가능, 순서대로 하나씩 처리) 상태 ---
  const [videoItems, setVideoItems] = useState<VideoItem[]>([]);
  const [activeVideoIndex, setActiveVideoIndex] = useState<number>(0);

  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const videoElRef = useRef<HTMLVideoElement | null>(null);
  const bunnyRef = useRef<HTMLImageElement | null>(null);
  const fileInputRef = useRef<HTMLInputElement | null>(null);
  const cancelRef = useRef<boolean>(false);

  useEffect(() => {
    loadImageEl(BUNNY_URL).then((img) => {
      bunnyRef.current = img;
    });
    ensureModelsLoaded()
      .then(() => setModelReady(true))
      .catch((e) => setModelError(e.message || '얼굴 인식 모델 로딩 실패'));
  }, []);

  const activeImage = mediaKind === 'image' ? images[activeImageIndex] : undefined;
  const activeVideoItem = mediaKind === 'video' ? videoItems[activeVideoIndex] : undefined;

  // 활성 사진의 큰 캔버스를 얼굴/모드/픽셀크기 바뀔 때마다 다시 그린다. 아직 처리 전인 사진으로
  // 넘어갔을 때(img가 아직 없음) 캔버스를 비워서, 직전 사진이 그대로 남아있는 것처럼 보이는 걸
  // 막는다 — 배치 처리 중 순서를 앞질러 다른 사진을 눌렀을 때 헷갈리는 원인이었다.
  useEffect(() => {
    const canvas = canvasRef.current;
    if (mediaKind !== 'image' || !canvas) return;
    if (!activeImage?.img) {
      const ctx = canvas.getContext('2d');
      if (ctx) ctx.clearRect(0, 0, canvas.width, canvas.height);
      return;
    }
    renderFacesToCanvas(canvas, activeImage.img, activeImage.faces, mode, pixelSize, bunnyRef.current);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [mediaKind, activeImageIndex, activeImage?.faces, activeImage?.img, mode, pixelSize]);

  const handleFileChange = (e: React.ChangeEvent<HTMLInputElement>) => {
    const files = Array.from(e.target.files || []);
    if (files.length === 0) return;
    const videoFiles = files.filter((f) => f.type.startsWith('video/'));
    const imageFiles = files.filter((f) => f.type.startsWith('image/'));

    setManualAddActive(false);

    if (imageFiles.length > 0) {
      startImageBatch(imageFiles, videoFiles.length > 0);
    } else if (videoFiles.length > 0) {
      startVideoBatch(videoFiles);
    }
    // 같은 파일을 다시 선택해도 onChange가 또 뜨도록 입력값 초기화
    e.target.value = '';
  };

  const startVideoBatch = (files: File[]) => {
    setMediaKind('video');
    setImages([]);
    const items: VideoItem[] = files.map((f) => ({
      id: uid(),
      file: f,
      objectUrl: URL.createObjectURL(f),
      status: 'pending',
      progress: 0,
      resultUrl: null,
      resultExt: 'webm',
      faceRatio: null,
    }));
    setVideoItems(items);
    setActiveVideoIndex(0);
    setStatusMessage(
      items.length > 1
        ? `영상 ${items.length}개를 불러왔습니다. "전체 영상 모자이크 시작"을 누르면 순서대로 처리돼요.`
        : '영상을 불러왔습니다. 아래 "토끼 모자이크 시작" 버튼을 눌러주세요.'
    );
  };

  const startImageBatch = async (files: File[], skippedVideos: boolean) => {
    setMediaKind('image');
    setVideoItems([]);
    const items: ImageItem[] = files.map((f) => ({
      id: uid(),
      file: f,
      objectUrl: URL.createObjectURL(f),
      img: null,
      faces: [],
      history: [],
      previewUrl: null,
      status: 'pending',
    }));
    setImages(items);
    setActiveImageIndex(0);
    setIsProcessing(true);
    setStatusMessage(
      (skippedVideos ? '영상 파일은 이번엔 건너뛰었어요 (영상은 한 번에 하나씩만 처리돼요). ' : '') +
        `사진 ${items.length}장에서 얼굴을 찾는 중입니다...`
    );

    try {
      await ensureModelsLoaded();
    } catch {
      // modelError 상태가 이미 배너로 표시되므로 여기서는 조용히 계속 진행(얼굴 0개로 처리됨)
    }

    for (let i = 0; i < items.length; i++) {
      if (items.length > 1) {
        setStatusMessage(`사진 처리 중... (${i + 1}/${items.length})`);
      }
      // eslint-disable-next-line no-await-in-loop
      await processOneImage(items[i].id, items[i].objectUrl);
    }
    setIsProcessing(false);
    setStatusMessage(`✨ 사진 ${items.length}장 처리 완료! 자동으로 못 찾은 얼굴이 있으면 "얼굴 직접 추가"로 눌러서 채워주세요.`);
  };

  const processOneImage = async (id: string, objectUrl: string) => {
    setImages((prev) => prev.map((it) => (it.id === id ? { ...it, status: 'detecting' } : it)));
    try {
      const img = await loadImageEl(objectUrl);
      let rawFaces: Omit<DetectedFace, 'id' | 'source'>[] = [];
      try {
        rawFaces = await withTimeout(detectFacesIn(img, IMAGE_DETECT_OPTS), DETECT_TIMEOUT_MS, []);
      } catch {
        // 모델이 없으면 얼굴 0개로 남기고 계속 (사용자가 수동 추가 가능)
      }
      const faces: DetectedFace[] = rawFaces.map((f) => ({ ...f, id: uid(), source: 'auto' }));
      const previewUrl = renderToDataUrl(img, faces, mode, pixelSize, bunnyRef.current, THUMB_MAX_DIM);
      setImages((prev) => prev.map((it) => (it.id === id ? { ...it, img, faces, previewUrl, status: 'done' } : it)));
    } catch {
      setImages((prev) => prev.map((it) => (it.id === id ? { ...it, status: 'error' } : it)));
    }
  };

  // 모드/픽셀크기가 바뀌면 모든 사진의 썸네일도 다시 렌더링
  useEffect(() => {
    if (mediaKind !== 'image') return;
    setImages((prev) =>
      prev.map((it) =>
        it.img ? { ...it, previewUrl: renderToDataUrl(it.img, it.faces, mode, pixelSize, bunnyRef.current, THUMB_MAX_DIM) } : it
      )
    );
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [mode, pixelSize]);

  // 캔버스를 눌러서 얼굴 영역을 수동으로 추가/제거 (기존 마커를 다시 누르면 제거)
  const handleCanvasClick = (e: React.MouseEvent<HTMLCanvasElement>) => {
    if (!manualAddActive || mediaKind !== 'image') return;
    const canvas = canvasRef.current;
    if (!canvas || !activeImage?.img) return;
    const rect = canvas.getBoundingClientRect();
    const scaleX = canvas.width / rect.width;
    const scaleY = canvas.height / rect.height;
    const x = (e.clientX - rect.left) * scaleX;
    const y = (e.clientY - rect.top) * scaleY;
    const activeId = activeImage.id;
    const imgW = activeImage.img.naturalWidth || activeImage.img.width;
    const imgH = activeImage.img.naturalHeight || activeImage.img.height;

    setImages((prev) =>
      prev.map((it) => {
        if (it.id !== activeId || !it.img) return it;
        const hitIdx = it.faces.findIndex((f) => {
          const cx = f.x + f.width / 2;
          const cy = f.y + f.height / 2;
          const r = (Math.max(f.width, f.height) / 2) * FACE_MARGIN;
          return Math.hypot(cx - x, cy - y) <= r;
        });
        let faces: DetectedFace[];
        if (hitIdx >= 0) {
          faces = it.faces.filter((_, i) => i !== hitIdx);
        } else {
          const side = Math.min(imgW, imgH) * (manualSizePct / 100);
          faces = [...it.faces, { id: uid(), source: 'manual', x: x - side / 2, y: y - side / 2, width: side, height: side }];
        }
        const previewUrl = renderToDataUrl(it.img, faces, mode, pixelSize, bunnyRef.current, THUMB_MAX_DIM);
        // 클릭 직전 상태를 되돌리기 스택에 쌓는다 (최근 MAX_UNDO_HISTORY개만 유지)
        const history = [...it.history, it.faces].slice(-MAX_UNDO_HISTORY);
        return { ...it, faces, previewUrl, history };
      })
    );
  };

  // 방금 한 "얼굴 직접 추가/제거" 한 번을 되돌린다
  const handleUndoManualFace = () => {
    if (!activeImage?.img) return;
    const activeId = activeImage.id;
    setImages((prev) =>
      prev.map((it) => {
        if (it.id !== activeId || !it.img || it.history.length === 0) return it;
        const history = [...it.history];
        const faces = history.pop() as DetectedFace[];
        const previewUrl = renderToDataUrl(it.img, faces, mode, pixelSize, bunnyRef.current, THUMB_MAX_DIM);
        return { ...it, faces, previewUrl, history };
      })
    );
  };

  const pickSupportedMimeType = (): string => {
    const candidates = [
      'video/mp4;codecs=h264',
      'video/mp4',
      'video/webm;codecs=vp9',
      'video/webm;codecs=vp8',
      'video/webm',
    ];
    for (const c of candidates) {
      if (typeof MediaRecorder !== 'undefined' && MediaRecorder.isTypeSupported(c)) return c;
    }
    return '';
  };

  // 영상 큐를 순서대로 하나씩 처리한다 (동시에 여러 개를 녹화하면 캔버스/레코더를 공유할 수
  // 없으니 반드시 순차 처리 — 대신 다음 영상으로 자동으로 넘어가서 한 번의 "시작"으로 전부 끝남).
  const processVideoQueue = async () => {
    setIsProcessing(true);
    cancelRef.current = false;
    setStatusMessage('얼굴 인식 모델을 준비하는 중입니다...');

    try {
      await ensureModelsLoaded();
    } catch (err: any) {
      setStatusMessage(`❌ 모델 로딩 실패: ${err.message || err}`);
      setIsProcessing(false);
      return;
    }

    for (let i = 0; i < videoItems.length; i++) {
      if (cancelRef.current) break;
      const item = videoItems[i];
      if (item.status === 'done') continue;
      setActiveVideoIndex(i);
      setStatusMessage(
        videoItems.length > 1
          ? `영상 처리 중 (${i + 1}/${videoItems.length})... 영상 길이만큼 시간이 걸려요.`
          : '영상을 처리하는 중입니다... (영상 길이만큼 시간이 걸려요)'
      );
      // eslint-disable-next-line no-await-in-loop
      await processOneVideo(item.id, item.objectUrl);
    }

    setIsProcessing(false);
    setStatusMessage(
      cancelRef.current
        ? '처리를 중단했어요.'
        : videoItems.length > 1
          ? '✨ 영상 처리 완료! 개별 또는 전체 다운로드하세요.'
          : '✨ 처리 완료!'
    );
  };

  const processOneVideo = async (id: string, objectUrl: string) => {
    const video = videoElRef.current;
    const canvas = canvasRef.current;
    const bunny = bunnyRef.current;
    if (!video || !canvas) return;

    setVideoItems((prev) => prev.map((it) => (it.id === id ? { ...it, status: 'processing', progress: 0 } : it)));

    video.src = objectUrl;
    video.load();
    await new Promise<void>((resolve) => {
      video.onloadedmetadata = () => resolve();
    });

    canvas.width = video.videoWidth;
    canvas.height = video.videoHeight;
    const ctx = canvas.getContext('2d');
    if (!ctx) return;

    const mimeType = pickSupportedMimeType();
    if (!mimeType) {
      setVideoItems((prev) => prev.map((it) => (it.id === id ? { ...it, status: 'error' } : it)));
      setStatusMessage('❌ 이 브라우저는 영상 녹화(MediaRecorder)를 지원하지 않습니다.');
      return;
    }
    const ext = mimeType.includes('mp4') ? 'mp4' : 'webm';

    // 오디오 트랙을 아예 추가하지 않으므로 결과 영상은 자동으로 무음이다.
    const stream = (canvas as any).captureStream(30) as MediaStream;
    const chunks: Blob[] = [];
    const recorder = new MediaRecorder(stream, { mimeType });
    recorder.ondataavailable = (e) => {
      if (e.data.size > 0) chunks.push(e.data);
    };
    const stopped = new Promise<void>((resolve) => {
      recorder.onstop = () => resolve();
    });

    let lastDetectTime = -Infinity;
    let trackedFaces: { cx: number; cy: number; r: number }[] = [];
    let framesWithFace = 0;
    let framesTotal = 0;

    video.currentTime = 0;
    video.muted = true;
    recorder.start();
    await video.play();

    await new Promise<void>((resolve) => {
      const step = async () => {
        if (cancelRef.current || video.paused || video.ended) {
          resolve();
          return;
        }
        ctx.drawImage(video, 0, 0, canvas.width, canvas.height);

        const now = performance.now();
        if (now - lastDetectTime >= VIDEO_DETECT_INTERVAL_MS) {
          lastDetectTime = now;
          try {
            const faces = await detectFacesIn(video, VIDEO_DETECT_OPTS);
            const newCenters = faces.map((f) => ({
              cx: f.x + f.width / 2,
              cy: f.y + f.height / 2,
              r: (Math.max(f.width, f.height) / 2) * FACE_MARGIN,
            }));
            // 가장 가까운 기존 트랙에 매칭해서 부드럽게 이동시킨다
            const used = new Set<number>();
            trackedFaces.forEach((t) => {
              let bestI = -1;
              let bestD = canvas.width * 0.15;
              newCenters.forEach((n, i) => {
                if (used.has(i)) return;
                const d = Math.hypot(t.cx - n.cx, t.cy - n.cy);
                if (d < bestD) {
                  bestD = d;
                  bestI = i;
                }
              });
              if (bestI >= 0) {
                const n = newCenters[bestI];
                t.cx += (n.cx - t.cx) * SMOOTHING_ALPHA;
                t.cy += (n.cy - t.cy) * SMOOTHING_ALPHA;
                t.r += (n.r - t.r) * SMOOTHING_ALPHA;
                used.add(bestI);
              }
            });
            newCenters.forEach((n, i) => {
              if (!used.has(i)) trackedFaces.push({ ...n });
            });
            if (faces.length > 0) framesWithFace++;
          } catch {
            // 이번 인식 주기는 건너뛰고 이전 위치를 계속 사용
          }
        }
        framesTotal++;

        trackedFaces.forEach((t) => {
          if (mode === 'rabbit' && bunny) {
            const diam = t.r * 2;
            ctx.drawImage(bunny, t.cx - diam / 2, t.cy - diam * 0.56, diam, diam);
          } else {
            drawPixelate(ctx, video, { x: t.cx - t.r, y: t.cy - t.r, width: t.r * 2, height: t.r * 2 }, pixelSize);
          }
        });

        const progress = video.duration ? video.currentTime / video.duration : 0;
        setVideoItems((prev) => prev.map((it) => (it.id === id ? { ...it, progress } : it)));
        requestAnimationFrame(() => {
          step();
        });
      };
      step();
    });

    recorder.stop();
    video.pause();
    await stopped;

    const blob = new Blob(chunks, { type: mimeType });
    const url = URL.createObjectURL(blob);
    const ratio = framesTotal ? framesWithFace / framesTotal : 0;
    setVideoItems((prev) =>
      prev.map((it) =>
        it.id === id ? { ...it, status: 'done', resultUrl: url, resultExt: ext, faceRatio: ratio, progress: 1 } : it
      )
    );
  };

  const handleDownloadActiveImage = () => {
    if (!activeImage?.img) return;
    const dataUrl = renderToDataUrl(activeImage.img, activeImage.faces, mode, pixelSize, bunnyRef.current);
    downloadDataUrl(dataUrl, `rabbit_${activeImage.file.name.replace(/\.[^.]+$/, '')}.jpg`);
  };

  const handleDownloadAllImages = async () => {
    for (const item of images) {
      if (!item.img) continue;
      const dataUrl = renderToDataUrl(item.img, item.faces, mode, pixelSize, bunnyRef.current);
      downloadDataUrl(dataUrl, `rabbit_${item.file.name.replace(/\.[^.]+$/, '')}.jpg`);
      // 브라우저가 "여러 파일 다운로드 허용" 팝업을 안 띄우고 순서대로 받게 살짝 텀을 둔다
      await new Promise((r) => setTimeout(r, 350));
    }
  };

  const handleRemoveImage = (id: string) => {
    setImages((prev) => {
      const idx = prev.findIndex((it) => it.id === id);
      if (idx === -1) return prev;
      const removed = prev[idx];
      URL.revokeObjectURL(removed.objectUrl);
      const next = prev.filter((it) => it.id !== id);
      setActiveImageIndex((cur) => Math.max(0, Math.min(cur, next.length - 1)));
      return next;
    });
  };

  const handleDownloadVideo = (item: VideoItem) => {
    if (!item.resultUrl) return;
    const link = document.createElement('a');
    link.download = `rabbit_${item.file.name.replace(/\.[^.]+$/, '')}.${item.resultExt}`;
    link.href = item.resultUrl;
    link.click();
  };

  const handleDownloadAllVideos = async () => {
    for (const item of videoItems) {
      if (!item.resultUrl) continue;
      handleDownloadVideo(item);
      // 브라우저가 "여러 파일 다운로드 허용" 팝업을 안 띄우고 순서대로 받게 살짝 텀을 둔다
      // eslint-disable-next-line no-await-in-loop
      await new Promise((r) => setTimeout(r, 350));
    }
  };

  const handleRemoveVideoItem = (id: string) => {
    setVideoItems((prev) => {
      const idx = prev.findIndex((it) => it.id === id);
      if (idx === -1) return prev;
      const removed = prev[idx];
      URL.revokeObjectURL(removed.objectUrl);
      if (removed.resultUrl) URL.revokeObjectURL(removed.resultUrl);
      const next = prev.filter((it) => it.id !== id);
      setActiveVideoIndex((cur) => Math.max(0, Math.min(cur, next.length - 1)));
      return next;
    });
  };

  const handleReset = () => {
    images.forEach((it) => URL.revokeObjectURL(it.objectUrl));
    videoItems.forEach((it) => {
      URL.revokeObjectURL(it.objectUrl);
      if (it.resultUrl) URL.revokeObjectURL(it.resultUrl);
    });
    setImages([]);
    setActiveImageIndex(0);
    setManualAddActive(false);
    setVideoItems([]);
    setActiveVideoIndex(0);
    setMediaKind(null);
    cancelRef.current = true;
  };

  const hasMedia = mediaKind === 'image' ? images.length > 0 : videoItems.length > 0;

  return (
    <div className="glass-panel animate-fade-in" style={{ padding: '28px' }}>
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: '20px', flexWrap: 'wrap', gap: '12px' }}>
        <div>
          <h2 style={{ fontSize: '1.4rem', fontWeight: 700, display: 'flex', alignItems: 'center', gap: '10px' }}>
            <Sparkles color="#03C75A" size={24} />
            토끼 얼굴 모자이크 스튜디오
          </h2>
          <p style={{ color: 'var(--text-muted)', fontSize: '0.9rem', marginTop: '4px' }}>
            사진이나 영상(여러 개 한 번에 가능) 속 얼굴을 브라우저에서 바로 인식해 토끼 스티커로 가려드려요. 영상은
            자동으로 무음 처리됩니다. 모바일 브라우저에서도 그대로 사용할 수 있어요.
          </p>
        </div>
        {hasMedia && (
          <button onClick={handleReset} className="btn-secondary">
            <RefreshCw size={16} />
            다른 파일로 변경
          </button>
        )}
      </div>

      {modelError && (
        <div style={{ display: 'flex', alignItems: 'center', gap: '8px', color: '#f87171', background: 'rgba(248,113,113,0.08)', border: '1px solid rgba(248,113,113,0.25)', borderRadius: '10px', padding: '10px 14px', marginBottom: '16px', fontSize: '0.85rem' }}>
          <AlertTriangle size={16} />
          얼굴 인식 모델을 불러오지 못했습니다: {modelError} (새로고침 후 다시 시도하거나, "얼굴 직접 추가"로 수동
          처리해주세요)
        </div>
      )}

      {!hasMedia ? (
        <div
          style={{
            border: '2px dashed rgba(3, 199, 90, 0.4)',
            borderRadius: '20px',
            padding: '48px 20px',
            textAlign: 'center',
            background: 'rgba(3, 199, 90, 0.03)',
            cursor: 'pointer',
          }}
          onClick={() => fileInputRef.current?.click()}
        >
          <input
            ref={fileInputRef}
            type="file"
            accept="image/*,video/*"
            multiple
            onChange={handleFileChange}
            style={{ display: 'none' }}
          />
          <div style={{ background: 'rgba(3, 199, 90, 0.15)', width: '70px', height: '70px', borderRadius: '50%', display: 'flex', alignItems: 'center', justifyContent: 'center', margin: '0 auto 16px auto' }}>
            <Upload size={32} color="#03C75A" />
          </div>
          <h3 style={{ fontSize: '1.1rem', fontWeight: 700, marginBottom: '8px' }}>
            사진 또는 영상을 여기에 클릭하여 선택하세요 (여러 개 한 번에 가능)
          </h3>
          <p style={{ color: 'var(--text-muted)', fontSize: '0.85rem' }}>
            JPG/PNG/WEBP, MP4/MOV 지원 · 사진과 영상을 섞어 고르면 사진만 먼저 처리돼요 · 100% 브라우저 내 처리로 파일이
            어디로도 업로드되지 않아요
          </p>
          {!modelReady && !modelError && (
            <p style={{ color: '#03C75A', fontSize: '0.8rem', marginTop: '10px' }}>얼굴 인식 모델 준비 중...</p>
          )}
        </div>
      ) : (
        <div className="mosaic-grid">
          <div
            style={{
              background: '#090d16',
              borderRadius: '16px',
              padding: '16px',
              display: 'flex',
              flexDirection: 'column',
              alignItems: 'center',
              justifyContent: 'center',
              border: '1px solid var(--border-color)',
              minHeight: '320px',
              gap: '12px',
            }}
          >
            {isProcessing && (
              <div style={{ textAlign: 'center', color: '#03C75A' }}>
                <RefreshCw size={30} style={{ animation: 'spin 1s linear infinite' }} />
                <p style={{ marginTop: '10px', fontWeight: 600, fontSize: '0.9rem' }}>{statusMessage}</p>
                {mediaKind === 'video' && (
                  <div style={{ width: '200px', height: '6px', background: 'rgba(255,255,255,0.1)', borderRadius: '4px', margin: '10px auto 0', overflow: 'hidden' }}>
                    <div
                      style={{
                        width: `${Math.round((videoItems.find((it) => it.status === 'processing')?.progress ?? 0) * 100)}%`,
                        height: '100%',
                        background: '#03C75A',
                        transition: 'width 0.2s',
                      }}
                    />
                  </div>
                )}
              </div>
            )}

            <div style={{ width: '100%', overflow: 'auto', textAlign: 'center', display: isProcessing && mediaKind === 'video' ? 'none' : 'block' }}>
              {mediaKind === 'image' && !activeImage?.img && (
                <div style={{ padding: '60px 20px', color: 'var(--text-muted)' }}>
                  <RefreshCw size={26} style={{ animation: 'spin 1s linear infinite', color: '#03C75A' }} />
                  <p style={{ marginTop: '10px', fontSize: '0.85rem' }}>
                    이 사진은 아직 처리 전이에요. 순서대로 처리되고 있으니 잠시만 기다려주세요...
                  </p>
                </div>
              )}
              {mediaKind === 'image' && (
                <canvas
                  ref={canvasRef}
                  onClick={handleCanvasClick}
                  style={{
                    maxWidth: '100%',
                    maxHeight: '480px',
                    borderRadius: '8px',
                    boxShadow: '0 8px 24px rgba(0,0,0,0.5)',
                    margin: '0 auto',
                    display: activeImage?.img ? 'block' : 'none',
                    cursor: manualAddActive ? 'crosshair' : 'default',
                  }}
                />
              )}
              {mediaKind === 'video' && activeVideoItem && !activeVideoItem.resultUrl && (
                <video
                  ref={videoElRef}
                  src={activeVideoItem.objectUrl}
                  controls
                  playsInline
                  muted
                  style={{ maxWidth: '100%', maxHeight: '480px', borderRadius: '8px' }}
                />
              )}
              {mediaKind === 'video' && <canvas ref={canvasRef} style={{ display: 'none' }} />}
              {mediaKind === 'video' && activeVideoItem?.resultUrl && (
                <div>
                  <p style={{ fontSize: '0.8rem', color: 'var(--text-muted)', marginBottom: '8px' }}>결과 미리보기 (무음)</p>
                  <video src={activeVideoItem.resultUrl} controls playsInline style={{ maxWidth: '100%', maxHeight: '480px', borderRadius: '8px' }} />
                </div>
              )}
            </div>

            {!isProcessing && mediaKind === 'video' && videoItems.some((it) => it.status !== 'done') && (
              <button onClick={processVideoQueue} className="btn-naver" disabled={!modelReady}>
                <Rabbit size={18} />
                {videoItems.length > 1 ? '전체 영상 모자이크 시작' : '토끼 모자이크 시작'}
              </button>
            )}

            {/* 영상을 여러 개 올렸을 때 큐 목록 — 눌러서 큰 화면에 띄우고 개별 다운로드 */}
            {mediaKind === 'video' && videoItems.length > 1 && (
              <div style={{ width: '100%', display: 'flex', flexDirection: 'column', gap: '6px' }}>
                {videoItems.map((it, idx) => (
                  <div
                    key={it.id}
                    onClick={() => setActiveVideoIndex(idx)}
                    style={{
                      display: 'flex',
                      alignItems: 'center',
                      gap: '8px',
                      padding: '8px 10px',
                      borderRadius: '8px',
                      cursor: 'pointer',
                      background: idx === activeVideoIndex ? 'rgba(3,199,90,0.12)' : 'rgba(255,255,255,0.04)',
                      border: idx === activeVideoIndex ? '1px solid rgba(3,199,90,0.4)' : '1px solid transparent',
                    }}
                  >
                    <span style={{ flex: 1, fontSize: '0.82rem', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', textAlign: 'left' }}>
                      {it.file.name}
                    </span>
                    <span
                      style={{
                        fontSize: '0.75rem',
                        color: it.status === 'done' ? '#03C75A' : it.status === 'error' ? '#f87171' : 'var(--text-muted)',
                        flexShrink: 0,
                      }}
                    >
                      {it.status === 'pending' && '대기중'}
                      {it.status === 'processing' && `처리중 ${Math.round(it.progress * 100)}%`}
                      {it.status === 'done' && '완료'}
                      {it.status === 'error' && '오류'}
                    </span>
                    {it.status === 'done' && it.resultUrl && (
                      <button
                        onClick={(e) => {
                          e.stopPropagation();
                          handleDownloadVideo(it);
                        }}
                        style={{ background: 'none', border: 'none', cursor: 'pointer', color: '#03C75A', display: 'flex', padding: 0 }}
                      >
                        <Download size={16} />
                      </button>
                    )}
                    {it.status !== 'processing' && (
                      <button
                        onClick={(e) => {
                          e.stopPropagation();
                          handleRemoveVideoItem(it.id);
                        }}
                        style={{ background: 'none', border: 'none', cursor: 'pointer', color: '#94a3b8', display: 'flex', padding: 0 }}
                      >
                        <X size={14} />
                      </button>
                    )}
                  </div>
                ))}
              </div>
            )}

            {/* 여러 장 업로드했을 때 썸네일 스트립 — 눌러서 큰 화면에 띄우고 편집 */}
            {mediaKind === 'image' && images.length > 1 && (
              <div style={{ width: '100%', display: 'flex', gap: '8px', overflowX: 'auto', padding: '4px 2px' }}>
                {images.map((it, idx) => (
                  <div
                    key={it.id}
                    onClick={() => setActiveImageIndex(idx)}
                    style={{
                      position: 'relative',
                      flex: '0 0 auto',
                      width: '68px',
                      height: '68px',
                      borderRadius: '8px',
                      overflow: 'hidden',
                      border: idx === activeImageIndex ? '2px solid #03C75A' : '2px solid transparent',
                      cursor: 'pointer',
                      background: '#1e293b',
                    }}
                  >
                    {it.previewUrl ? (
                      <img src={it.previewUrl} alt="" style={{ width: '100%', height: '100%', objectFit: 'cover' }} />
                    ) : (
                      <div style={{ width: '100%', height: '100%', display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
                        <RefreshCw size={16} style={{ animation: 'spin 1s linear infinite', color: '#03C75A' }} />
                      </div>
                    )}
                    <button
                      onClick={(e) => {
                        e.stopPropagation();
                        handleRemoveImage(it.id);
                      }}
                      style={{
                        position: 'absolute',
                        top: 2,
                        right: 2,
                        background: 'rgba(0,0,0,0.6)',
                        border: 'none',
                        borderRadius: '50%',
                        width: '18px',
                        height: '18px',
                        display: 'flex',
                        alignItems: 'center',
                        justifyContent: 'center',
                        cursor: 'pointer',
                        padding: 0,
                      }}
                    >
                      <X size={11} color="#fff" />
                    </button>
                  </div>
                ))}
              </div>
            )}
          </div>

          <div className="glass-panel" style={{ padding: '20px', display: 'flex', flexDirection: 'column', gap: '18px' }}>
            <div>
              <span style={{ fontSize: '0.85rem', fontWeight: 600, marginBottom: '8px', display: 'block' }}>모자이크 방식</span>
              <div style={{ display: 'flex', gap: '8px' }}>
                <button
                  onClick={() => setMode('rabbit')}
                  className={mode === 'rabbit' ? 'btn-naver' : 'btn-secondary'}
                  style={{ flex: 1, justifyContent: 'center', padding: '8px' }}
                >
                  <Rabbit size={16} /> 토끼 스티커
                </button>
                <button
                  onClick={() => setMode('pixelate')}
                  className={mode === 'pixelate' ? 'btn-naver' : 'btn-secondary'}
                  style={{ flex: 1, justifyContent: 'center', padding: '8px' }}
                >
                  <Grid3x3 size={16} /> 픽셀 블러
                </button>
              </div>
            </div>

            {mode === 'pixelate' && (
              <div>
                <label style={{ display: 'flex', justifyContent: 'space-between', fontWeight: 600, fontSize: '0.85rem', marginBottom: '8px' }}>
                  <span>픽셀 크기</span>
                  <span style={{ color: '#03C75A' }}>{pixelSize}px</span>
                </label>
                <input
                  type="range"
                  min="4"
                  max="32"
                  value={pixelSize}
                  onChange={(e) => setPixelSize(Number(e.target.value))}
                  style={{ width: '100%', accentColor: '#03C75A' }}
                />
              </div>
            )}

            {mediaKind === 'image' && (
              <>
                <hr style={{ border: 'none', borderTop: '1px solid var(--border-color)' }} />
                <div>
                  <div style={{ display: 'flex', gap: '8px' }}>
                    <button
                      onClick={() => setManualAddActive((v) => !v)}
                      className={manualAddActive ? 'btn-naver' : 'btn-secondary'}
                      style={{ flex: 1, justifyContent: 'center' }}
                    >
                      <Hand size={16} />
                      {manualAddActive ? '얼굴 직접 추가 중 (사진을 눌러 추가)' : '얼굴 직접 추가'}
                    </button>
                    {(activeImage?.history.length ?? 0) > 0 && (
                      <button
                        onClick={handleUndoManualFace}
                        className="btn-secondary"
                        title="방금 추가/제거한 것 되돌리기"
                        style={{ flex: '0 0 auto', justifyContent: 'center', padding: '10px 14px' }}
                      >
                        <Undo2 size={16} />
                      </button>
                    )}
                  </div>
                  <p style={{ fontSize: '0.78rem', color: 'var(--text-muted)', marginTop: '6px' }}>
                    자동으로 못 찾은 얼굴이 있으면 켜고 사진에서 그 자리를 눌러주세요. 이미 놓인 자리를 다시 누르면
                    지워져요. 잘못 눌렀으면 옆의 되돌리기 버튼으로 한 단계씩 취소할 수 있어요.
                  </p>
                </div>
                {manualAddActive && (
                  <div>
                    <label style={{ display: 'flex', justifyContent: 'space-between', fontWeight: 600, fontSize: '0.85rem', marginBottom: '8px' }}>
                      <span>추가할 크기</span>
                      <span style={{ color: '#03C75A' }}>{manualSizePct}%</span>
                    </label>
                    <input
                      type="range"
                      min="6"
                      max="40"
                      value={manualSizePct}
                      onChange={(e) => setManualSizePct(Number(e.target.value))}
                      style={{ width: '100%', accentColor: '#03C75A' }}
                    />
                  </div>
                )}
                <hr style={{ border: 'none', borderTop: '1px solid var(--border-color)' }} />
              </>
            )}

            {mediaKind === 'image' && activeImage && (
              <div style={{ fontSize: '0.85rem', color: 'var(--text-muted)' }}>
                {images.length > 1 && (
                  <div style={{ marginBottom: '4px' }}>
                    사진 {activeImageIndex + 1} / {images.length}
                  </div>
                )}
                감지된 얼굴: <strong style={{ color: '#03C75A' }}>{activeImage.faces.length}개</strong>
                {activeImage.faces.some((f) => f.source === 'manual') && (
                  <span style={{ color: '#94a3b8' }}> (수동 {activeImage.faces.filter((f) => f.source === 'manual').length}개 포함)</span>
                )}
              </div>
            )}

            {mediaKind === 'image' && (
              <div style={{ display: 'flex', flexDirection: 'column', gap: '8px' }}>
                <button onClick={handleDownloadActiveImage} className="btn-naver" style={{ justifyContent: 'center' }}>
                  <Download size={18} />
                  {images.length > 1 ? '이 사진 다운로드' : '사진 다운로드'}
                </button>
                {images.length > 1 && (
                  <button onClick={handleDownloadAllImages} className="btn-secondary" style={{ justifyContent: 'center' }}>
                    <Download size={16} />
                    전체 {images.length}장 한번에 다운로드
                  </button>
                )}
              </div>
            )}
            {mediaKind === 'video' && (
              <div style={{ display: 'flex', flexDirection: 'column', gap: '8px' }}>
                {activeVideoItem?.resultUrl && (
                  <button onClick={() => handleDownloadVideo(activeVideoItem)} className="btn-naver" style={{ justifyContent: 'center' }}>
                    <Download size={18} />
                    {videoItems.length > 1 ? '이 영상 다운로드 (무음)' : '영상 다운로드 (무음)'}
                  </button>
                )}
                {videoItems.length > 1 && videoItems.some((it) => it.resultUrl) && (
                  <button onClick={handleDownloadAllVideos} className="btn-secondary" style={{ justifyContent: 'center' }}>
                    <Download size={16} />
                    완료된 영상 전체 다운로드
                  </button>
                )}
              </div>
            )}

            <div style={{ background: 'rgba(3, 199, 90, 0.08)', border: '1px solid rgba(3, 199, 90, 0.2)', borderRadius: '10px', padding: '12px', fontSize: '0.8rem', color: '#94a3b8' }}>
              <div style={{ display: 'flex', alignItems: 'center', gap: '6px', color: '#03C75A', fontWeight: 600, marginBottom: '4px' }}>
                <CheckCircle2 size={16} />
                사용 팁
              </div>
              {mediaKind === 'image'
                ? '자동 인식이 옆모습·역광·작은 얼굴을 놓칠 수 있어요. 그럴 땐 "얼굴 직접 추가"를 켜고 사진을 눌러 채워주세요.'
                : '영상은 얼굴 각도·화질에 따라 인식이 놓칠 수 있어요. 처리 후 결과 미리보기로 얼굴이 잘 가려졌는지 꼭 확인하세요.'}
            </div>
          </div>
        </div>
      )}
    </div>
  );
};
