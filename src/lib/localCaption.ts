// 사진 설명을 완전히 무료로, 서버/API 호출 없이 브라우저 안에서 생성한다.
// @huggingface/transformers(transformers.js)로 작은 이미지 모델을 브라우저에서 직접 돌린다.
// 모델 파일은 최초 1회 HuggingFace Hub에서 내려받아 브라우저 캐시(Cache Storage)에 저장되고,
// 그 다음부터는 인터넷 없이도 즉시 동작한다. Anthropic API 방식과 달리 사용한 만큼 요금이
// 청구되는 일이 전혀 없다.
//
// 원래는 완전한 문장을 만들어주는 인코더+디코더 캡셔닝 모델(Xenova/vit-gpt2-image-captioning)을
// 썼는데, 그 모델은 인코더/디코더 두 개의 ONNX 세션을 동시에 메모리에 올리고 토큰을 한 개씩
// 순차 생성하는 autoregressive 구조라 메모리 사용량이 크다. 실기기(안드로이드, 메모리가 적은
// 기종)에서 dtype을 여러 조합(q8/fp32/인코더-디코더 분리)으로 바꿔봐도 매번 브라우저 탭이
// 죽는 것("Aw, Snap!")이 확인됐다.
//
// 그래서 훨씬 가벼운 "이미지 분류" 모델(인코더 하나만 쓰고, 문장 생성 루프가 없음)로 바꿨다.
// 완전한 문장 대신 사진에 뭐가 있을 것 같은지 라벨(태그) 목록을 뽑아서 캡션처럼 이어붙인다 —
// 문장형 캡션보다 정보는 거칠지만, Claude가 그 태그 목록만 보고도 글을 쓰는 데는 충분하고,
// 세션이 하나뿐이라 메모리 사용량이 훨씬 작아 모바일에서도 안정적으로 동작한다. 참고로 이
// 모델은 ImageNet 클래스(주로 사물/동물 이름)로 학습돼 있어 사람 자체는 잘 구분하지 못한다 —
// 배경/사물 위주의 태그가 나온다고 보면 된다.

const MODEL_ID = 'Xenova/vit-base-patch16-224';
const MAX_IMAGE_DIM = 448; // 분류 모델 입력은 224px로 리사이즈되지만 원본 비율 보존 여유를 둠
const TOP_K = 5;

export type ModelLoadProgress = { status: string; file?: string; progress?: number };

let classifierPromise: Promise<any> | null = null;

// 모델을 한 번만 로드해서 재사용한다 (여러 장 연달아 처리할 때 매번 다시 내려받지 않도록).
async function getClassifier(onProgress?: (p: ModelLoadProgress) => void) {
  if (!classifierPromise) {
    classifierPromise = (async () => {
      const { pipeline, env } = await import('@huggingface/transformers');
      // onnxruntime-web은 기본적으로 SharedArrayBuffer 기반 멀티스레드 WASM을 쓰려고 하는데,
      // 이건 페이지가 크로스오리진 격리(COOP/COEP 헤더)돼 있어야만 동작한다. GitHub Pages는
      // 정적 호스팅이라 그 헤더를 안 붙여주므로, 멀티스레드를 시도하면 모델 로딩이 바로 실패한다.
      // 싱글스레드로 강제해서 우회한다.
      if (env.backends.onnx.wasm) {
        env.backends.onnx.wasm.numThreads = 1;
      }
      return pipeline('image-classification', MODEL_ID, {
        dtype: 'q8', // 세션이 하나뿐인 분류 모델이라 q8로 충분히 가볍고 안정적이다.
        progress_callback: onProgress
          ? (p: any) => onProgress({ status: p.status, file: p.file, progress: p.progress })
          : undefined,
      });
    })().catch((err) => {
      // 실패하면 다음 시도 때 다시 새로 시작할 수 있게 캐시를 비운다 (그대로 두면 이후 모든
      // 호출이 같은 실패한 Promise를 재사용해서 영원히 실패하게 됨).
      classifierPromise = null;
      throw err;
    });
  }
  return classifierPromise;
}

function loadImage(src: string): Promise<HTMLImageElement> {
  return new Promise((resolve, reject) => {
    const img = new Image();
    img.onload = () => resolve(img);
    // img.onerror는 실패 이유가 담긴 Error가 아니라 브라우저의 raw Event 객체를 넘겨준다.
    // 그대로 reject하면 상위에서 String(event) === "[object Event]"로만 찍혀서 원인을 전혀
    // 알 수 없다(실기기에서 실제로 이렇게 확인됨) — 사람이 읽을 수 있는 Error로 바꿔서 던진다.
    img.onerror = () => reject(new Error('이미지를 불러오지 못했습니다 (지원하지 않는 형식이거나 손상된 파일일 수 있어요).'));
    img.src = src;
  });
}

// <img>로 로드하면 브라우저가 카메라 원본 해상도(수천만 화소) 그대로 압축 해제한 비트맵을
// 먼저 통째로 메모리에 올린 뒤에야 축소할 수 있다 — 실기기(안드로이드)에서 사진마다 예외 없이
// "이미지를 불러오지 못했습니다"로 실패하는 게 확인됐는데, 특정 파일 문제가 아니라 이 축소 전
// 대용량 디코딩 단계에서 메모리가 부족한 것으로 보인다. createImageBitmap의 resize 옵션을
// 쓰면 브라우저가 디코딩과 동시에(또는 그와 가깝게) 축소할 수 있어 피크 메모리가 훨씬 작다.
// 화면에 보여줄 게 아니라 분류 모델에 넣을 용도라 정사각형으로 눌러도 상관없다.
async function fileToResizedDataUrl(file: File): Promise<string> {
  if (typeof createImageBitmap === 'function') {
    try {
      const bitmap = await createImageBitmap(file, {
        resizeWidth: MAX_IMAGE_DIM,
        resizeHeight: MAX_IMAGE_DIM,
        resizeQuality: 'medium',
      });
      try {
        const canvas = document.createElement('canvas');
        canvas.width = bitmap.width;
        canvas.height = bitmap.height;
        const ctx = canvas.getContext('2d');
        if (!ctx) throw new Error('canvas 2d context unavailable');
        ctx.drawImage(bitmap, 0, 0);
        return canvas.toDataURL('image/jpeg', 0.85);
      } finally {
        bitmap.close();
      }
    } catch {
      // createImageBitmap 자체를 지원 안 하거나 실패하는 구형/특수 환경엔 <img> 방식으로 재시도
    }
  }
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
  // 사진 축소를 모델 로딩보다 먼저 해서, 메모리를 많이 잡아먹는 두 단계(대용량 디코딩 ↔ 모델
  // 로딩)가 최대한 겹치지 않게 한다.
  const dataUrl = await fileToResizedDataUrl(file);
  const classifier = await getClassifier(onProgress);
  const results = await classifier(dataUrl, { topk: TOP_K });
  const list: { label: string; score: number }[] = Array.isArray(results) ? results : [results];
  if (list.length === 0) throw new Error('캡션 생성 결과가 비어있습니다.');
  const tags = list
    .filter((r) => r?.label)
    .map((r) => `${r.label}${typeof r.score === 'number' ? ` (${Math.round(r.score * 100)}%)` : ''}`)
    .join(', ');
  if (!tags) throw new Error('캡션 생성 결과가 비어있습니다.');
  return `Likely contains: ${tags}`;
}
