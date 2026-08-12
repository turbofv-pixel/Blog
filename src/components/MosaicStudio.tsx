import React, { useState, useRef, useEffect, useCallback } from 'react';
import { Upload, Download, RefreshCw, CheckCircle2, Sparkles, AlertTriangle, Rabbit, Grid3x3 } from 'lucide-react';

declare global {
  interface Window {
    faceapi: any;
  }
}

type MosaicMode = 'rabbit' | 'pixelate';
type MediaKind = 'image' | 'video';

interface DetectedFace {
  x: number;
  y: number;
  width: number;
  height: number;
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

async function detectFacesIn(el: HTMLImageElement | HTMLVideoElement): Promise<DetectedFace[]> {
  const faceapi = window.faceapi;
  const options = new faceapi.TinyFaceDetectorOptions({ inputSize: 320, scoreThreshold: 0.5 });
  const detections = await faceapi.detectAllFaces(el, options);
  return detections.map((d: any) => ({ x: d.box.x, y: d.box.y, width: d.box.width, height: d.box.height }));
}

function drawPixelate(
  ctx: CanvasRenderingContext2D,
  source: CanvasImageSource,
  face: DetectedFace,
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

function drawRabbit(ctx: CanvasRenderingContext2D, bunny: HTMLImageElement, face: DetectedFace) {
  const cx = face.x + face.width / 2;
  const cy = face.y + face.height / 2;
  const r = Math.max(face.width, face.height) / 2;
  const diam = r * 2 * FACE_MARGIN;
  // 스프라이트는 귀가 위쪽에 있어서, 얼굴 원 중심이 cy에 오도록 위로 살짝 올려서 배치
  const dx = cx - diam / 2;
  const dy = cy - diam * 0.56;
  ctx.drawImage(bunny, dx, dy, diam, diam);
}

export const MosaicStudio: React.FC = () => {
  const [mediaSrc, setMediaSrc] = useState<string | null>(null);
  const [mediaKind, setMediaKind] = useState<MediaKind | null>(null);
  const [mode, setMode] = useState<MosaicMode>('rabbit');
  const [pixelSize, setPixelSize] = useState<number>(14);
  const [isProcessing, setIsProcessing] = useState<boolean>(false);
  const [statusMessage, setStatusMessage] = useState<string>('사진이나 영상을 선택하면 자동으로 얼굴을 찾아 토끼로 가려드려요.');
  const [modelReady, setModelReady] = useState<boolean>(false);
  const [modelError, setModelError] = useState<string | null>(null);
  const [faceCount, setFaceCount] = useState<number | null>(null);
  const [videoResultUrl, setVideoResultUrl] = useState<string | null>(null);
  const [videoResultExt, setVideoResultExt] = useState<string>('webm');
  const [videoProgress, setVideoProgress] = useState<number>(0);

  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const imageRef = useRef<HTMLImageElement | null>(null);
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

  const renderImageMosaic = useCallback(
    async (img: HTMLImageElement, faces: DetectedFace[]) => {
      const canvas = canvasRef.current;
      const bunny = bunnyRef.current;
      if (!canvas) return;
      canvas.width = img.width;
      canvas.height = img.height;
      const ctx = canvas.getContext('2d');
      if (!ctx) return;
      ctx.drawImage(img, 0, 0);
      faces.forEach((face) => {
        if (mode === 'rabbit' && bunny) drawRabbit(ctx, bunny, face);
        else drawPixelate(ctx, img, face, pixelSize);
      });
    },
    [mode, pixelSize]
  );

  const handleFileChange = (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (!file) return;
    setVideoResultUrl(null);
    setFaceCount(null);
    const kind: MediaKind = file.type.startsWith('video/') ? 'video' : 'image';
    setMediaKind(kind);
    const url = URL.createObjectURL(file);
    setMediaSrc(url);

    if (kind === 'image') {
      processImage(url);
    } else {
      setStatusMessage('영상을 불러왔습니다. 아래 "토끼 모자이크 시작" 버튼을 눌러주세요.');
    }
  };

  const processImage = async (src: string) => {
    setIsProcessing(true);
    setStatusMessage('얼굴을 찾는 중입니다...');
    try {
      await ensureModelsLoaded();
      const img = await loadImageEl(src);
      imageRef.current = img;
      const faces = await detectFacesIn(img);
      setFaceCount(faces.length);
      await renderImageMosaic(img, faces);
      setStatusMessage(
        faces.length > 0
          ? `✨ 얼굴 ${faces.length}개를 찾아 토끼로 가렸습니다.`
          : '⚠️ 얼굴을 찾지 못했습니다. 사진 속 인물이 정면을 보고 있는지 확인해주세요.'
      );
    } catch (err: any) {
      setStatusMessage(`❌ 처리 중 오류: ${err.message || err}`);
    } finally {
      setIsProcessing(false);
    }
  };

  // mode/pixelSize가 바뀌면 사진 모드에서는 다시 그려준다 (얼굴은 재탐지할 필요 없음)
  useEffect(() => {
    if (mediaKind === 'image' && imageRef.current && faceCount !== null) {
      (async () => {
        const img = imageRef.current!;
        await ensureModelsLoaded();
        const faces = await detectFacesIn(img);
        renderImageMosaic(img, faces);
      })();
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [mode, pixelSize]);

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

  const processVideo = async () => {
    const video = videoElRef.current;
    const canvas = canvasRef.current;
    const bunny = bunnyRef.current;
    if (!video || !canvas || !mediaSrc) return;

    setIsProcessing(true);
    setVideoResultUrl(null);
    setVideoProgress(0);
    cancelRef.current = false;
    setStatusMessage('얼굴 인식 모델을 준비하는 중입니다...');

    try {
      await ensureModelsLoaded();
    } catch (err: any) {
      setStatusMessage(`❌ 모델 로딩 실패: ${err.message || err}`);
      setIsProcessing(false);
      return;
    }

    await new Promise<void>((resolve) => {
      if (video.readyState >= 1) resolve();
      else video.onloadedmetadata = () => resolve();
    });

    canvas.width = video.videoWidth;
    canvas.height = video.videoHeight;
    const ctx = canvas.getContext('2d');
    if (!ctx) {
      setIsProcessing(false);
      return;
    }

    const mimeType = pickSupportedMimeType();
    if (!mimeType) {
      setStatusMessage('❌ 이 브라우저는 영상 녹화(MediaRecorder)를 지원하지 않습니다.');
      setIsProcessing(false);
      return;
    }
    const ext = mimeType.includes('mp4') ? 'mp4' : 'webm';
    setVideoResultExt(ext);

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

    setStatusMessage('영상을 처리하는 중입니다... (영상 길이만큼 시간이 걸려요)');
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
            const faces = await detectFacesIn(video);
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

        setVideoProgress(video.duration ? video.currentTime / video.duration : 0);
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
    setVideoResultUrl(url);
    setIsProcessing(false);
    const ratio = framesTotal ? framesWithFace / framesTotal : 0;
    setStatusMessage(
      ratio > 0.5
        ? `✨ 처리 완료! (얼굴 인식된 구간 ${(ratio * 100).toFixed(0)}%) · 무음 처리됨`
        : `⚠️ 처리는 됐지만 얼굴 인식 비율이 낮아요(${(ratio * 100).toFixed(0)}%). 아래 미리보기로 확인해보세요.`
    );
  };

  const handleDownloadImage = () => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const link = document.createElement('a');
    link.download = `rabbit_mosaic_${Date.now()}.png`;
    link.href = canvas.toDataURL('image/png');
    link.click();
  };

  const handleDownloadVideo = () => {
    if (!videoResultUrl) return;
    const link = document.createElement('a');
    link.download = `rabbit_mosaic_${Date.now()}.${videoResultExt}`;
    link.href = videoResultUrl;
    link.click();
  };

  const handleReset = () => {
    setMediaSrc(null);
    setMediaKind(null);
    setVideoResultUrl(null);
    setFaceCount(null);
    setVideoProgress(0);
    cancelRef.current = true;
  };

  return (
    <div className="glass-panel animate-fade-in" style={{ padding: '28px' }}>
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: '20px', flexWrap: 'wrap', gap: '12px' }}>
        <div>
          <h2 style={{ fontSize: '1.4rem', fontWeight: 700, display: 'flex', alignItems: 'center', gap: '10px' }}>
            <Sparkles color="#03C75A" size={24} />
            토끼 얼굴 모자이크 스튜디오
          </h2>
          <p style={{ color: 'var(--text-muted)', fontSize: '0.9rem', marginTop: '4px' }}>
            사진·영상 속 얼굴을 브라우저에서 바로 인식해 토끼 스티커로 가려드려요. 영상은 자동으로 무음 처리됩니다.
            모바일 브라우저에서도 그대로 사용할 수 있어요.
          </p>
        </div>
        {mediaSrc && (
          <button onClick={handleReset} className="btn-secondary">
            <RefreshCw size={16} />
            다른 파일로 변경
          </button>
        )}
      </div>

      {modelError && (
        <div style={{ display: 'flex', alignItems: 'center', gap: '8px', color: '#f87171', background: 'rgba(248,113,113,0.08)', border: '1px solid rgba(248,113,113,0.25)', borderRadius: '10px', padding: '10px 14px', marginBottom: '16px', fontSize: '0.85rem' }}>
          <AlertTriangle size={16} />
          얼굴 인식 모델을 불러오지 못했습니다: {modelError} (새로고침 후 다시 시도해주세요)
        </div>
      )}

      {!mediaSrc ? (
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
            onChange={handleFileChange}
            style={{ display: 'none' }}
          />
          <div style={{ background: 'rgba(3, 199, 90, 0.15)', width: '70px', height: '70px', borderRadius: '50%', display: 'flex', alignItems: 'center', justifyContent: 'center', margin: '0 auto 16px auto' }}>
            <Upload size={32} color="#03C75A" />
          </div>
          <h3 style={{ fontSize: '1.1rem', fontWeight: 700, marginBottom: '8px' }}>
            사진 또는 영상을 여기에 클릭하여 선택하세요
          </h3>
          <p style={{ color: 'var(--text-muted)', fontSize: '0.85rem' }}>
            JPG/PNG/WEBP, MP4/MOV 지원 · 100% 브라우저 내 처리로 파일이 어디로도 업로드되지 않아요
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
                    <div style={{ width: `${Math.round(videoProgress * 100)}%`, height: '100%', background: '#03C75A', transition: 'width 0.2s' }} />
                  </div>
                )}
              </div>
            )}

            <div style={{ width: '100%', overflow: 'auto', textAlign: 'center', display: isProcessing && mediaKind === 'video' ? 'none' : 'block' }}>
              <canvas
                ref={canvasRef}
                style={{ maxWidth: '100%', maxHeight: '480px', borderRadius: '8px', boxShadow: '0 8px 24px rgba(0,0,0,0.5)', display: mediaKind === 'image' ? 'block' : 'none', margin: '0 auto' }}
              />
              {mediaKind === 'video' && !videoResultUrl && (
                <video
                  ref={videoElRef}
                  src={mediaSrc}
                  controls
                  playsInline
                  muted
                  style={{ maxWidth: '100%', maxHeight: '480px', borderRadius: '8px' }}
                />
              )}
              {mediaKind === 'video' && (
                <canvas ref={canvasRef} style={{ display: 'none' }} />
              )}
              {videoResultUrl && (
                <div>
                  <p style={{ fontSize: '0.8rem', color: 'var(--text-muted)', marginBottom: '8px' }}>결과 미리보기 (무음)</p>
                  <video src={videoResultUrl} controls playsInline style={{ maxWidth: '100%', maxHeight: '480px', borderRadius: '8px' }} />
                </div>
              )}
            </div>

            {!isProcessing && mediaKind === 'video' && !videoResultUrl && (
              <button onClick={processVideo} className="btn-naver" disabled={!modelReady}>
                <Rabbit size={18} />
                토끼 모자이크 시작
              </button>
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

            {faceCount !== null && mediaKind === 'image' && (
              <div style={{ fontSize: '0.85rem', color: 'var(--text-muted)' }}>
                감지된 얼굴: <strong style={{ color: '#03C75A' }}>{faceCount}개</strong>
              </div>
            )}

            {mediaKind === 'image' && (
              <button onClick={handleDownloadImage} className="btn-naver" style={{ justifyContent: 'center' }}>
                <Download size={18} />
                사진 다운로드
              </button>
            )}
            {mediaKind === 'video' && videoResultUrl && (
              <button onClick={handleDownloadVideo} className="btn-naver" style={{ justifyContent: 'center' }}>
                <Download size={18} />
                영상 다운로드 (무음)
              </button>
            )}

            <div style={{ background: 'rgba(3, 199, 90, 0.08)', border: '1px solid rgba(3, 199, 90, 0.2)', borderRadius: '10px', padding: '12px', fontSize: '0.8rem', color: '#94a3b8' }}>
              <div style={{ display: 'flex', alignItems: 'center', gap: '6px', color: '#03C75A', fontWeight: 600, marginBottom: '4px' }}>
                <CheckCircle2 size={16} />
                사용 팁
              </div>
              영상은 얼굴 각도·화질에 따라 인식이 놓칠 수 있어요. 처리 후 결과 미리보기로 얼굴이 잘 가려졌는지 꼭 확인하세요.
            </div>
          </div>
        </div>
      )}
    </div>
  );
};
