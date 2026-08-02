import React from 'react';
import { FileText, Image, Github, Sparkles, FolderTree } from 'lucide-react';

interface HeaderProps {
  activeTab: 'posts' | 'mosaic' | 'github';
  setActiveTab: (tab: 'posts' | 'mosaic' | 'github') => void;
}

export const Header: React.FC<HeaderProps> = ({ activeTab, setActiveTab }) => {
  return (
    <header className="glass-panel" style={{ padding: '16px 28px', marginBottom: '28px', borderRadius: '20px' }}>
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', flexWrap: 'wrap', gap: '16px' }}>
        
        {/* Logo & Brand */}
        <div style={{ display: 'flex', alignItems: 'center', gap: '14px' }}>
          <div style={{
            background: 'linear-gradient(135deg, #03C75A 0%, #028a3e 100%)',
            width: '46px',
            height: '46px',
            borderRadius: '14px',
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'center',
            boxShadow: '0 4px 16px rgba(3, 199, 90, 0.4)'
          }}>
            <Sparkles size={24} color="#ffffff" />
          </div>
          <div>
            <div style={{ display: 'flex', alignItems: 'center', gap: '8px' }}>
              <h1 style={{ fontSize: '1.35rem', fontWeight: 800, letterSpacing: '-0.02em', background: 'linear-gradient(to right, #ffffff, #94a3b8)', WebkitBackgroundClip: 'text', WebkitTextFillColor: 'transparent' }}>
                네이버 블로그 포스팅 헬퍼
              </h1>
              <span className="badge" style={{ background: '#03C75A22', color: '#03C75A', border: '1px solid #03C75A44' }}>
                Naver Blog AI Suite
              </span>
            </div>
            <p style={{ fontSize: '0.83rem', color: 'var(--text-muted)' }}>
              Markdown 카테고리 관리 · AI 얼굴 자동 모자이크 · 스마트에디터 원클릭 복사
            </p>
          </div>
        </div>

        {/* Navigation Tabs */}
        <nav style={{ display: 'flex', gap: '8px', background: 'rgba(15, 23, 42, 0.6)', padding: '6px', borderRadius: '12px', border: '1px solid rgba(255,255,255,0.06)' }}>
          <button
            onClick={() => setActiveTab('posts')}
            className={activeTab === 'posts' ? 'btn-naver' : 'btn-secondary'}
            style={{ padding: '8px 16px', fontSize: '0.9rem' }}
          >
            <FileText size={17} />
            포스트 매니저 (.md)
          </button>
          
          <button
            onClick={() => setActiveTab('mosaic')}
            className={activeTab === 'mosaic' ? 'btn-naver' : 'btn-secondary'}
            style={{ padding: '8px 16px', fontSize: '0.9rem' }}
          >
            <Image size={17} />
            AI 얼굴 모자이크
          </button>

          <button
            onClick={() => setActiveTab('github')}
            className={activeTab === 'github' ? 'btn-naver' : 'btn-secondary'}
            style={{ padding: '8px 16px', fontSize: '0.9rem' }}
          >
            <Github size={17} />
            GitHub 백업 관리
          </button>
        </nav>

      </div>
    </header>
  );
};
