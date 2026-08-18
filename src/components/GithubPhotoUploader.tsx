import React, { useState } from 'react';
import { Upload, Github, Eye, EyeOff, X, RefreshCw, ClipboardPaste, Sparkles } from 'lucide-react';
import { GITHUB_BRANCH_KEY, GITHUB_TOKEN_KEY, fileToBase64, githubPutFile, utf8ToBase64 } from '../lib/githubUpload';
import { ANTHROPIC_API_KEY_STORAGE_KEY, generatePhotoCaption } from '../lib/anthropicCaption';
import { generateLocalCaption } from '../lib/localCaption';

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
}

const uid = () => Math.random().toString(36).slice(2) + Date.now().toString(36);

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
  // 기본은 'local' — 브라우저 안에서 완전 무료로 돌아가는 모델을 쓴다. API 키가 있고 더 정확한
  // 한국어 설명이 필요하면 'anthropic'으로 바꿔서 쓸 수 있게 옵션으로 남겨둔다.
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
  const generateCaptionFor = async (id: string, file: File, mode: CaptionMode, key: string): Promise<string | null> => {
    setAiGeneratingIds((prev) => new Set(prev).add(id));
    try {
      const caption =
        mode === 'local'
          ? await generateLocalCaption(file, (p) => {
              const pct = typeof p.progress === 'number' ? ` ${Math.round(p.progress)}%` : '';
              setAiStatus(`모델 준비 중(최초 1회만, 이후엔 인터넷 없이도 즉시 실행)... ${p.file || p.status}${pct}`);
            })
          : await generatePhotoCaption(file, key);
      setItems((prev) => prev.map((it) => (it.id === id ? { ...it, caption } : it)));
      return null;
    } catch (err: any) {
      const message = err?.message || String(err);
      setAiStatus(`❌ ${file.name} 설명 생성 실패: ${message}`);
      return message;
    } finally {
      setAiGeneratingIds((prev) => {
        const next = new Set(prev);
        next.delete(id);
        return next;
      });
    }
  };

  const handleGenerateOneCaption = (id: string, file: File) => {
    if (captionMode === 'anthropic') {
      const key = anthropicKey.trim();
      if (!key) {
        setAiStatus('❌ Anthropic API 키를 먼저 입력해주세요.');
        return;
      }
      setAiStatus(null);
      generateCaptionFor(id, file, 'anthropic', key);
    } else {
      setAiStatus(null);
      generateCaptionFor(id, file, 'local', '');
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
          ? `(${targetItems.indexOf(it) + 1}/${targetItems.length}) ${it.file.name} 분석 준비 중...`
          : `AI가 사진을 분석하는 중... (${targetItems.indexOf(it) + 1}/${targetItems.length}) ${it.file.name}`
      );
      // eslint-disable-next-line no-await-in-loop
      const error = await generateCaptionFor(it.id, it.file, captionMode, key);
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

  const handleFilesChange = (e: React.ChangeEvent<HTMLInputElement>) => {
    const files = Array.from(e.target.files || []);
    if (files.length === 0) return;
    items.forEach((it) => URL.revokeObjectURL(it.objectUrl));
    const newItems: UploadItem[] = files.map((f) => ({ id: uid(), file: f, objectUrl: URL.createObjectURL(f), caption: '' }));
    setItems(newItems);
    setStatus(null);
    setAiStatus(null);
    e.target.value = '';
    // 로컬 모드는 키가 필요 없으니 사진 선택 즉시 자동 분석 시작. Anthropic 모드는 키가
    // 저장돼 있을 때만 자동 시작.
    if (captionMode === 'local' || anthropicKey.trim()) {
      handleGenerateAllCaptions(newItems);
    }
  };

  const handleCaptionChange = (id: string, caption: string) => {
    setItems((prev) => prev.map((it) => (it.id === id ? { ...it, caption } : it)));
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

  const buildCaptionsText = () =>
    items.map((it, i) => `${i + 1}. ${it.file.name} — ${it.caption.trim() || '(설명 없음)'}`).join('\n');

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
                모델 파일을 내려받고(수십MB, 인터넷 연결 필요) 그 다음부터는 브라우저에 캐시돼서 오프라인에서도 바로
                동작해요. 다만 이 모델은 <strong>영어로만</strong> 설명을 만들어요 — 그래도 Claude가 그 영어 설명만
                읽고 한국어로 글을 쓰는 데는 전혀 문제없어요.
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
              onClick={() => handleGenerateAllCaptions(items)}
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
                  </div>
                  <div style={{ display: 'flex', gap: '6px' }}>
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
                      onClick={() => handleGenerateOneCaption(it.id, it.file)}
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
