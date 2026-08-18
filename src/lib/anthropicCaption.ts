// 업로드한 사진을 브라우저에서 바로 Claude API(비전)로 보내 짧은 한글 설명을 자동으로
// 받아온다. 사용자 본인의 Anthropic API 키로, 브라우저에서 api.anthropic.com으로 직접
// 요청한다 — 이 앱은 백엔드 서버가 없는 정적 사이트라 그 방법뿐이다. Anthropic API는
// 기본적으로 브라우저發 요청을 막는데, `anthropic-dangerous-direct-browser-access` 헤더로
// 명시적으로 허용해야 한다(이름 그대로 "위험" 표시가 붙어있는 이유: 키가 페이지 소스/네트워크
// 탭에 노출될 수 있으니, 쓰는 사람이 감수하고 켜는 옵션).

export const ANTHROPIC_API_KEY_STORAGE_KEY = 'blogAnthropicApiKey';

// 캡션 생성엔 정밀한 추론이 필요 없고 속도/비용이 더 중요하므로 가장 가벼운 모델을 쓴다.
const CAPTION_MODEL = 'claude-haiku-4-5-20251001';
const MAX_IMAGE_DIM = 1024; // 이 정도면 캡션 생성엔 충분하고, 업로드/응답 속도도 빠르다.

function loadImage(src: string): Promise<HTMLImageElement> {
  return new Promise((resolve, reject) => {
    const img = new Image();
    img.onload = () => resolve(img);
    img.onerror = reject;
    img.src = src;
  });
}

// 캡션 API로 보내기 전에 리사이즈 + JPEG 재인코딩 — 원본 그대로 보내면 페이로드가 크고
// 느려지는데, 캡션 생성 목적으로는 이 정도 해상도로도 충분하다.
async function fileToResizedBase64(file: File): Promise<{ base64: string; mediaType: string }> {
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
    const dataUrl = canvas.toDataURL('image/jpeg', 0.85);
    return { base64: dataUrl.slice(dataUrl.indexOf(',') + 1), mediaType: 'image/jpeg' };
  } finally {
    URL.revokeObjectURL(objectUrl);
  }
}

export async function generatePhotoCaption(file: File, apiKey: string): Promise<string> {
  const { base64, mediaType } = await fileToResizedBase64(file);

  const res = await fetch('https://api.anthropic.com/v1/messages', {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      'x-api-key': apiKey,
      'anthropic-version': '2023-06-01',
      'anthropic-dangerous-direct-browser-access': 'true',
    },
    body: JSON.stringify({
      model: CAPTION_MODEL,
      max_tokens: 200,
      messages: [
        {
          role: 'user',
          content: [
            { type: 'image', source: { type: 'base64', media_type: mediaType, data: base64 } },
            {
              type: 'text',
              text:
                '이 사진에 뭐가 보이는지 블로그 글 작성 참고용으로 한국어 한두 문장으로 짧게 설명해줘. ' +
                '인물이 있으면 "아이", "엄마" 등으로만 구분하고 외모는 묘사하지 마. ' +
                '다른 말 없이 설명 문장만 답해줘.',
            },
          ],
        },
      ],
    }),
  });

  if (!res.ok) {
    let detail = '';
    try {
      const body = await res.json();
      detail = body.error?.message || '';
    } catch {
      // 응답이 JSON이 아니면 그냥 상태 코드만 사용
    }
    throw new Error(`${res.status} ${detail || res.statusText}`);
  }

  const data = await res.json();
  const text = data.content?.find((c: any) => c.type === 'text')?.text;
  if (!text) throw new Error('응답에서 설명 텍스트를 찾지 못했습니다.');
  return text.trim();
}
