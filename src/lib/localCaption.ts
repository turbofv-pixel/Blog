// 사진 설명을 완전히 무료로, 서버/API 호출 없이 브라우저 안에서 생성한다.
// @huggingface/transformers(transformers.js)로 작은 이미지 캡셔닝 모델(ViT 인코더 +
// GPT-2 디코더)을 브라우저에서 직접 돌린다. 모델 파일은 최초 1회 HuggingFace Hub에서
// 내려받아 브라우저 캐시(Cache Storage)에 저장되고, 그 다음부터는 인터넷 없이도 즉시
// 동작한다. Anthropic API 방식과 달리 사용한 만큼 요금이 청구되는 일이 전혀 없다.
//
// 단점: 이 모델은 영어로만 캡션을 생성한다(한국어 지원 소형 캡셔닝 모델은 브라우저에서
// 돌릴 만한 크기로 마땅한 게 없음). 그래도 Claude가 그 영어 설명만 읽고 한국어로 글을
// 쓰는 데는 전혀 문제없다 — 어차피 사진을 직접 보여주는 것보다 텍스트가 훨씬 싸다.

const MODEL_ID = 'Xenova/vit-gpt2-image-captioning';
const MAX_IMAGE_DIM = 512; // 캡션 생성 목적으론 이 정도 해상도로 충분하고, 추론 속도도 빨라짐

export type ModelLoadProgress = { status: string; file?: string; progress?: number };

let captionerPromise: Promise<any> | null = null;

// 모델을 한 번만 로드해서 재사용한다 (여러 장 연달아 처리할 때 매번 다시 내려받지 않도록).
async function getCaptioner(onProgress?: (p: ModelLoadProgress) => void) {
  if (!captionerPromise) {
    captionerPromise = (async () => {
      const { pipeline, env } = await import('@huggingface/transformers');
      // onnxruntime-web은 기본적으로 SharedArrayBuffer 기반 멀티스레드 WASM을 쓰려고 하는데,
      // 이건 페이지가 크로스오리진 격리(COOP/COEP 헤더)돼 있어야만 동작한다. GitHub Pages는
      // 정적 호스팅이라 그 헤더를 안 붙여주므로, 멀티스레드를 시도하면 모델 로딩이 바로 실패한다
      // (실기기에서 "설명 생성 실패"가 즉시 뜨는 원인). 싱글스레드로 강제해서 우회한다.
      if (env.backends.onnx.wasm) {
        env.backends.onnx.wasm.numThreads = 1;
      }
      return pipeline('image-to-text', MODEL_ID, {
        // transformers.js가 기기별로 자동으로 고르는 기본 dtype이 이 모델 저장소의 4비트
        // 블록 양자화(q4) 디코더 파일과 안 맞아서 "Missing required scale ...
        // DequantizeLinear" 에러로 세션 생성 자체가 실패하는 게 실기기에서 확인됨. 그렇다고
        // fp32(비양자화)로 바꾸니 이번엔 모델이 너무 커서 모바일 브라우저 탭이 메모리 부족으로
        // 죽는 문제("Aw, Snap!")가 생김. q4의 블록 단위 양자화(MatMulNBits)와 달리 q8은 더
        // 단순한 방식(QuantizeLinear/DequantizeLinear + MatMulInteger)이라 그 버그를 피하면서도
        // fp32보다 용량/메모리가 훨씬 작다 — 용량과 안정성의 절충점.
        dtype: 'q8',
        progress_callback: onProgress
          ? (p: any) => onProgress({ status: p.status, file: p.file, progress: p.progress })
          : undefined,
      });
    })().catch((err) => {
      // 실패하면 다음 시도 때 다시 새로 시작할 수 있게 캐시를 비운다 (그대로 두면 이후 모든
      // 호출이 같은 실패한 Promise를 재사용해서 영원히 실패하게 됨).
      captionerPromise = null;
      throw err;
    });
  }
  return captionerPromise;
}

function loadImage(src: string): Promise<HTMLImageElement> {
  return new Promise((resolve, reject) => {
    const img = new Image();
    img.onload = () => resolve(img);
    img.onerror = reject;
    img.src = src;
  });
}

async function fileToResizedDataUrl(file: File): Promise<string> {
  const objectUrl = URL.createObjectURL(file);
  try {
    const img = await loadImage(objectUrl);
    const scale = Math.min(1, MAX_IMAGE_DIM / Math.max(img.naturalWidth, img.naturalHeight));
    const w = Math.max(1, Math.round(img.naturalWidth * scale));
    const h = Math.max(1, Math.round(img.naturalHeight * scale));
    const canvas = document.createElement('canvas');
    canvas.width = w;
    canvas.height = h;
    const ctx = canvas.getContext('2d');
    if (!ctx) throw new Error('canvas 2d context unavailable');
    ctx.drawImage(img, 0, 0, w, h);
    return canvas.toDataURL('image/jpeg', 0.85);
  } finally {
    URL.revokeObjectURL(objectUrl);
  }
}

export async function generateLocalCaption(file: File, onProgress?: (p: ModelLoadProgress) => void): Promise<string> {
  const captioner = await getCaptioner(onProgress);
  const dataUrl = await fileToResizedDataUrl(file);
  const result = await captioner(dataUrl);
  const text = Array.isArray(result) ? result[0]?.generated_text : result?.generated_text;
  if (!text) throw new Error('캡션 생성 결과가 비어있습니다.');
  return text.trim();
}
