import React, { useState } from 'react';
import { Upload, Github, Eye, EyeOff, X, RefreshCw, ClipboardPaste, Sparkles } from 'lucide-react';
import { GITHUB_BRANCH_KEY, GITHUB_TOKEN_KEY, fileToBase64, githubPutFile, utf8ToBase64 } from '../lib/githubUpload';
import { ANTHROPIC_API_KEY_STORAGE_KEY, generatePhotoCaptionFromBuffer } from '../lib/anthropicCaption';
import { resizeBufferForCaption, classifyResizedImage } from '../lib/localCaption';
import { getPhotoTimestampFromBuffer, formatPhotoTimestamp } from '../lib/photoMeta';

type CaptionMode = 'local' | 'anthropic';

// 사진(원본이든, 토끼 모자이크 스튜디오에서 처리해서 다운로드해둔 것이든)에 설명 메모를
// 붙여서 이 저장소에 커밋한다. 모자이크/얼굴 인식 로직과는 완전히 무관 — 그냥 "파일 + 글자"를
// GitHub에 올리는 도구다.
//
// 기본은 사진 자체는 업로드하지 않고 설명 메모(captions.md)만 커밋한다 — 얼굴이 그대로 보이는
// 원본 사진을 미리 캡션 붙이기용으로 여기 올려도, 모자이크 처리 전까지는 저장소에 사진이 절대
// 올라가지 않는다는 뜻. 나중에 모자이크 처리를 끝낸 뒤 "사진도 같이 올리기"를 켜고 다시
// 올리면 그때 실제 파일이 커밋된다.

interface UploadItem {
  id: string;
  file: File;
  objectUrl: string;
  caption: string;
  // AI(로컬 태그 또는 Anthropic)가 채운 caption과는 별개로, 사용자가 직접 덧붙이는 메모.
  // AI 태그만으로는 정보가 부족할 수 있어서(특히 무료 로컬 모드는 거친 영어 태그만 나옴)
  // 둘 다 따로 입력해서 같이 업로드할 수 있게 한다.
  userNote: string;
  // 원본 File 전체를 통째로 읽은 바이트 — 배치당 딱 한 번만 읽어서 캐싱해둔다. 실기기(특히
  // 구글 포토에서 다운로드한 사진)에서, 같은 File을 서로 다른 API로 두 번째 건드리면(예:
  // EXIF 읽기 한 번, 그 다음 이미지 리사이즈/AI 캡션용 인코딩 한 번을 따로) 두 번째 접근부터
  // "파일을 읽지 못함"으로 실패하는 게 반복 확인됐다 — 그 File이 가리키는 스트림이 한 번만
  // 유효한 것으로 보인다. 그래서 촬영 시각 추출과 이미지 리사이즈(로컬/Anthropic 모드 모두)
  // 전부 이 캐시된 버퍼에서 처리하고, 원본 File은 다시 읽지 않는다.
  rawBuffer?: ArrayBuffer;
  // 무료(로컬) 모드로 한 번 축소에 성공한 사진의 결과(data URL) 캐시.
  localResizedDataUrl?: string;
  // 사진이 실제로 찍힌 시각(EXIF, 없으면 파일 수정 시각으로 대체) — ISO 문자열로 저장해서
  // captions.md에 같이 올리고, 정렬 기준으로도 쓴다. undefined = 아직 추출 시도 전,
  // null = 시도했지만 못 찾음(재시도 안 함).
  capturedAt?: string | null;
  capturedAtSource?: 'exif' | 'file-modified';
}

const uid = () => Math.random().toString(36).slice(2) + Date.now().toString(36);

// 캐치한 에러가 항상 Error 인스턴스인 건 아니다 — 브라우저 API 중에는 실패 이유 대신 raw
// Event 객체를 던지는 것들이 있어서(예: <img>의 onerror), 그걸 그냥 String()으로 찍으면
// "[object Event]"처럼 아무 정보도 없는 문자열이 된다(실기기 디버깅 중 실제로 겪은 문제).
// 최대한 사람이 읽을 수 있는 문자열로 뽑아낸다.
function describeError(err: unknown): string {
  if (err instanceof Error) return err.message;
  if (typeof err === 'string') return err;
  if (err && typeof err === 'object') {
    const anyErr = err as any;
    if (typeof anyErr.message === 'string' && anyErr.message) return anyErr.message;
    if (anyErr.error instanceof Error) return anyErr.error.message;
    if (typeof anyErr.type === 'string') {
      const target = anyErr.target;
      const targetInfo = target?.src || target?.currentSrc || target?.tagName;
      return `이벤트: ${anyErr.type}${targetInfo ? ` (${targetInfo})` : ''}`;
    }
  }
  return String(err);
}

export const GithubPhotoUploader: React.FC = () => {
  const [items, setItems] = useState<UploadItem[]>([]);
  const [bulkPasteText, setBulkPasteText] = useState<string>('');
  const [token, setToken] = useState<string>(() => localStorage.getItem(GITHUB_TOKEN_KEY) || '');
  const [branch, setBranch] = useState<string>(() => localStorage.getItem(GITHUB_BRANCH_KEY) || 'master');
  const [folder, setFolder] = useState<string>('');
  const [uploadPhotos, setUploadPhotos] = useState<boolean>(false);
  const [showToken, setShowToken] = useState<boolean>(false);
  const [uploading, setUploading] = useState<boolean>(false);
  const [uploadedCount, setUploadedCount] = useState<number>(0);
  const [status, setStatus] = useState<string | null>(null);

  // --- AI로 사진 설명 자동 생성 ---
  // 기본은 'local' — 문장형 캡셔닝 모델(인코더+디코더 두 세션, autoregressive 생성)은 실기기
  // (안드로이드)에서 메모리 부족으로 계속 탭이 죽어서, 세션이 하나뿐인 훨씬 가벼운 이미지 분류
  // 모델(태그 목록 방식, localCaption.ts 참고)로 바꿨다. 유료 API 없이 모바일에서도 안정적으로
  // 쓸 수 있는 걸 우선하기 위한 선택.
  const [captionMode, setCaptionMode] = useState<CaptionMode>('local');
  const [anthropicKey, setAnthropicKey] = useState<string>(() => localStorage.getItem(ANTHROPIC_API_KEY_STORAGE_KEY) || '');
  const [showAnthropicKey, setShowAnthropicKey] = useState<boolean>(false);
  const [aiGeneratingIds, setAiGeneratingIds] = useState<Set<string>>(new Set());
  const [aiStatus, setAiStatus] = useState<string | null>(null);

  const handleAnthropicKeyChange = (value: string) => {
    setAnthropicKey(value);
    localStorage.setItem(ANTHROPIC_API_KEY_STORAGE_KEY, value);
  };

  const handleClearAnthropicKey = () => {
    setAnthropicKey('');
    localStorage.removeItem(ANTHROPIC_API_KEY_STORAGE_KEY);
  };

  // 한 장 설명 생성 — 성공하면 그 항목의 caption을 채우고 null(에러 없음)을, 실패하면 에러
  // 메시지 문자열을 반환한다 (여러 장 순회할 때 실패 개수/마지막 에러 내용을 모으는 데 씀).
  // mode='local'이면 브라우저 안에서 무료로(키 불필요), mode='anthropic'이면 API 키로 처리한다.
  // item 전체(단순 id/file이 아니라)를 받는 이유: 로컬 모드에서 이미 축소해둔 사진(캐시)이
  // 있으면 그걸 재사용해야 하는데, 그 캐시가 item에 붙어있기 때문이다.
  const generateCaptionFor = async (item: UploadItem, mode: CaptionMode, key: string): Promise<string | null> => {
    setAiGeneratingIds((prev) => new Set(prev).add(item.id));
    try {
      let caption: string;
      if (mode === 'local') {
        // 원본 File은 최초 1회만 읽는다 — 실기기에서 같은 File을 두 번째로 읽으려 하면(예:
        // "다시 생성" 버튼) 파일 바이트 자체를 못 읽는 경우가 확인됐다. 이미 축소해둔 결과이
        // 있으면 그걸 재사용하고, 없으면 캐싱해둔 rawBuffer(있어야 정상 — preloadFileMetadata가
        // 먼저 돈다)로 리사이즈한다. rawBuffer조차 없는 예외적인 경우에만 최후의 수단으로
        // 원본 File을 직접 읽는다.
        let dataUrl = item.localResizedDataUrl;
        if (!dataUrl) {
          dataUrl = item.rawBuffer
            ? await resizeBufferForCaption(item.rawBuffer, item.file.type)
            : await resizeBufferForCaption(await item.file.arrayBuffer(), item.file.type);
          const resolvedDataUrl = dataUrl;
          setItems((prev) => prev.map((it) => (it.id === item.id ? { ...it, localResizedDataUrl: resolvedDataUrl } : it)));
        }
        caption = await classifyResizedImage(dataUrl, (p) => {
          const pct = typeof p.progress === 'number' ? ` ${Math.round(p.progress)}%` : '';
          setAiStatus(`모델 준비 중(최초 1회만, 이후엔 인터넷 없이도 즉시 실행)... ${p.file || p.status}${pct}`);
        });
      } else {
        const buf = item.rawBuffer || (await item.file.arrayBuffer());
        caption = await generatePhotoCaptionFromBuffer(buf, item.file.type, key);
      }
      setItems((prev) => prev.map((it) => (it.id === item.id ? { ...it, caption } : it)));
      return null;
    } catch (err: any) {
      const message = describeError(err);
      setAiStatus(`❌ ${item.file.name} 설명 생성 실패: ${message}`);
      return message;
    } finally {
      setAiGeneratingIds((prev) => {
        const next = new Set(prev);
        next.delete(item.id);
        return next;
      });
    }
  };

  const handleGenerateOneCaption = (item: UploadItem) => {
    if (captionMode === 'anthropic') {
      const key = anthropicKey.trim();
      if (!key) {
        setAiStatus('❌ Anthropic API 키를 먼저 입력해주세요.');
        return;
      }
      setAiStatus(null);
      generateCaptionFor(item, 'anthropic', key);
    } else {
      setAiStatus(null);
      generateCaptionFor(item, 'local', '');
    }
  };

  const handleGenerateAllCaptions = async (targetItems: UploadItem[]) => {
    let key = '';
    if (captionMode === 'anthropic') {
      key = anthropicKey.trim();
      if (!key) {
        setAiStatus('❌ Anthropic API 키를 먼저 입력해주세요.');
        return;
      }
    }
    if (targetItems.length === 0) return;
    setAiStatus(null);
    let fails = 0;
    let lastError: string | null = null;
    for (const it of targetItems) {
      setAiStatus(
        captionMode === 'local'
          ? `(${targetItems.indexOf(it) + 1}/${targetItems.length}) ${it.file.name} 분석 중...`
          : `AI가 사진을 분석하는 중... (${targetItems.indexOf(it) + 1}/${targetItems.length}) ${it.file.name}`
      );
      // 로컬 모드는 이 시점에 이미 preloadLocalImages로 원본 File을 다 읽어서 축소본을
      // 캐싱해둔 상태라(startGeneratingCaptions 참고), 여기서는 원본 파일을 다시 건드리지
      // 않는다 — 그래서 파일 접근 타이밍을 신경 쓸 필요가 없다.
      // eslint-disable-next-line no-await-in-loop
      const error = await generateCaptionFor(it, captionMode, key);
      if (error) {
        fails++;
        lastError = error;
      }
    }
    setAiStatus(
      fails === 0
        ? `✨ 사진 ${targetItems.length}장 설명 자동 생성 완료! 내용 확인하고 필요하면 수정해주세요.`
        : `⚠️ ${targetItems.length - fails}장 성공, ${fails}장 실패했어요. (${lastError})`
    );
  };

  // 실기기(안드로이드)에서 정확한 브라우저 에러를 확인했다: "The requested file could not be
  // read, typically due to permission problems that have occurred after a reference to a
  // file was acquired." — 안드로이드 사진 선택기가 넘겨준 파일 접근 권한이 일정 시간 뒤
  // 만료된다는 뜻이다. 사진을 하나씩 순서대로(그 사이 EXIF 파싱/이미지 리사이즈 같은 계산도
  // 끼워서) 읽으면, 배치 뒤쪽 사진일수록 그 시간 제한에 걸릴 위험이 커진다 — 실제로 7장 중
  // 마지막 사진에서 실패가 재현됐다. 그래서 원본 File 바이트 읽기(file.arrayBuffer())만
  // 시간에 민감한 작업으로 분리해서, 선택 즉시 배치 전체를 동시에(Promise.all) 읽어 전체
  // 소요 시간을 최소화한다. 그 이후(EXIF 파싱, 이미지 리사이즈)는 이미 메모리에 있는 버퍼로만
  // 처리하는 순수 계산이라 파일 접근 시간 제한과 완전히 무관해진다. 촬영 시각은 캡션 모드와
  // 무관하게 항상 뽑는다(사진 시간대별로 글을 쓸 수 있게 하기 위한 메타정보).
  const preloadFileMetadata = async (targetItems: UploadItem[], includeResize: boolean): Promise<UploadItem[]> => {
    let working = targetItems.map((it) => ({ ...it }));
    const total = working.length;

    // 1단계: 원본 File 바이트를 배치 전체 동시에 읽는다. 실패한 것만 모아 잠깐 쉬었다가
    // 다시 동시에 재시도(최대 3라운드) — 권한이 일시적으로 회복될 수도 있어서.
    for (let round = 0; round < 3; round++) {
      const pending = working.filter((it) => !it.rawBuffer);
      if (pending.length === 0) break;
      if (round > 0) {
        setAiStatus(`일부 사진을 다시 불러오는 중... (${pending.length}장 남음)`);
        // eslint-disable-next-line no-await-in-loop
        await new Promise((resolve) => setTimeout(resolve, 800));
      } else {
        setAiStatus(`사진 ${total}장 불러오는 중...`);
      }
      // eslint-disable-next-line no-await-in-loop
      const results = await Promise.allSettled(pending.map((it) => it.file.arrayBuffer()));
      working = working.map((it) => {
        const idx = pending.findIndex((p) => p.id === it.id);
        if (idx === -1) return it;
        const r = results[idx];
        return r.status === 'fulfilled' ? { ...it, rawBuffer: r.value } : it;
      });
    }

    // 2단계: 여기부터는 원본 File을 더 이상 건드리지 않는다 — 캐싱된 버퍼에서 촬영 시각을
    // 뽑고, 필요하면 이미지도 리사이즈한다(순수 계산이라 순서대로 처리해도 시간 제한과 무관).
    for (const it of working) {
      if (!it.rawBuffer) continue; // 1단계에서 끝내 못 읽음 — 캡션 생성 단계에서 에러로 표시됨
      if (it.capturedAt !== undefined && (!includeResize || it.localResizedDataUrl)) continue;
      setAiStatus(`사진 정보 처리 중... ${it.file.name}`);
      const patch: Partial<UploadItem> = {};
      if (it.capturedAt === undefined) {
        const ts = getPhotoTimestampFromBuffer(it.rawBuffer, it.file.lastModified);
        patch.capturedAt = ts ? ts.date.toISOString() : null;
        patch.capturedAtSource = ts?.source;
      }
      if (includeResize && !it.localResizedDataUrl) {
        try {
          // eslint-disable-next-line no-await-in-loop
          patch.localResizedDataUrl = await resizeBufferForCaption(it.rawBuffer, it.file.type);
        } catch {
          // 순수 디코딩 실패(형식 문제 등) — 이후 캡션 생성 단계에서 에러로 남는다
        }
      }
      working = working.map((w) => (w.id === it.id ? { ...w, ...patch } : w));
    }
    return working;
  };

  // 캡션 생성을 시작하는 단일 진입점 — 자동 트리거(파일 선택 직후)와 수동 "전체 사진 AI로
  // 설명 생성" 버튼 둘 다 이걸 거치게 해서, 촬영 시각(+로컬 모드면 축소본)을 항상 먼저
  // preloadFileMetadata로 캐싱해둔 뒤에 실제 캡션 생성으로 넘어가게 한다(어느 경로로
  // 시작하든 캐시 없이 원본 File을 늦게 읽으려다 다시 같은 문제가 재현되는 걸 막는다).
  const startGeneratingCaptions = (targetItems: UploadItem[]) => {
    preloadFileMetadata(targetItems, captionMode === 'local').then((preloaded) => {
      setItems((prev) => prev.map((p) => preloaded.find((u) => u.id === p.id) || p));
      handleGenerateAllCaptions(preloaded);
    });
  };

  const handleFilesChange = (e: React.ChangeEvent<HTMLInputElement>) => {
    const files = Array.from(e.target.files || []);
    if (files.length === 0) return;
    items.forEach((it) => URL.revokeObjectURL(it.objectUrl));
    const newItems: UploadItem[] = files.map((f) => ({ id: uid(), file: f, objectUrl: URL.createObjectURL(f), caption: '', userNote: '' }));
    setItems(newItems);
    setStatus(null);
    setAiStatus(null);
    e.target.value = '';
    // 촬영 시각은 AI 캡션 모드/키 여부와 완전히 무관하게 사진을 선택하는 즉시 항상 뽑는다
    // (사진 시간대별로 글을 쓸 수 있게 하기 위한 메타정보). AI 캡션 자동 생성은 로컬 모드는
    // 키가 필요 없으니 항상, Anthropic 모드는 키가 저장돼 있을 때만 이어서 시작 — 어느 쪽이든
    // 같은 파일 접근 한 번 안에서 촬영 시각(+필요하면 축소본까지) 같이 뽑아서 원본 File을
    // 다시 읽는 일이 없게 한다.
    const willAutoGenerate = captionMode === 'local' || Boolean(anthropicKey.trim());
    preloadFileMetadata(newItems, willAutoGenerate && captionMode === 'local').then((preloaded) => {
      setItems(preloaded);
      if (willAutoGenerate) {
        handleGenerateAllCaptions(preloaded);
      }
    });
  };

  const handleCaptionChange = (id: string, caption: string) => {
    setItems((prev) => prev.map((it) => (it.id === id ? { ...it, caption } : it)));
  };

  const handleUserNoteChange = (id: string, userNote: string) => {
    setItems((prev) => prev.map((it) => (it.id === id ? { ...it, userNote } : it)));
  };

  const handleRemoveItem = (id: string) => {
    setItems((prev) => {
      const removed = prev.find((it) => it.id === id);
      if (removed) URL.revokeObjectURL(removed.objectUrl);
      return prev.filter((it) => it.id !== id);
    });
  };

  // 다른 도구(토끼 모자이크 스튜디오의 "사진 설명 전체 복사" 등)에서 "1. 파일명 — 설명"
  // 형식으로 복사해온 텍스트를 붙여넣으면, 파일명이 일치하는 항목에 각 설명을 자동으로
  // 채워준다. 파일명이 하나라도 안 맞으면 업로드 순서대로 한 줄씩 대응시킨다.
  const applyBulkCaptions = () => {
    const lines = bulkPasteText
      .split('\n')
      .map((l) => l.trim())
      .filter(Boolean);
    if (lines.length === 0) return;

    const parsed = lines.map((line) => {
      const m = line.match(/^\d+\.\s*(\S+)\s*[—-]\s*(.*)$/);
      const caption = (m ? m[2] : line).trim();
      return { filename: m ? m[1] : null, caption: caption === '(설명 없음)' ? '' : caption };
    });

    const allMatchByName = parsed.length === items.length && parsed.every((p) => p.filename && items.some((it) => it.file.name === p.filename));

    setItems((prev) =>
      prev.map((it, i) => {
        if (allMatchByName) {
          const p = parsed.find((p) => p.filename === it.file.name);
          return p ? { ...it, caption: p.caption } : it;
        }
        return parsed[i] ? { ...it, caption: parsed[i].caption } : it;
      })
    );
    setBulkPasteText('');
  };

  const handleClearToken = () => {
    setToken('');
    localStorage.removeItem(GITHUB_TOKEN_KEY);
  };

  // 촬영 시각이 있는 사진은 그 시각순으로 정렬해서 올린다 — Claude가 파일 순서만 봐도 그날의
  // 시간 흐름(오전에 뭘 했고, 오후에 뭘 했는지)대로 글을 쓸 수 있게 하기 위함. 촬영 시각을
  // 못 찾은 사진은 뒤로 보낸다.
  const buildCaptionsText = () => {
    const sorted = [...items].sort((a, b) => {
      if (!a.capturedAt && !b.capturedAt) return 0;
      if (!a.capturedAt) return 1;
      if (!b.capturedAt) return -1;
      return a.capturedAt.localeCompare(b.capturedAt);
    });
    return sorted
      .map((it, i) => {
        const lines = [`${i + 1}. ${it.file.name}`];
        if (it.capturedAt) {
          const label = it.capturedAtSource === 'exif' ? '촬영 시각' : '촬영 시각(추정 — 사진 파일의 수정 시각 기준)';
          lines.push(`   ${label}: ${formatPhotoTimestamp(new Date(it.capturedAt))}`);
        }
        if (it.caption.trim()) lines.push(`   AI 태그: ${it.caption.trim()}`);
        if (it.userNote.trim()) lines.push(`   직접 메모: ${it.userNote.trim()}`);
        if (!it.caption.trim() && !it.userNote.trim()) lines.push('   (설명 없음)');
        return lines.join('\n');
      })
      .join('\n\n');
  };

  const handleUpload = async () => {
    const tok = token.trim();
    const folderPath = folder.trim().replace(/^\/+|\/+$/g, '');
    if (!tok) {
      setStatus('❌ GitHub 토큰을 먼저 입력해주세요.');
      return;
    }
    if (!folderPath) {
      setStatus('❌ 저장할 폴더 이름을 입력해주세요 (예: ansan-family-outing-2).');
      return;
    }
    if (items.length === 0) {
      setStatus('❌ 올릴 사진을 먼저 선택해주세요.');
      return;
    }

    localStorage.setItem(GITHUB_TOKEN_KEY, tok);
    localStorage.setItem(GITHUB_BRANCH_KEY, branch);

    setUploading(true);
    setUploadedCount(0);
    setStatus(null);

    let ok = 0;
    if (uploadPhotos) {
      for (const item of items) {
        setStatus(`업로드 중... (${ok + 1}/${items.length}) ${item.file.name}`);
        try {
          // eslint-disable-next-line no-await-in-loop
          const base64 = await fileToBase64(item.file);
          // eslint-disable-next-line no-await-in-loop
          await githubPutFile(`public/images/${folderPath}/${item.file.name}`, base64, `사진 추가: ${item.file.name}`, tok, branch);
          ok++;
          setUploadedCount(ok);
        } catch (err: any) {
          setStatus(`❌ ${item.file.name} 업로드 실패: ${err.message || err} — 토큰 권한/폴더명을 확인해주세요.`);
          setUploading(false);
          return;
        }
      }
    }

    setStatus('업로드 중... 설명 메모(captions.md)');
    try {
      await githubPutFile(`public/images/${folderPath}/captions.md`, utf8ToBase64(buildCaptionsText()), '사진 설명 메모 추가', tok, branch);
    } catch (err: any) {
      setUploading(false);
      setStatus(
        uploadPhotos
          ? `⚠️ 사진 ${ok}장은 올라갔지만 설명 메모 업로드는 실패했어요: ${err.message || err}`
          : `❌ 설명 메모 업로드 실패: ${err.message || err} — 토큰 권한/폴더명을 확인해주세요.`
      );
      return;
    }

    setUploading(false);
    setStatus(
      (uploadPhotos ? `✨ 사진 ${ok}장 + 설명 메모` : '✨ 설명 메모') +
        ` GitHub에 업로드 완료! (public/images/${folderPath}/, "${branch}" 브랜치) ` +
        `이제 Claude한테 "${folderPath} 폴더${uploadPhotos ? ' 사진으로' : ' 설명으로'} 글 써줘"라고 말해보세요.`
    );
  };

  return (
    <div className="glass-panel animate-fade-in" style={{ padding: '28px', marginBottom: '24px' }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: '12px', marginBottom: '20px' }}>
        <div style={{ background: 'rgba(3, 199, 90, 0.15)', padding: '12px', borderRadius: '12px' }}>
          <Github size={28} color="#03C75A" />
        </div>
        <div>
          <h2 style={{ fontSize: '1.4rem', fontWeight: 700 }}>설명 메모 + 사진 GitHub 업로드</h2>
          <p style={{ color: 'var(--text-muted)', fontSize: '0.9rem' }}>
            원본 사진이든 토끼 모자이크 스튜디오에서 처리해서 다운로드해둔 사진이든, 설명 메모와 함께 이 저장소에
            올려요. 얼굴 인식이나 모자이크 처리는 여기서 하지 않아요. <strong>기본은 사진은 안 올리고 설명 메모만
            커밋</strong>돼요 — 얼굴이 그대로 보이는 원본을 캡션만 붙이는 용도로 올려도 저장소에는 사진이 절대
            올라가지 않아요. 모자이크 처리를 끝낸 뒤 "사진도 같이 올리기"를 켜고 다시 올리면 그때 실제 파일이
            커밋돼요.
          </p>
        </div>
      </div>

      {items.length === 0 ? (
        <label
          style={{
            display: 'block',
            border: '2px dashed rgba(3, 199, 90, 0.4)',
            borderRadius: '16px',
            padding: '36px 20px',
            textAlign: 'center',
            background: 'rgba(3, 199, 90, 0.03)',
            cursor: 'pointer',
          }}
        >
          <input type="file" accept="image/*" multiple onChange={handleFilesChange} style={{ display: 'none' }} />
          <Upload size={28} color="#03C75A" style={{ marginBottom: '8px' }} />
          <div style={{ fontSize: '1rem', fontWeight: 700 }}>사진들을 여기서 선택 (원본이든 모자이크 처리된 것이든)</div>
          <p style={{ color: 'var(--text-muted)', fontSize: '0.85rem', marginTop: '6px' }}>여러 장 한 번에 선택 가능 · 기본은 설명 메모만 올라가요</p>
        </label>
      ) : (
        <>
          <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: '12px' }}>
            <span style={{ fontSize: '0.85rem', color: 'var(--text-muted)' }}>{items.length}장 선택됨</span>
            <label className="btn-secondary" style={{ cursor: 'pointer' }}>
              <input type="file" accept="image/*" multiple onChange={handleFilesChange} style={{ display: 'none' }} />
              다른 사진으로 변경
            </label>
          </div>

          <div
            style={{
              background: 'rgba(139, 92, 246, 0.08)',
              border: '1px solid rgba(139, 92, 246, 0.25)',
              borderRadius: '12px',
              padding: '14px',
              marginBottom: '20px',
            }}
          >
            <span style={{ fontSize: '0.85rem', fontWeight: 600, marginBottom: '8px', display: 'flex', alignItems: 'center', gap: '6px', color: '#a78bfa' }}>
              <Sparkles size={16} />
              AI로 사진 설명 자동 생성
            </span>

            <div style={{ display: 'flex', gap: '6px', marginBottom: '10px' }}>
              <button
                onClick={() => {
                  setCaptionMode('local');
                  setAiStatus(null);
                }}
                className={captionMode === 'local' ? 'btn-naver' : 'btn-secondary'}
                style={{ flex: 1, justifyContent: 'center', fontSize: '0.78rem', padding: '8px 6px' }}
              >
                무료 (내 브라우저에서 처리)
              </button>
              <button
                onClick={() => {
                  setCaptionMode('anthropic');
                  setAiStatus(null);
                }}
                className={captionMode === 'anthropic' ? 'btn-naver' : 'btn-secondary'}
                style={{ flex: 1, justifyContent: 'center', fontSize: '0.78rem', padding: '8px 6px' }}
              >
                Claude API (유료, 고품질)
              </button>
            </div>

            {captionMode === 'local' ? (
              <p style={{ fontSize: '0.76rem', color: 'var(--text-muted)', marginBottom: '10px' }}>
                API 키 없이, 사진을 어디에도 전송하지 않고 브라우저 안에서 완전 무료로 설명을 생성해요. 처음 한 번만
                가벼운 모델 파일을 내려받고(10MB 안팎, 인터넷 연결 필요) 그 다음부터는 브라우저에 캐시돼서
                오프라인에서도 바로 동작해요. 완전한 문장 대신 사진에 뭐가 있을 것 같은지 <strong>태그 목록</strong>
                (영어)을 뽑아줘요 — 문장형 설명보다 정보는 거칠지만, Claude가 그 태그만 보고도 글을 쓰는 데는
                충분하고, 모델이 훨씬 가벼워서 모바일에서도 안정적으로 동작해요.
              </p>
            ) : (
              <>
                <p style={{ fontSize: '0.76rem', color: 'var(--text-muted)', marginBottom: '10px' }}>
                  Claude(Anthropic) API가 사진을 직접 보고 더 정확한 한국어 설명을 만들어줘요. API 키를 넣어두면
                  다음부터 사진을 선택하는 순간 자동으로 분석이 시작돼요.
                </p>
                <div style={{ display: 'flex', gap: '6px', marginBottom: '10px' }}>
                  <input
                    type={showAnthropicKey ? 'text' : 'password'}
                    value={anthropicKey}
                    onChange={(e) => handleAnthropicKeyChange(e.target.value)}
                    placeholder="sk-ant-..."
                    style={{ flex: 1, minWidth: 0, background: '#090d16', color: '#f8fafc', border: '1px solid var(--border-color)', borderRadius: '8px', padding: '8px 10px', fontSize: '0.82rem' }}
                  />
                  <button onClick={() => setShowAnthropicKey((v) => !v)} className="btn-secondary" style={{ padding: '8px 10px', flex: '0 0 auto' }} title={showAnthropicKey ? '가리기' : '보기'}>
                    {showAnthropicKey ? <EyeOff size={14} /> : <Eye size={14} />}
                  </button>
                  {anthropicKey && (
                    <button onClick={handleClearAnthropicKey} className="btn-secondary" style={{ padding: '8px 10px', flex: '0 0 auto' }} title="저장된 키 지우기">
                      <X size={14} />
                    </button>
                  )}
                </div>
              </>
            )}

            <button
              onClick={() => startGeneratingCaptions(items)}
              className="btn-secondary"
              style={{ width: '100%', justifyContent: 'center', borderColor: 'rgba(139, 92, 246, 0.4)' }}
              disabled={aiGeneratingIds.size > 0 || (captionMode === 'anthropic' && !anthropicKey.trim())}
            >
              {aiGeneratingIds.size > 0 ? (
                <RefreshCw size={14} style={{ animation: 'spin 1s linear infinite' }} />
              ) : (
                <Sparkles size={14} />
              )}
              전체 사진 AI로 설명 생성
            </button>
            {aiStatus && (
              <p style={{ fontSize: '0.78rem', marginTop: '8px', color: aiStatus.startsWith('❌') ? '#f87171' : aiStatus.startsWith('⚠️') ? '#fbbf24' : '#03C75A' }}>
                {aiStatus}
              </p>
            )}
            <p style={{ fontSize: '0.72rem', color: 'var(--text-muted)', marginTop: '8px' }}>
              {captionMode === 'local'
                ? '이 사진들은 API로 전송되지 않고 이 기기 안에서만 처리돼요.'
                : '키는 이 브라우저에만 저장되고 api.anthropic.com으로 직접 전송돼요. 분석에 쓴 만큼 Anthropic 계정에 요금이 청구되니(사진 한 장당 아주 소액), 사용량 한도를 걸어둔 키를 쓰는 걸 권장해요.'}
            </p>
          </div>

          <div style={{ display: 'flex', flexDirection: 'column', gap: '6px', marginBottom: '20px' }}>
            <textarea
              value={bulkPasteText}
              onChange={(e) => setBulkPasteText(e.target.value)}
              placeholder={'다른 도구에서 복사한 설명 목록을 여기 붙여넣으세요:\n1. 파일명.jpg — 설명\n2. 파일명2.jpg — 설명'}
              rows={2}
              style={{
                width: '100%',
                background: '#090d16',
                color: '#f8fafc',
                border: '1px solid var(--border-color)',
                borderRadius: '8px',
                padding: '8px 10px',
                fontSize: '0.82rem',
                resize: 'vertical',
                fontFamily: 'inherit',
              }}
            />
            <button
              onClick={applyBulkCaptions}
              className="btn-secondary"
              style={{ alignSelf: 'flex-start', fontSize: '0.8rem', padding: '6px 12px' }}
              disabled={!bulkPasteText.trim()}
            >
              <ClipboardPaste size={14} />
              붙여넣은 설명 한 번에 채우기
            </button>
          </div>

          <div style={{ display: 'flex', flexDirection: 'column', gap: '10px', marginBottom: '20px' }}>
            {items.map((it) => (
              <div key={it.id} style={{ display: 'flex', gap: '10px', alignItems: 'flex-start', background: 'rgba(15, 23, 42, 0.5)', padding: '10px', borderRadius: '10px', border: '1px solid var(--border-color)' }}>
                <img src={it.objectUrl} alt="" style={{ width: '56px', height: '56px', objectFit: 'cover', borderRadius: '8px', flexShrink: 0 }} />
                <div style={{ flex: 1, minWidth: 0 }}>
                  <div style={{ fontSize: '0.78rem', color: 'var(--text-muted)', marginBottom: '4px', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                    {it.file.name}
                    {it.capturedAt && (
                      <span style={{ marginLeft: '6px', color: it.capturedAtSource === 'exif' ? '#03C75A' : '#94a3b8' }}>
                        · {formatPhotoTimestamp(new Date(it.capturedAt))}
                        {it.capturedAtSource !== 'exif' && ' (추정)'}
                      </span>
                    )}
                    {it.capturedAt === undefined && <span style={{ marginLeft: '6px', color: 'var(--text-muted)' }}>· 시각 확인 중...</span>}
                  </div>
                  <div style={{ fontSize: '0.68rem', color: '#a78bfa', marginBottom: '3px' }}>AI 태그</div>
                  <div style={{ display: 'flex', gap: '6px', marginBottom: '8px' }}>
                    <textarea
                      value={it.caption}
                      onChange={(e) => handleCaptionChange(it.id, e.target.value)}
                      placeholder={aiGeneratingIds.has(it.id) ? 'AI가 사진을 분석하는 중...' : '이 사진 설명 (예: 우산 쓰고 걷는 아이랑 엄마)'}
                      rows={1}
                      style={{
                        flex: 1,
                        minWidth: 0,
                        background: '#090d16',
                        color: '#f8fafc',
                        border: '1px solid var(--border-color)',
                        borderRadius: '6px',
                        padding: '6px 8px',
                        fontSize: '0.82rem',
                        resize: 'vertical',
                        fontFamily: 'inherit',
                      }}
                    />
                    <button
                      onClick={() => handleGenerateOneCaption(it)}
                      className="btn-secondary"
                      title="이 사진 AI로 설명 생성"
                      style={{ padding: '6px 8px', flex: '0 0 auto' }}
                      disabled={aiGeneratingIds.has(it.id)}
                    >
                      {aiGeneratingIds.has(it.id) ? (
                        <RefreshCw size={14} style={{ animation: 'spin 1s linear infinite' }} />
                      ) : (
                        <Sparkles size={14} color="#a78bfa" />
                      )}
                    </button>
                  </div>
                  <div style={{ fontSize: '0.68rem', color: '#03C75A', marginBottom: '3px' }}>내가 직접 추가 설명 (선택)</div>
                  <textarea
                    value={it.userNote}
                    onChange={(e) => handleUserNoteChange(it.id, e.target.value)}
                    placeholder="AI 태그만으론 부족할 때, 직접 이 사진에 대해 적어주세요 (예: 시흥 갯골생태공원 전망대에서 찍은 사진)"
                    rows={1}
                    style={{
                      width: '100%',
                      background: '#090d16',
                      color: '#f8fafc',
                      border: '1px solid rgba(3, 199, 90, 0.3)',
                      borderRadius: '6px',
                      padding: '6px 8px',
                      fontSize: '0.82rem',
                      resize: 'vertical',
                      fontFamily: 'inherit',
                    }}
                  />
                </div>
                <button onClick={() => handleRemoveItem(it.id)} style={{ background: 'none', border: 'none', cursor: 'pointer', color: '#94a3b8', flexShrink: 0 }}>
                  <X size={16} />
                </button>
              </div>
            ))}
          </div>

          <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(220px, 1fr))', gap: '16px', marginBottom: '16px' }}>
            <div>
              <label style={{ display: 'block', fontSize: '0.8rem', fontWeight: 600, marginBottom: '4px' }}>GitHub 토큰</label>
              <div style={{ display: 'flex', gap: '6px' }}>
                <input
                  type={showToken ? 'text' : 'password'}
                  value={token}
                  onChange={(e) => setToken(e.target.value)}
                  placeholder="ghp_... 또는 github_pat_..."
                  style={{ flex: 1, minWidth: 0, background: '#090d16', color: '#f8fafc', border: '1px solid var(--border-color)', borderRadius: '8px', padding: '8px 10px', fontSize: '0.82rem' }}
                />
                <button onClick={() => setShowToken((v) => !v)} className="btn-secondary" style={{ padding: '8px 10px', flex: '0 0 auto' }} title={showToken ? '가리기' : '보기'}>
                  {showToken ? <EyeOff size={14} /> : <Eye size={14} />}
                </button>
                {token && (
                  <button onClick={handleClearToken} className="btn-secondary" style={{ padding: '8px 10px', flex: '0 0 auto' }} title="저장된 토큰 지우기">
                    <X size={14} />
                  </button>
                )}
              </div>
            </div>

            <div>
              <label style={{ display: 'block', fontSize: '0.8rem', fontWeight: 600, marginBottom: '4px' }}>저장할 폴더 이름</label>
              <input
                type="text"
                value={folder}
                onChange={(e) => setFolder(e.target.value)}
                placeholder="예: ansan-family-outing-2"
                style={{ width: '100%', background: '#090d16', color: '#f8fafc', border: '1px solid var(--border-color)', borderRadius: '8px', padding: '8px 10px', fontSize: '0.82rem' }}
              />
              <p style={{ fontSize: '0.72rem', color: 'var(--text-muted)', marginTop: '4px' }}>
                → <code>public/images/{folder || '<폴더명>'}/captions.md</code>
              </p>
            </div>
          </div>

          <label style={{ display: 'flex', alignItems: 'center', gap: '8px', fontSize: '0.82rem', marginBottom: '10px', cursor: 'pointer' }}>
            <input
              type="checkbox"
              checked={uploadPhotos}
              onChange={(e) => setUploadPhotos(e.target.checked)}
              style={{ accentColor: '#03C75A', width: '16px', height: '16px' }}
            />
            사진도 같이 올리기 (기본은 설명 메모만)
          </label>

          <button onClick={handleUpload} className="btn-naver" style={{ width: '100%', justifyContent: 'center' }} disabled={uploading}>
            {uploading ? (
              <>
                <RefreshCw size={16} style={{ animation: 'spin 1s linear infinite' }} />
                {uploadPhotos ? `업로드 중... (${uploadedCount}/${items.length})` : '업로드 중...'}
              </>
            ) : (
              <>
                <Github size={16} />
                {uploadPhotos ? '사진 + 설명 GitHub에 업로드' : '설명 메모 GitHub에 업로드'}
              </>
            )}
          </button>

          {status && (
            <p style={{ fontSize: '0.82rem', marginTop: '10px', color: status.startsWith('❌') ? '#f87171' : status.startsWith('⚠️') ? '#fbbf24' : '#03C75A' }}>
              {status}
            </p>
          )}

          <div
            style={{
              display: 'flex',
              alignItems: 'flex-start',
              gap: '6px',
              background: 'rgba(248,113,113,0.06)',
              border: '1px solid rgba(248,113,113,0.2)',
              borderRadius: '8px',
              padding: '10px',
              marginTop: '14px',
              fontSize: '0.76rem',
              color: '#94a3b8',
            }}
          >
            <span>
              ⚠️ 토큰은 이 브라우저에만 저장되고 api.github.com으로 직접 전송돼요. 그래도 비밀번호처럼 다뤄주세요 —
              이 저장소 하나에만, Contents 읽기/쓰기 권한만 준 <strong>fine-grained 토큰</strong>을 만들어 쓰길
              권장해요(일반 <code>repo</code> 스코프 토큰은 계정 전체에 쓰기 권한을 주니 피하세요). 공용 기기에서는
              사용 후 위 X 버튼으로 토큰을 지워주세요.
            </span>
          </div>
        </>
      )}
    </div>
  );
};
