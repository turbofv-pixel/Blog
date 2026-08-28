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
  caption: string; // 사진 내용을 짧게 적어두는 메모 — Claude가 사진을 직접 안 보고도 이 텍스트만으로 글을 쓸 수 있게
}

const MAX_UNDO_HISTORY = 20;

// 수동 모드에서 특정 시점(초 단위)에 사용자가 직접 배치한 토끼 마커들. 위치/크기를 영상의
// 실제 가로/세로 대비 "비율"(0~1)로 저장해서, 화면에 얼마나 작게/크게 표시되든, 또 최종
// 렌더링 캔버스 해상도가 얼마든 항상 정확한 실제 좌표로 환산할 수 있게 한다. fr(반지름)은
// 항상 "가로" 기준 비율로 통일해서, x/y 어느 쪽으로 변환하든 진짜 원이 되게 한다.
interface VideoMarker {
  id: string;
  fx: number;
  fy: number;
  fr: number;
}

interface VideoKeyframe {
  time: number; // 초 단위
  markers: VideoMarker[];
}

interface VideoItem {
  id: string;
  file: File;
  objectUrl: string;
  status: 'pending' | 'processing' | 'done' | 'error';
  progress: number;
  resultUrl: string | null;
  resultExt: string;
  faceRatio: number | null;
  // 수동 모드: 자동 얼굴 인식 대신, 사용자가 프레임을 직접 확인하면서 토끼를 배치한다.
  manualMode: boolean;
  // 시간순으로 정렬된 키프레임 목록. 재생 중 어느 시점이든 "그 시점 이하 중 가장 최근
  // 키프레임"의 마커를 그대로 유지(보간 없이 고정)하다가 다음 키프레임에서 바뀐다 — 여러
  // 얼굴이 나타났다 사라졌다 하는 걸 매끄럽게 보간하는 것보다, 사용자가 확인한 그대로
  // 정확하게 고정되는 쪽이 이 기능의 목적(내가 직접 확인하면서 배치)에 더 맞는다.
  keyframes: VideoKeyframe[];
}

// 특정 시점(seconds)에 적용해야 할 마커 목록 — 그 시점 이하로 가장 최근인 키프레임을 찾는다.
function getActiveKeyframeMarkers(keyframes: VideoKeyframe[], time: number): VideoMarker[] {
  let active: VideoMarker[] = [];
  for (const kf of keyframes) {
    if (kf.time <= time + 0.001) active = kf.markers;
    else break;
  }
  return active;
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

// 불펌(무단 도용) 방지용 "대왕토끼" 표식 — 처리된 사진/영상 오른쪽 아래 구석에 작게 찍는다.
// 얼굴 스티커와는 무관하게 항상 같은 자리에 남는 워터마크라, 미리보기/최종 다운로드/영상
// 프레임 전부 이 함수 하나만 부르면 된다. 배경이 밝든 어둡든 잘 보이도록 흰 테두리 +
// 진한 채우기로 텍스트를 그린다.
function drawWatermark(ctx: CanvasRenderingContext2D, canvasWidth: number, canvasHeight: number, bunny: HTMLImageElement | null) {
  const pad = Math.max(8, Math.round(canvasWidth * 0.014));
  const logoSize = Math.max(24, Math.round(canvasWidth * 0.05));
  const fontSize = Math.max(11, Math.round(logoSize * 0.46));
  const text = '대왕토끼';

  ctx.save();
  ctx.globalAlpha = 0.62;
  ctx.font = `700 ${fontSize}px "Pretendard", "Malgun Gothic", sans-serif`;
  ctx.textAlign = 'right';
  ctx.textBaseline = 'bottom';

  const logoX = canvasWidth - pad - logoSize;
  const logoY = canvasHeight - pad - logoSize;
  if (bunny) {
    ctx.drawImage(bunny, logoX, logoY, logoSize, logoSize);
  }
  const textX = (bunny ? logoX - 6 : canvasWidth - pad);
  const textY = canvasHeight - pad - (bunny ? (logoSize - fontSize) / 2 : 0);
  ctx.lineWidth = Math.max(2, fontSize * 0.16);
  ctx.strokeStyle = 'rgba(255,255,255,0.9)';
  ctx.strokeText(text, textX, textY);
  ctx.fillStyle = 'rgba(20,20,20,0.85)';
  ctx.fillText(text, textX, textY);
  ctx.restore();
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
  drawWatermark(ctx, canvas.width, canvas.height, bunny);
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

interface MosaicStudioProps {
  // "GitHub 백업 관리" 탭에서 설명 메모를 먼저 올린 뒤 "이어서 모자이크 처리하기"를 누르면,
  // 같은 사진 File들을 다시 선택할 필요 없이 여기로 바로 넘겨받아 자동으로 배치 처리를
  // 시작한다. 다 받으면 onFilesConsumed()로 부모(App) 쪽의 대기열을 비워서, 이 탭을 나갔다
  // 다시 들어와도 같은 파일이 또 로드되지 않게 한다.
  initialFiles?: File[] | null;
  onFilesConsumed?: () => void;
}

export const MosaicStudio: React.FC<MosaicStudioProps> = ({ initialFiles, onFilesConsumed }) => {
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
  const [captionsCopied, setCaptionsCopied] = useState<boolean>(false);

  // --- 영상(여러 개 가능, 순서대로 하나씩 처리) 상태 ---
  const [videoItems, setVideoItems] = useState<VideoItem[]>([]);
  const [activeVideoIndex, setActiveVideoIndex] = useState<number>(0);
  // 수동 배치 모드에서 새로 찍는 마커의 크기(영상 가로 대비 지름 %) — 사진 쪽 manualSizePct와
  // 같은 개념.
  const [videoManualSizePct, setVideoManualSizePct] = useState<number>(16);
  // <video> 엘리먼트는 React state가 아니라서, 재생/탐색 중 현재 시각을 화면(오버레이 마커,
  // 시간 표시)에 반영하려면 별도로 추적해야 한다.
  const [videoScrubTime, setVideoScrubTime] = useState<number>(0);

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
      manualMode: false,
      keyframes: [],
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
      caption: '',
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

  // "GitHub 백업 관리" 탭에서 설명 메모를 올린 뒤 넘겨준 파일들을, 이 탭에 들어오는 순간(또는
  // 넘겨준 시점에 이미 이 탭이 열려있으면 그 즉시) 자동으로 같은 배치 처리 경로(startImageBatch)
  // 로 흘려보낸다 — 사용자가 같은 사진을 다시 선택할 필요가 없다.
  useEffect(() => {
    if (initialFiles && initialFiles.length > 0) {
      startImageBatch(initialFiles, false);
      onFilesConsumed?.();
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [initialFiles]);

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

  // 활성 영상의 "수동 배치 모드"를 켜고 끈다. 자동 인식 모드로 돌아가도 이미 찍어둔 키프레임은
  // 지우지 않는다 — 다시 수동으로 돌아오면 그대로 남아있다.
  const toggleVideoManualMode = () => {
    if (!activeVideoItem) return;
    const id = activeVideoItem.id;
    setVideoItems((prev) => prev.map((it) => (it.id === id ? { ...it, manualMode: !it.manualMode } : it)));
  };

  // 영상을 지정한 만큼(초 단위, 음수면 뒤로) 이동한다 — 재생 중이면 멈추고 정확한 프레임을
  // 확인할 수 있게 한다.
  const stepVideoTime = (deltaSeconds: number) => {
    const video = videoElRef.current;
    if (!video) return;
    video.pause();
    const next = Math.max(0, Math.min(video.duration || 0, video.currentTime + deltaSeconds));
    video.currentTime = next;
    setVideoScrubTime(next);
  };

  // 특정 시각의 키프레임을 완전히 삭제한다(그 시점부터는 그 이전 키프레임의 마커로 되돌아감).
  const handleDeleteKeyframe = (time: number) => {
    if (!activeVideoItem) return;
    const id = activeVideoItem.id;
    setVideoItems((prev) =>
      prev.map((it) => (it.id === id ? { ...it, keyframes: it.keyframes.filter((k) => Math.abs(k.time - time) >= 0.05) } : it))
    );
  };

  // 현재 재생 위치를 클릭하면, 그 시점에 적용 중인 마커 목록(가장 최근 키프레임 것을 그대로
  // 이어받음)을 기준으로 토끼를 추가/제거하고, 정확히 지금 이 시각의 키프레임으로 저장한다.
  // 이미 이 시각(±50ms) 근처에 키프레임이 있으면 그 키프레임을 그대로 고쳐 쓰고, 없으면 새로
  // 만든다 — 그래서 "저장" 버튼 없이 클릭하는 즉시 바로 반영된다.
  const handleVideoOverlayClick = (e: React.MouseEvent<HTMLDivElement>) => {
    const item = activeVideoItem;
    const video = videoElRef.current;
    if (!item || !video || !item.manualMode || !video.videoWidth) return;
    const rect = e.currentTarget.getBoundingClientRect();
    const fx = (e.clientX - rect.left) / rect.width;
    const fy = (e.clientY - rect.top) / rect.height;
    const time = video.currentTime;
    const activeMarkers = getActiveKeyframeMarkers(item.keyframes, time);

    const hitIdx = activeMarkers.findIndex((m) => {
      const dxPx = (fx - m.fx) * video.videoWidth;
      const dyPx = (fy - m.fy) * video.videoHeight;
      const rPx = m.fr * video.videoWidth;
      return Math.hypot(dxPx, dyPx) <= rPx;
    });
    const newMarkers =
      hitIdx >= 0
        ? activeMarkers.filter((_, i) => i !== hitIdx)
        : [...activeMarkers, { id: uid(), fx, fy, fr: videoManualSizePct / 100 / 2 }];

    setVideoItems((prev) =>
      prev.map((it) => {
        if (it.id !== item.id) return it;
        const existingIdx = it.keyframes.findIndex((k) => Math.abs(k.time - time) < 0.05);
        const keyframes =
          existingIdx >= 0
            ? it.keyframes.map((k, i) => (i === existingIdx ? { ...k, markers: newMarkers } : k))
            : [...it.keyframes, { time, markers: newMarkers }].sort((a, b) => a.time - b.time);
        return { ...it, keyframes };
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
    // 수동 모드로 켜놓고 영상 위를 한 번도 클릭하지 않은 채(키프레임 0개) 바로 시작을 누르면,
    // 토끼가 하나도 안 씌워진 영상이 조용히 만들어진다 — 겉으로는 "그냥 원본이 그대로
    // 나온다"처럼 보여서 자동 인식이 실패한 줄 착각하기 쉽다. 처리 시작 전에 미리 막고
    // 알려준다.
    const emptyManualItem = videoItems.find((it) => it.status !== 'done' && it.manualMode && it.keyframes.length === 0);
    if (emptyManualItem) {
      setActiveVideoIndex(videoItems.indexOf(emptyManualItem));
      setStatusMessage(
        `❌ "${emptyManualItem.file.name}"은 수동 모드인데 아직 토끼를 하나도 배치하지 않았어요 — 위 영상을 클릭해서 먼저 토끼를 놓아주세요.`
      );
      return;
    }

    setIsProcessing(true);
    cancelRef.current = false;

    // 수동 모드 영상은 얼굴 인식 모델이 필요 없다 — 배치 안에 자동 모드 영상이 하나도 없으면
    // 모델 로딩 자체를 건너뛴다(모델 CDN이 막혀있어도 수동 모드는 그대로 쓸 수 있어야 하므로).
    const needsAutoModel = videoItems.some((it) => it.status !== 'done' && !it.manualMode);
    if (needsAutoModel) {
      setStatusMessage('얼굴 인식 모델을 준비하는 중입니다...');
      try {
        await ensureModelsLoaded();
      } catch (err: any) {
        setStatusMessage(`❌ 모델 로딩 실패: ${err.message || err}`);
        setIsProcessing(false);
        return;
      }
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
      if (item.manualMode) {
        // eslint-disable-next-line no-await-in-loop
        await processOneVideoManual(item);
      } else {
        // eslint-disable-next-line no-await-in-loop
        await processOneVideo(item.id, item.objectUrl);
      }
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
        drawWatermark(ctx, canvas.width, canvas.height, bunny);

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

  // 수동 모드 렌더링 — processOneVideo와 녹화 파이프라인(캔버스+MediaRecorder+무음+워터마크)은
  // 동일하지만, 얼굴 인식/스무딩 트래킹 대신 사용자가 미리 찍어둔 키프레임에서 그 시점의
  // 마커를 그대로 가져와 그린다.
  const processOneVideoManual = async (item: VideoItem) => {
    const video = videoElRef.current;
    const canvas = canvasRef.current;
    const bunny = bunnyRef.current;
    if (!video || !canvas) return;

    setVideoItems((prev) => prev.map((it) => (it.id === item.id ? { ...it, status: 'processing', progress: 0 } : it)));

    video.src = item.objectUrl;
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
      setVideoItems((prev) => prev.map((it) => (it.id === item.id ? { ...it, status: 'error' } : it)));
      setStatusMessage('❌ 이 브라우저는 영상 녹화(MediaRecorder)를 지원하지 않습니다.');
      return;
    }
    const ext = mimeType.includes('mp4') ? 'mp4' : 'webm';

    const stream = (canvas as any).captureStream(30) as MediaStream;
    const chunks: Blob[] = [];
    const recorder = new MediaRecorder(stream, { mimeType });
    recorder.ondataavailable = (e) => {
      if (e.data.size > 0) chunks.push(e.data);
    };
    const stopped = new Promise<void>((resolve) => {
      recorder.onstop = () => resolve();
    });

    video.currentTime = 0;
    video.muted = true;
    recorder.start();
    await video.play();

    await new Promise<void>((resolve) => {
      const step = () => {
        if (cancelRef.current || video.paused || video.ended) {
          resolve();
          return;
        }
        ctx.drawImage(video, 0, 0, canvas.width, canvas.height);

        const markers = getActiveKeyframeMarkers(item.keyframes, video.currentTime);
        markers.forEach((m) => {
          const cx = m.fx * canvas.width;
          const cy = m.fy * canvas.height;
          const r = m.fr * canvas.width;
          if (mode === 'rabbit' && bunny) {
            const diam = r * 2;
            ctx.drawImage(bunny, cx - diam / 2, cy - diam * 0.56, diam, diam);
          } else {
            drawPixelate(ctx, video, { x: cx - r, y: cy - r, width: r * 2, height: r * 2 }, pixelSize);
          }
        });
        drawWatermark(ctx, canvas.width, canvas.height, bunny);

        const progress = video.duration ? video.currentTime / video.duration : 0;
        setVideoItems((prev) => prev.map((it) => (it.id === item.id ? { ...it, progress } : it)));
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
    setVideoItems((prev) =>
      prev.map((it) =>
        it.id === item.id ? { ...it, status: 'done', resultUrl: url, resultExt: ext, faceRatio: null, progress: 1 } : it
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

  const handleCaptionChange = (id: string, caption: string) => {
    setImages((prev) => prev.map((it) => (it.id === id ? { ...it, caption } : it)));
  };

  // 사진마다 적어둔 설명을 한 번에 모아서 텍스트로 만든다 — Claude가 사진을 직접 안 보고
  // 이 텍스트만으로 글을 쓸 수 있게, 채팅창에 붙여넣기 좋은 형태로.
  const buildCaptionsText = () =>
    images
      .map((it, i) => {
        const filename = `rabbit_${it.file.name.replace(/\.[^.]+$/, '')}.jpg`;
        const note = it.caption.trim() || '(설명 없음)';
        return `${i + 1}. ${filename} — ${note}`;
      })
      .join('\n');

  const handleCopyCaptions = async () => {
    const text = buildCaptionsText();
    try {
      await navigator.clipboard.writeText(text);
      setCaptionsCopied(true);
      setTimeout(() => setCaptionsCopied(false), 2000);
    } catch {
      // 클립보드 API를 못 쓰는 브라우저면 그냥 알림으로 보여준다
      window.prompt('아래 텍스트를 복사해서 붙여넣어주세요:', text);
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

      {/* 처리 중이 아닐 때도 방금 무슨 일이 있었는지(완료/실패/경고) 계속 보여준다 — 이전엔
          isProcessing이 꺼지는 순간 최종 상태 메시지("✨ 처리 완료" 등)가 화면에서 그대로
          사라져서, 특히 실패/경고 메시지를 놓치기 쉬웠다. */}
      {!isProcessing && hasMedia && statusMessage && (statusMessage.startsWith('❌') || statusMessage.startsWith('⚠️') || statusMessage.startsWith('✨')) && (
        <div
          style={{
            display: 'flex',
            alignItems: 'center',
            gap: '8px',
            color: statusMessage.startsWith('❌') ? '#f87171' : statusMessage.startsWith('⚠️') ? '#fbbf24' : '#03C75A',
            background: statusMessage.startsWith('❌') ? 'rgba(248,113,113,0.08)' : statusMessage.startsWith('⚠️') ? 'rgba(251,191,36,0.08)' : 'rgba(3,199,90,0.08)',
            border: `1px solid ${statusMessage.startsWith('❌') ? 'rgba(248,113,113,0.25)' : statusMessage.startsWith('⚠️') ? 'rgba(251,191,36,0.25)' : 'rgba(3,199,90,0.25)'}`,
            borderRadius: '10px',
            padding: '10px 14px',
            marginBottom: '16px',
            fontSize: '0.85rem',
            fontWeight: 600,
          }}
        >
          {statusMessage}
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
                <div style={{ display: 'inline-block', position: 'relative' }}>
                  <video
                    ref={videoElRef}
                    src={activeVideoItem.objectUrl}
                    controls
                    playsInline
                    muted
                    onTimeUpdate={(e) => setVideoScrubTime(e.currentTarget.currentTime)}
                    onSeeked={(e) => setVideoScrubTime(e.currentTarget.currentTime)}
                    style={{ maxWidth: '100%', maxHeight: '480px', borderRadius: '8px', display: 'block' }}
                  />
                  {activeVideoItem.manualMode && (
                    <div
                      onClick={handleVideoOverlayClick}
                      style={{ position: 'absolute', inset: 0, cursor: 'crosshair' }}
                    >
                      {getActiveKeyframeMarkers(activeVideoItem.keyframes, videoScrubTime).map((m) => (
                        <div
                          key={m.id}
                          style={{
                            position: 'absolute',
                            left: `${m.fx * 100}%`,
                            top: `${m.fy * 100}%`,
                            width: `${m.fr * 2 * 100}%`,
                            aspectRatio: '1 / 1',
                            transform: 'translate(-50%, -50%)',
                            borderRadius: '50%',
                            border: '3px solid #03C75A',
                            background: 'rgba(3,199,90,0.25)',
                            pointerEvents: 'none',
                          }}
                        />
                      ))}
                    </div>
                  )}
                </div>
              )}
              {mediaKind === 'video' && activeVideoItem && !activeVideoItem.resultUrl && activeVideoItem.manualMode && (
                <div style={{ marginTop: '10px', display: 'flex', flexDirection: 'column', alignItems: 'center', gap: '8px' }}>
                  <div style={{ display: 'flex', alignItems: 'center', gap: '6px' }}>
                    <button onClick={() => stepVideoTime(-0.5)} className="btn-secondary" style={{ padding: '6px 10px', fontSize: '0.78rem' }}>
                      ◀ 0.5초
                    </button>
                    <button onClick={() => stepVideoTime(-0.1)} className="btn-secondary" style={{ padding: '6px 10px', fontSize: '0.78rem' }}>
                      ◀ 0.1초
                    </button>
                    <span style={{ fontSize: '0.8rem', color: 'var(--text-muted)', minWidth: '90px', textAlign: 'center' }}>
                      {videoScrubTime.toFixed(1)}s / {(videoElRef.current?.duration || 0).toFixed(1)}s
                    </span>
                    <button onClick={() => stepVideoTime(0.1)} className="btn-secondary" style={{ padding: '6px 10px', fontSize: '0.78rem' }}>
                      0.1초 ▶
                    </button>
                    <button onClick={() => stepVideoTime(0.5)} className="btn-secondary" style={{ padding: '6px 10px', fontSize: '0.78rem' }}>
                      0.5초 ▶
                    </button>
                  </div>
                  <p
                    style={{
                      fontSize: '0.8rem',
                      color: '#03C75A',
                      fontWeight: 600,
                      textAlign: 'center',
                      background: 'rgba(3,199,90,0.08)',
                      border: '1px solid rgba(3,199,90,0.25)',
                      borderRadius: '8px',
                      padding: '8px 12px',
                    }}
                  >
                    👆 바로 위 영상을 눌러서 토끼를 배치/제거하세요
                    {activeVideoItem.keyframes.length === 0 && ' (아직 하나도 안 놓았어요 — 놓기 전에 시작하면 토끼 없이 그대로 나가요!)'}. 놓은 자리는 다음
                    클릭 시점까지 그대로 유지돼요 — 얼굴이 움직이면 그 시점으로 이동해서 다시 눌러 위치를
                    갱신해주세요.
                  </p>
                  <div style={{ display: 'flex', alignItems: 'center', gap: '8px', width: '100%', maxWidth: '320px' }}>
                    <span style={{ fontSize: '0.76rem', color: 'var(--text-muted)', whiteSpace: 'nowrap' }}>크기</span>
                    <input
                      type="range"
                      min={6}
                      max={40}
                      value={videoManualSizePct}
                      onChange={(e) => setVideoManualSizePct(Number(e.target.value))}
                      style={{ flex: 1 }}
                    />
                    <span style={{ fontSize: '0.76rem', color: 'var(--text-muted)' }}>{videoManualSizePct}%</span>
                  </div>
                  {activeVideoItem.keyframes.length > 0 && (
                    <div style={{ display: 'flex', flexWrap: 'wrap', gap: '6px', justifyContent: 'center' }}>
                      {activeVideoItem.keyframes.map((kf) => (
                        <span
                          key={kf.time}
                          onClick={() => stepVideoTime(kf.time - videoScrubTime)}
                          style={{
                            display: 'flex',
                            alignItems: 'center',
                            gap: '4px',
                            fontSize: '0.72rem',
                            padding: '3px 8px',
                            borderRadius: '999px',
                            cursor: 'pointer',
                            background: Math.abs(kf.time - videoScrubTime) < 0.05 ? 'rgba(3,199,90,0.25)' : 'rgba(255,255,255,0.06)',
                            border: '1px solid var(--border-color)',
                          }}
                        >
                          {kf.time.toFixed(1)}s ({kf.markers.length}개)
                          <X
                            size={11}
                            onClick={(e) => {
                              e.stopPropagation();
                              handleDeleteKeyframe(kf.time);
                            }}
                          />
                        </span>
                      ))}
                    </div>
                  )}
                </div>
              )}
              {mediaKind === 'video' && <canvas ref={canvasRef} style={{ display: 'none' }} />}
              {mediaKind === 'video' && activeVideoItem?.resultUrl && (
                <div>
                  <p style={{ fontSize: '0.8rem', color: 'var(--text-muted)', marginBottom: '8px' }}>결과 미리보기 (무음)</p>
                  <video src={activeVideoItem.resultUrl} controls playsInline style={{ maxWidth: '100%', maxHeight: '480px', borderRadius: '8px' }} />
                </div>
              )}
            </div>

            {!isProcessing && mediaKind === 'video' && activeVideoItem && !activeVideoItem.resultUrl && (
              <button onClick={toggleVideoManualMode} className={activeVideoItem.manualMode ? 'btn-naver' : 'btn-secondary'}>
                <Hand size={16} />
                {activeVideoItem.manualMode ? '자동 인식 모드로 전환' : '수동으로 프레임 확인하며 배치'}
              </button>
            )}

            {!isProcessing && mediaKind === 'video' && videoItems.some((it) => it.status !== 'done') && (
              <button
                onClick={processVideoQueue}
                className="btn-naver"
                disabled={videoItems.some((it) => it.status !== 'done' && !it.manualMode) && !modelReady}
              >
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

            {mediaKind === 'image' && activeImage && (
              <div>
                <label style={{ display: 'block', fontWeight: 600, fontSize: '0.85rem', marginBottom: '8px' }}>
                  이 사진 설명 메모
                </label>
                <textarea
                  value={activeImage.caption}
                  onChange={(e) => handleCaptionChange(activeImage.id, e.target.value)}
                  placeholder="예: 우산 쓰고 걷는 아이랑 엄마, 뒤로 아파트 공사현장"
                  rows={2}
                  style={{
                    width: '100%',
                    background: '#090d16',
                    color: '#f8fafc',
                    border: '1px solid var(--border-color)',
                    borderRadius: '8px',
                    padding: '8px 10px',
                    fontSize: '0.85rem',
                    resize: 'vertical',
                    fontFamily: 'inherit',
                  }}
                />
                <p style={{ fontSize: '0.76rem', color: 'var(--text-muted)', marginTop: '4px' }}>
                  뭐가 찍혔는지 짧게 적어두면, Claude한테 사진을 직접 안 보여줘도 이 설명만으로 글을 쓰게 할 수
                  있어요. 다운로드한 사진과 이 설명을 GitHub에 바로 올리려면 상단의 "GitHub 백업 관리" 탭을
                  확인하세요.
                </p>
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
                <button onClick={handleCopyCaptions} className="btn-secondary" style={{ justifyContent: 'center' }}>
                  <CheckCircle2 size={16} color={captionsCopied ? '#03C75A' : undefined} />
                  {captionsCopied ? '설명 복사됨! Claude한테 붙여넣어주세요' : '사진 설명 전체 복사'}
                </button>
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
