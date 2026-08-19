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
// 모델이 실제로 받는 입력은 224px뿐이라, 그보다 큰 중간 이미지를 만들 이유가 없다. 처음
// 자동 생성 땐 성공했는데 모델이 이미 메모리에 캐시된 뒤 개별 재생성 버튼으로 다시 시도하면
// 실패하는 게 실기기에서 확인됐다 — 모델이 이미 메모리를 쓰고 있는 상태에서는 디코딩용
// 여유가 더 적다는 뜻이라, 중간 이미지 크기를 최대한 줄인다. 그래도 실패하면 더 작은 크기로
// 한 번 더 시도한다.
const RESIZE_ATTEMPTS = [224, 160, 96];
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
    img.onerror = () => reject(new Error('<img> 디코딩 실패'));
    img.src = src;
  });
}

// 파일의 처음 몇 바이트(매직 넘버)로 실제 이미지 포맷을 알아낸다. 확장자가 .jpg여도 안드로이드
// 카메라가 "고효율" 설정으로 실제로는 HEIC/HEIF로 저장하는 경우가 흔한데, 크롬 안드로이드는
// HEIC를 <img>/createImageBitmap 어느 쪽으로도 디코딩하지 못한다 — 크기(resize 옵션)를
// 224→160→96으로 줄여도 매번 똑같이 실패하는 게 실기기에서 확인됐는데, 이건 메모리 문제라면
// 나올 수 없는 패턴이라(크기를 줄였는데도 무조건 실패) 포맷 자체가 안 맞는 쪽에 무게가 실린다.
// 이 함수는 그 여부를 실패 메시지에 정확히 남겨서 다음 진단에 추측이 필요 없게 한다.
async function detectImageFormat(file: File): Promise<string> {
  try {
    const buf = await file.slice(0, 16).arrayBuffer();
    const b = new Uint8Array(buf);
    if (b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff) return 'JPEG';
    if (b[0] === 0x89 && b[1] === 0x50 && b[2] === 0x4e && b[3] === 0x47) return 'PNG';
    if (b[0] === 0x52 && b[1] === 0x49 && b[2] === 0x46 && b[3] === 0x46) return 'RIFF/WebP';
    if (b[4] === 0x66 && b[5] === 0x74 && b[6] === 0x79 && b[7] === 0x70) {
      // ftyp 박스 — ISO base media file format(HEIC/HEIF, AVIF, MP4 등)
      const brand = String.fromCharCode(b[8], b[9], b[10], b[11]);
      return `ftyp/${brand}`;
    }
    return `알수없음(${Array.from(b.slice(0, 4)).map((n) => n.toString(16).padStart(2, '0')).join(' ')})`;
  } catch {
    return '알수없음(읽기 실패)';
  }
}

// <img>로 로드하면 브라우저가 카메라 원본 해상도(수천만 화소) 그대로 압축 해제한 비트맵을
// 먼저 통째로 메모리에 올린 뒤에야 축소할 수 있다. createImageBitmap의 resize 옵션을 쓰면
// 브라우저가 디코딩과 동시에(또는 그와 가깝게) 축소할 수 있어 피크 메모리가 훨씬 작다. 화면에
// 보여줄 게 아니라 분류 모델에 넣을 용도라 정사각형으로 눌러도 상관없다.
async function fileToResizedDataUrl(file: File, maxDim: number): Promise<string> {
  let bitmapErr: unknown;
  if (typeof createImageBitmap === 'function') {
    try {
      const bitmap = await createImageBitmap(file, {
        resizeWidth: maxDim,
        resizeHeight: maxDim,
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
    } catch (err) {
      // createImageBitmap 자체를 지원 안 하거나 실패하는 환경엔 <img> 방식으로 재시도 —
      // 다만 이 에러도 기억해뒀다가, <img>까지 실패하면 최종 에러 메시지에 같이 남긴다.
      bitmapErr = err;
    }
  }
  const objectUrl = URL.createObjectURL(file);
  try {
    const img = await loadImage(objectUrl);
    const scale = Math.min(1, maxDim / Math.max(img.naturalWidth, img.naturalHeight));
    const w = Math.max(1, Math.round(img.naturalWidth * scale));
    const h = Math.max(1, Math.round(img.naturalHeight * scale));
    const canvas = document.createElement('canvas');
    canvas.width = w;
    canvas.height = h;
    const ctx = canvas.getContext('2d');
    if (!ctx) throw new Error('canvas 2d context unavailable');
    ctx.drawImage(img, 0, 0, w, h);
    return canvas.toDataURL('image/jpeg', 0.85);
  } catch (imgErr) {
    const format = await detectImageFormat(file);
    if (/^ftyp\/(heic|heix|heif|hevc|hevx|mif1|msf1)$/i.test(format)) {
      // 크롬 안드로이드는 HEIC/HEIF를 <img>/createImageBitmap 어느 쪽으로도 디코딩하지 못한다.
      // 확장자가 .jpg여도 휴대폰 카메라의 "고효율 사진" 설정 때문에 실제로는 HEIC로 저장되는
      // 경우가 흔해서, 이 경우엔 사람이 바로 조치할 수 있는 안내로 바꿔서 던진다.
      throw new Error(
        '이 사진은 HEIC/HEIF 형식이라 이 브라우저에서 지원되지 않아요. 휴대폰 카메라 설정에서 "고효율 사진(HEIF)"을 끄고 표준 JPEG로 저장하도록 바꾼 뒤 다시 찍은 사진으로 시도해보세요.',
      );
    }
    const bitmapMsg = bitmapErr instanceof Error ? bitmapErr.message : bitmapErr ? String(bitmapErr) : '(시도 안 함)';
    const imgMsg = imgErr instanceof Error ? imgErr.message : String(imgErr);
    throw new Error(
      `이미지를 불러오지 못했습니다 (감지된 형식: ${format} / createImageBitmap: ${bitmapMsg} / img: ${imgMsg})`,
    );
  } finally {
    URL.revokeObjectURL(objectUrl);
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => {
    setTimeout(resolve, ms);
  });
}

// 크기를 줄여가며, 또 크기마다 약간의 대기 후 재시도한다. 사진 여러 장을 한꺼번에 선택해서
// 연달아 빠르게 읽으면(자동 일괄 생성) 상당수가 "파일을 읽지 못함"으로 실패하는 게 실기기에서
// 확인됐다 — 특정 파일이나 해상도 문제가 아니라(같은 배치에서 일부는 성공, 대부분은 실패)
// 안드로이드 쪽 파일 접근이 순간적으로 밀리는 것으로 보인다. 즉시 재시도보다 잠깐 쉬었다
// 재시도하는 쪽이 이런 일시적 문제에는 더 효과적이다.
async function fileToResizedDataUrlWithRetry(file: File): Promise<string> {
  let lastErr: unknown;
  for (const dim of RESIZE_ATTEMPTS) {
    for (let attempt = 0; attempt < 2; attempt++) {
      try {
        // eslint-disable-next-line no-await-in-loop
        return await fileToResizedDataUrl(file, dim);
      } catch (err) {
        lastErr = err;
        // eslint-disable-next-line no-await-in-loop
        await sleep(400 * (attempt + 1));
      }
    }
  }
  throw lastErr instanceof Error ? lastErr : new Error(String(lastErr));
}

// 원본 File을 축소된 data URL로 바꾼다 — 이 단계만 원본 파일 바이트를 실제로 읽는다.
// 호출한 쪽에서 결과를 캐싱해두면, 같은 사진을 다시 분석할 때(예: "다시 생성" 버튼) 이
// 함수를 또 부를 필요가 없다. 실기기에서 첫 번째 자동 분석(파일 선택 직후)은 성공하는데
// 나중에 같은 File을 또 읽으려 하면("다시 생성" 버튼) 디코딩은커녕 파일 바이트 자체를 못
// 읽는 경우가 확인됐다 — 안드로이드의 사진 선택기가 넘겨준 File의 접근 권한이 일회성/시간
// 제한적일 수 있다는 뜻으로 보인다. 그래서 원본 파일은 최초 1회만 읽고, 그 결과(축소된
// data URL)를 재사용하는 게 유일한 안정적인 방법이다.
export async function resizeImageForCaption(file: File): Promise<string> {
  return fileToResizedDataUrlWithRetry(file);
}

// 이미 축소돼 있는 data URL에 대해서만 분류를 돌린다 — 원본 File을 다시 건드리지 않는다.
export async function classifyResizedImage(dataUrl: string, onProgress?: (p: ModelLoadProgress) => void): Promise<string> {
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

export async function generateLocalCaption(file: File, onProgress?: (p: ModelLoadProgress) => void): Promise<string> {
  // 사진 축소를 모델 로딩보다 먼저 해서, 메모리를 많이 잡아먹는 두 단계(대용량 디코딩 ↔ 모델
  // 로딩)가 최대한 겹치지 않게 한다.
  const dataUrl = await resizeImageForCaption(file);
  return classifyResizedImage(dataUrl, onProgress);
}
