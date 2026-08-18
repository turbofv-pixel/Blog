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
      const { pipeline } = await import('@huggingface/transformers');
      return pipeline('image-to-text', MODEL_ID, {
        progress_callback: onProgress
          ? (p: any) => onProgress({ status: p.status, file: p.file, progress: p.progress })
          : undefined,
      });
    })();
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
