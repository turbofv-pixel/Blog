import React, { useState } from 'react';
import { Upload, Github, Eye, EyeOff, X, RefreshCw, ClipboardPaste } from 'lucide-react';
import { GITHUB_BRANCH_KEY, GITHUB_TOKEN_KEY, fileToBase64, githubPutFile, utf8ToBase64 } from '../lib/githubUpload';

// 이미 다른 곳(토끼 모자이크 스튜디오 등)에서 처리를 끝내고 다운로드해둔 사진들을, 여기서
// 설명 메모와 함께 이 저장소에 커밋한다. 모자이크/얼굴 인식 로직과는 완전히 무관 — 그냥
// "이미 완성된 파일 + 글자"를 GitHub에 올리는 도구다.

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
  const [showToken, setShowToken] = useState<boolean>(false);
  const [uploading, setUploading] = useState<boolean>(false);
  const [uploadedCount, setUploadedCount] = useState<number>(0);
  const [status, setStatus] = useState<string | null>(null);

  const handleFilesChange = (e: React.ChangeEvent<HTMLInputElement>) => {
    const files = Array.from(e.target.files || []);
    if (files.length === 0) return;
    items.forEach((it) => URL.revokeObjectURL(it.objectUrl));
    setItems(files.map((f) => ({ id: uid(), file: f, objectUrl: URL.createObjectURL(f), caption: '' })));
    setStatus(null);
    e.target.value = '';
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

    setStatus('업로드 중... 설명 메모(captions.md)');
    try {
      await githubPutFile(`public/images/${folderPath}/captions.md`, utf8ToBase64(buildCaptionsText()), '사진 설명 메모 추가', tok, branch);
    } catch (err: any) {
      setUploading(false);
      setStatus(`⚠️ 사진 ${ok}장은 올라갔지만 설명 메모 업로드는 실패했어요: ${err.message || err}`);
      return;
    }

    setUploading(false);
    setStatus(
      `✨ 사진 ${ok}장 + 설명 메모 GitHub에 업로드 완료! (public/images/${folderPath}/, "${branch}" 브랜치) ` +
        `이제 Claude한테 "${folderPath} 폴더 사진으로 글 써줘"라고 말해보세요.`
    );
  };

  return (
    <div className="glass-panel animate-fade-in" style={{ padding: '28px', marginBottom: '24px' }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: '12px', marginBottom: '20px' }}>
        <div style={{ background: 'rgba(3, 199, 90, 0.15)', padding: '12px', borderRadius: '12px' }}>
          <Github size={28} color="#03C75A" />
        </div>
        <div>
          <h2 style={{ fontSize: '1.4rem', fontWeight: 700 }}>사진 + 설명 GitHub 업로드</h2>
          <p style={{ color: 'var(--text-muted)', fontSize: '0.9rem' }}>
            토끼 모자이크 스튜디오 등에서 이미 처리해서 다운로드해둔 사진들을, 설명 메모와 함께 이 저장소에 바로
            올려요. 얼굴 인식이나 모자이크 처리는 여기서 하지 않아요 — 완성된 파일만 다룹니다.
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
          <div style={{ fontSize: '1rem', fontWeight: 700 }}>이미 처리된(모자이크된) 사진들을 여기서 선택</div>
          <p style={{ color: 'var(--text-muted)', fontSize: '0.85rem', marginTop: '6px' }}>여러 장 한 번에 선택 가능</p>
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
                  <textarea
                    value={it.caption}
                    onChange={(e) => handleCaptionChange(it.id, e.target.value)}
                    placeholder="이 사진 설명 (예: 우산 쓰고 걷는 아이랑 엄마)"
                    rows={1}
                    style={{
                      width: '100%',
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
                → <code>public/images/{folder || '<폴더명>'}/</code>
              </p>
            </div>
          </div>

          <button onClick={handleUpload} className="btn-naver" style={{ width: '100%', justifyContent: 'center' }} disabled={uploading}>
            {uploading ? (
              <>
                <RefreshCw size={16} style={{ animation: 'spin 1s linear infinite' }} />
                업로드 중... ({uploadedCount}/{items.length})
              </>
            ) : (
              <>
                <Github size={16} />
                사진 + 설명 GitHub에 업로드
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
