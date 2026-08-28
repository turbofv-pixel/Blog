// GitHub Contents API로 브라우저에서 바로 이 저장소에 커밋하기.
//
// 별도 백엔드 서버 없이 정적 사이트에서 돌아가는 앱이라, 사용자가 넣어준 개인 액세스
// 토큰으로 요청을 브라우저에서 api.github.com으로 바로 보낸다. 토큰은 사용자 브라우저의
// localStorage에만 저장된다 — 사실상 비밀번호와 같으니, 이 저장소 하나에만 쓰기 권한을
// 준 fine-grained 토큰을 쓰길 권장한다(사용하는 컴포넌트 쪽 UI/README에도 명시).

export const GITHUB_OWNER = 'turbofv-pixel';
export const GITHUB_REPO = 'Blog';
export const GITHUB_TOKEN_KEY = 'blogGithubToken';
export const GITHUB_BRANCH_KEY = 'blogGithubBranch';

export function dataUrlToBase64(dataUrl: string): string {
  const idx = dataUrl.indexOf(',');
  return idx >= 0 ? dataUrl.slice(idx + 1) : dataUrl;
}

// 유니코드(한글 등)가 섞인 문자열을 base64로 인코딩 — btoa는 라틴-1 범위만 받아들이므로
// UTF-8 바이트로 먼저 이스케이프한 뒤 인코딩하는 표준 트릭을 쓴다.
export function utf8ToBase64(text: string): string {
  return btoa(unescape(encodeURIComponent(text)));
}

// 이미 브라우저에 있는 파일(File)을 그대로 base64로 읽어들인다 — 처리된 사진을 다시
// 캔버스에 그려 재인코딩하지 않고, 다운로드해둔 파일 바이트를 그대로 커밋할 때 쓴다.
export function fileToBase64(file: File): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(dataUrlToBase64(reader.result as string));
    reader.onerror = reject;
    reader.readAsDataURL(file);
  });
}

// 기존 파일의 디코딩된 텍스트 내용을 가져온다. 파일이 없거나(404) 요청 자체가 실패하면
// null을 돌려준다 — 호출하는 쪽(예: captions.md에 새 항목을 이어 붙이려는 쪽)은 null을
// "아직 파일이 없으니 새로 시작"으로 해석하면 된다.
export async function githubGetFileContent(path: string, token: string, branch: string): Promise<string | null> {
  const url = `https://api.github.com/repos/${GITHUB_OWNER}/${GITHUB_REPO}/contents/${path
    .split('/')
    .map(encodeURIComponent)
    .join('/')}`;
  try {
    const res = await fetch(`${url}?ref=${encodeURIComponent(branch)}`, {
      headers: { Authorization: `Bearer ${token}`, Accept: 'application/vnd.github+json' },
    });
    if (!res.ok) return null;
    const data = await res.json();
    if (typeof data.content !== 'string') return null;
    // GitHub returns base64 with embedded newlines - strip them, then reverse utf8ToBase64's
    // escape/encodeURIComponent trick to get back the original UTF-8 text (한글 등 포함).
    const base64 = data.content.replace(/\n/g, '');
    return decodeURIComponent(escape(atob(base64)));
  } catch {
    return null;
  }
}

export async function githubPutFile(
  path: string,
  contentBase64: string,
  message: string,
  token: string,
  branch: string
): Promise<void> {
  const url = `https://api.github.com/repos/${GITHUB_OWNER}/${GITHUB_REPO}/contents/${path
    .split('/')
    .map(encodeURIComponent)
    .join('/')}`;

  // 이미 있는 파일이면 sha를 같이 보내야 덮어쓰기가 되므로, 먼저 조회해본다.
  let sha: string | undefined;
  try {
    const getRes = await fetch(`${url}?ref=${encodeURIComponent(branch)}`, {
      headers: { Authorization: `Bearer ${token}`, Accept: 'application/vnd.github+json' },
    });
    if (getRes.ok) {
      const data = await getRes.json();
      sha = data.sha;
    }
  } catch {
    // 조회 실패는 무시 — 새 파일이라고 가정하고 진행
  }

  const res = await fetch(url, {
    method: 'PUT',
    headers: {
      Authorization: `Bearer ${token}`,
      Accept: 'application/vnd.github+json',
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({ message, content: contentBase64, branch, ...(sha ? { sha } : {}) }),
  });
  if (!res.ok) {
    let detail = '';
    try {
      const body = await res.json();
      detail = body.message || '';
    } catch {
      // 응답이 JSON이 아니면 그냥 상태 코드만 사용
    }
    throw new Error(`${res.status} ${detail || res.statusText}`);
  }
}
