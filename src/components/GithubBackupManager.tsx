import React, { useState } from 'react';
import { Github, GitCommit, UploadCloud, FolderCheck, Copy, Check, Terminal, ShieldCheck, Sparkles } from 'lucide-react';
import { GithubPhotoUploader } from './GithubPhotoUploader';

interface GithubBackupManagerProps {
  // 설명 메모 업로드 직후 "이어서 토끼 모자이크 처리하기"를 누르면, 같은 사진들을 모자이크
  // 스튜디오 탭으로 그대로 넘겨준다 — App 컴포넌트가 실제 탭 전환/파일 전달을 담당하므로
  // 여기서는 그냥 그대로 흘려보내기만 한다.
  onContinueToMosaic?: (files: File[]) => void;
}

export const GithubBackupManager: React.FC<GithubBackupManagerProps> = ({ onContinueToMosaic }) => {
  const [copiedCmd, setCopiedCmd] = useState<string | null>(null);

  const copyToClipboard = (text: string, id: string) => {
    navigator.clipboard.writeText(text);
    setCopiedCmd(id);
    setTimeout(() => setCopiedCmd(null), 2500);
  };

  const gitInitCmd = `git init\ngit add .\ngit commit -m "feat: Naver blog posts and mosaic setup"\ngit branch -M main\ngit remote add origin https://github.com/사용자계정/blog.git\ngit push -u origin main`;
  const gitUpdateCmd = `git add .\ngit commit -m "docs: add new post & mosaic photos"\ngit push`;

  return (
    <>
      <GithubPhotoUploader onContinueToMosaic={onContinueToMosaic} />
      <div className="glass-panel animate-fade-in" style={{ padding: '28px' }}>

      <div style={{ display: 'flex', alignItems: 'center', gap: '12px', marginBottom: '20px' }}>
        <div style={{ background: 'rgba(255,255,255,0.1)', padding: '12px', borderRadius: '12px' }}>
          <Github size={28} color="#ffffff" />
        </div>
        <div>
          <h2 style={{ fontSize: '1.4rem', fontWeight: 700 }}>
            GitHub 버전 관리 & 영구 백업 체계
          </h2>
          <p style={{ color: 'var(--text-muted)', fontSize: '0.9rem' }}>
            작성하신 육아, IT, 여행 Markdown 원본과 모자이크 처리된 사진들을 GitHub 저장소에 안전하게 보관하세요.
          </p>
        </div>
      </div>

      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(300px, 1fr))', gap: '20px', marginBottom: '28px' }}>
        
        {/* Step 1 */}
        <div style={{ background: 'rgba(15, 23, 42, 0.6)', padding: '20px', borderRadius: '14px', border: '1px solid var(--border-color)' }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: '8px', color: '#03C75A', fontWeight: 700, marginBottom: '8px' }}>
            <FolderCheck size={18} />
            1. 카테고리별 마크다운 저장 구조
          </div>
          <p style={{ fontSize: '0.85rem', color: 'var(--text-muted)', lineHeight: 1.6 }}>
            로컬 프로젝트 폴더의 <code>posts/parenting</code>, <code>posts/it</code>, <code>posts/travel</code>, <code>posts/stock</code> 디렉토리에 각 `.md` 파일이 분류되어 저장됩니다.
          </p>
        </div>

        {/* Step 2 */}
        <div style={{ background: 'rgba(15, 23, 42, 0.6)', padding: '20px', borderRadius: '14px', border: '1px solid var(--border-color)' }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: '8px', color: '#60a5fa', fontWeight: 700, marginBottom: '8px' }}>
            <ShieldCheck size={18} />
            2. 사진 및 미디어 보안 백업
          </div>
          <p style={{ fontSize: '0.85rem', color: 'var(--text-muted)', lineHeight: 1.6 }}>
            얼굴 모자이크가 끝난 최종 안전한 사진만 GitHub에 커밋되므로 개인정보 유출 걱정 없이 원본 콘텐츠를 보존할 수 있습니다.
          </p>
        </div>

      </div>

      {/* Terminal Command Guides */}
      <h3 style={{ fontSize: '1.1rem', fontWeight: 700, marginBottom: '14px', display: 'flex', alignItems: 'center', gap: '8px' }}>
        <Terminal size={18} color="#03C75A" />
        GitHub 최초 연동 터미널 명령어
      </h3>

      <div style={{ background: '#090d16', padding: '16px', borderRadius: '12px', border: '1px solid var(--border-color)', position: 'relative', marginBottom: '24px' }}>
        <button
          onClick={() => copyToClipboard(gitInitCmd, 'init')}
          className="btn-secondary"
          style={{ position: 'absolute', top: '12px', right: '12px', padding: '6px 12px', fontSize: '0.78rem' }}
        >
          {copiedCmd === 'init' ? <Check size={14} color="#03C75A" /> : <Copy size={14} />}
          {copiedCmd === 'init' ? '복사완료' : '명령어 복사'}
        </button>
        <pre style={{ fontFamily: 'monospace', fontSize: '0.88rem', color: '#38bdf8', margin: 0, whiteSpace: 'pre-wrap' }}>
          {gitInitCmd}
        </pre>
      </div>

      <h3 style={{ fontSize: '1.1rem', fontWeight: 700, marginBottom: '14px', display: 'flex', alignItems: 'center', gap: '8px' }}>
        <UploadCloud size={18} color="#8b5cf6" />
        글 작성 후 GitHub 업데이트 (일상 커밋)
      </h3>

      <div style={{ background: '#090d16', padding: '16px', borderRadius: '12px', border: '1px solid var(--border-color)', position: 'relative' }}>
        <button
          onClick={() => copyToClipboard(gitUpdateCmd, 'update')}
          className="btn-secondary"
          style={{ position: 'absolute', top: '12px', right: '12px', padding: '6px 12px', fontSize: '0.78rem' }}
        >
          {copiedCmd === 'update' ? <Check size={14} color="#03C75A" /> : <Copy size={14} />}
          {copiedCmd === 'update' ? '복사완료' : '명령어 복사'}
        </button>
        <pre style={{ fontFamily: 'monospace', fontSize: '0.88rem', color: '#a78bfa', margin: 0, whiteSpace: 'pre-wrap' }}>
          {gitUpdateCmd}
        </pre>
      </div>

      </div>
    </>
  );
};
