import React, { useState } from 'react';
import { Category, Post } from '../types';
import { FileText, Copy, Check, Plus, Tag, Calendar, Folder, ExternalLink, Sparkles, Code, Edit3, Trash2 } from 'lucide-react';
import { marked } from 'marked';

interface PostManagerProps {
  initialPosts: Post[];
}

export const PostManager: React.FC<PostManagerProps> = ({ initialPosts }) => {
  const [posts, setPosts] = useState<Post[]>(initialPosts);
  const [selectedCategory, setSelectedCategory] = useState<Category>('전체');
  const [selectedPost, setSelectedPost] = useState<Post>(initialPosts[0]);
  const [copiedStatus, setCopiedStatus] = useState<boolean>(false);
  const [isEditing, setIsEditing] = useState<boolean>(false);
  const [editedContent, setEditedContent] = useState<string>(initialPosts[0]?.content || '');

  // Filter posts by selected category
  const filteredPosts = posts.filter(
    (post) => selectedCategory === '전체' || post.category === selectedCategory
  );

  // Handle post selection
  const handleSelectPost = (post: Post) => {
    setSelectedPost(post);
    setEditedContent(post.content);
    setIsEditing(false);
    setCopiedStatus(false);
  };

  // Convert Markdown to Naver SmartEditor ONE formatted HTML
  const getNaverFormattedHtml = (markdownText: string) => {
    try {
      const rawHtml = marked.parse(markdownText) as string;
      // Wrap with Naver SmartEditor inline styles
      return `
        <div style="font-family: 'Maru Buri', 'Nanum Gothic', sans-serif; color: #222222; font-size: 16px; line-height: 1.8;">
          ${rawHtml}
        </div>
      `;
    } catch (e) {
      return markdownText;
    }
  };

  // One-click Copy for Naver SmartEditor
  const handleCopyToNaver = async () => {
    const htmlContent = getNaverFormattedHtml(editedContent);
    
    try {
      // Create rich HTML Blob for clipboard so Naver SmartEditor receives styled rich text
      const blobHtml = new Blob([htmlContent], { type: 'text/html' });
      const blobText = new Blob([editedContent], { type: 'text/plain' });
      const clipboardItem = new ClipboardItem({
        'text/html': blobHtml,
        'text/plain': blobText,
      });

      await navigator.clipboard.write([clipboardItem]);
      setCopiedStatus(true);
      setTimeout(() => setCopiedStatus(false), 3000);
    } catch (err) {
      // Fallback for browsers
      try {
        await navigator.clipboard.writeText(editedContent);
        setCopiedStatus(true);
        setTimeout(() => setCopiedStatus(false), 3000);
      } catch (fallbackErr) {
        alert('복사에 실패했습니다. 아래 텍스트를 직접 복사해 주세요.');
      }
    }
  };

  // Handle Post Save
  const handleSavePost = () => {
    const updatedPosts = posts.map((p) =>
      p.id === selectedPost.id ? { ...p, content: editedContent } : p
    );
    setPosts(updatedPosts);
    setSelectedPost({ ...selectedPost, content: editedContent });
    setIsEditing(false);
  };

  // Create New Post Modal / Action
  const handleCreateNewPost = () => {
    const categoryName = selectedCategory === '전체' ? '육아' : selectedCategory;
    const newPost: Post = {
      id: `post-${Date.now()}`,
      title: `[새 포스트] ${categoryName} 주제 글`,
      category: categoryName as Category,
      date: new Date().toISOString().split('T')[0],
      tags: [categoryName, '네이버블로그'],
      naverCategory: categoryName,
      content: `# 새 ${categoryName} 포스트\n\n네이버 블로그에 포스팅할 마크다운 원본을 작성해 보세요.\n\n--- \n\n## 1. 첫 번째 주제\n\n내용을 여기에 작성합니다.`,
      filePath: `posts/${categoryName === '육아' ? 'parenting' : categoryName === 'IT' ? 'it' : 'travel'}/new-post-${Date.now()}.md`
    };

    setPosts([newPost, ...posts]);
    setSelectedPost(newPost);
    setEditedContent(newPost.content);
    setIsEditing(true);
  };

  const getCategoryBadgeClass = (category: Category) => {
    switch (category) {
      case '육아': return 'badge-parenting';
      case 'IT': return 'badge-it';
      case '여행': return 'badge-travel';
      default: return 'badge-it';
    }
  };

  return (
    <div className="animate-fade-in" style={{ display: 'grid', gridTemplateColumns: '320px 1fr', gap: '24px' }}>
      
      {/* Sidebar: Categories & Posts List */}
      <div className="glass-panel" style={{ padding: '20px', display: 'flex', flexDirection: 'column', gap: '16px', height: 'fit-content' }}>
        
        {/* Category Tabs */}
        <div>
          <h3 style={{ fontSize: '0.9rem', color: 'var(--text-muted)', marginBottom: '12px', fontWeight: 600 }}>
            카테고리 선택
          </h3>
          <div style={{ display: 'flex', flexWrap: 'wrap', gap: '6px' }}>
            {(['전체', '육아', 'IT', '여행'] as Category[]).map((cat) => (
              <button
                key={cat}
                onClick={() => setSelectedCategory(cat)}
                style={{
                  padding: '6px 14px',
                  borderRadius: '20px',
                  fontSize: '0.85rem',
                  fontWeight: 600,
                  border: 'none',
                  cursor: 'pointer',
                  background: selectedCategory === cat ? '#03C75A' : 'rgba(255,255,255,0.06)',
                  color: selectedCategory === cat ? '#ffffff' : 'var(--text-muted)',
                  transition: 'all 0.2s ease'
                }}
              >
                {cat}
              </button>
            ))}
          </div>
        </div>

        {/* Action: New Post */}
        <button onClick={handleCreateNewPost} className="btn-secondary" style={{ justifyContent: 'center', width: '100%' }}>
          <Plus size={16} color="#03C75A" />
          새 `.md` 포스트 작성
        </button>

        <hr style={{ borderColor: 'var(--border-color)', margin: '4px 0' }} />

        {/* Posts List */}
        <div>
          <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: '10px' }}>
            <span style={{ fontSize: '0.85rem', color: 'var(--text-muted)', fontWeight: 600 }}>
              포스트 목록 ({filteredPosts.length})
            </span>
          </div>

          <div style={{ display: 'flex', flexDirection: 'column', gap: '10px', maxHeight: '520px', overflowY: 'auto' }}>
            {filteredPosts.map((post) => (
              <div
                key={post.id}
                onClick={() => handleSelectPost(post)}
                style={{
                  padding: '12px 14px',
                  borderRadius: '12px',
                  cursor: 'pointer',
                  background: selectedPost.id === post.id ? 'rgba(3, 199, 90, 0.15)' : 'rgba(255,255,255,0.03)',
                  border: selectedPost.id === post.id ? '1px solid #03C75A' : '1px solid transparent',
                  transition: 'all 0.2s ease'
                }}
              >
                <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: '4px' }}>
                  <span className={`badge ${getCategoryBadgeClass(post.category)}`}>
                    {post.category}
                  </span>
                  <span style={{ fontSize: '0.75rem', color: 'var(--text-muted)' }}>{post.date}</span>
                </div>
                <h4 style={{ fontSize: '0.92rem', fontWeight: 600, color: 'var(--text-main)', whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>
                  {post.title}
                </h4>
                <div style={{ fontSize: '0.75rem', color: 'var(--text-muted)', marginTop: '4px', display: 'flex', alignItems: 'center', gap: '4px' }}>
                  <Folder size={12} />
                  {post.filePath}
                </div>
              </div>
            ))}
          </div>
        </div>

      </div>

      {/* Main Workspace: Post Editor & Naver SmartEditor Converter */}
      <div className="glass-panel" style={{ padding: '24px', display: 'flex', flexDirection: 'column', gap: '20px' }}>
        
        {/* Workspace Top Bar */}
        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start', flexWrap: 'wrap', gap: '12px' }}>
          <div>
            <div style={{ display: 'flex', alignItems: 'center', gap: '8px', marginBottom: '4px' }}>
              <span className={`badge ${getCategoryBadgeClass(selectedPost.category)}`}>
                {selectedPost.category}
              </span>
              <span style={{ fontSize: '0.85rem', color: 'var(--text-muted)' }}>
                네이버 추천 카테고리: {selectedPost.naverCategory}
              </span>
            </div>
            <h2 style={{ fontSize: '1.3rem', fontWeight: 700 }}>
              {selectedPost.title}
            </h2>
            <div style={{ display: 'flex', gap: '6px', marginTop: '6px', flexWrap: 'wrap' }}>
              {selectedPost.tags.map((tag) => (
                <span key={tag} style={{ fontSize: '0.75rem', color: '#94a3b8', background: 'rgba(255,255,255,0.06)', padding: '2px 8px', borderRadius: '6px' }}>
                  #{tag}
                </span>
              ))}
            </div>
          </div>

          {/* Copy & Edit Action Buttons */}
          <div style={{ display: 'flex', gap: '10px' }}>
            <button
              onClick={() => setIsEditing(!isEditing)}
              className="btn-secondary"
            >
              <Edit3 size={16} />
              {isEditing ? '미리보기' : 'Markdown 편집'}
            </button>

            <button
              onClick={handleCopyToNaver}
              className="btn-naver"
            >
              {copiedStatus ? <Check size={18} /> : <Copy size={18} />}
              {copiedStatus ? '복사 완료! (네이버에 붙여넣으세요)' : '네이버 스마트에디터용 복사 (Ctrl+V)'}
            </button>
          </div>
        </div>

        {/* Copy Notification Banner */}
        {copiedStatus && (
          <div className="animate-fade-in" style={{
            background: 'rgba(3, 199, 90, 0.15)',
            border: '1px solid #03C75A',
            color: '#03C75A',
            padding: '12px 18px',
            borderRadius: '10px',
            display: 'flex',
            alignItems: 'center',
            gap: '10px',
            fontWeight: 600,
            fontSize: '0.9rem'
          }}>
            <Sparkles size={18} />
            네이버 스마트에디터 서식이 클립보드에 복사되었습니다! 네이버 블로그 글쓰기 창에서 [Ctrl + V]를 눌러 붙여넣으세요.
          </div>
        )}

        {/* Content Section: Editor vs Naver Preview */}
        {isEditing ? (
          <div>
            <div style={{ display: 'flex', justifyContent: 'space-between', marginBottom: '8px' }}>
              <span style={{ fontSize: '0.85rem', color: 'var(--text-muted)' }}>Markdown 원본 수정</span>
              <button onClick={handleSavePost} className="btn-naver" style={{ padding: '6px 14px', fontSize: '0.82rem' }}>
                저장하기
              </button>
            </div>
            <textarea
              value={editedContent}
              onChange={(e) => setEditedContent(e.target.value)}
              style={{
                width: '100%',
                height: '450px',
                background: '#090d16',
                color: '#f8fafc',
                border: '1px solid var(--border-color)',
                borderRadius: '12px',
                padding: '16px',
                fontFamily: 'monospace',
                fontSize: '0.92rem',
                lineHeight: 1.6,
                resize: 'vertical'
              }}
            />
          </div>
        ) : (
          <div>
            <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: '12px' }}>
              <span style={{ fontSize: '0.9rem', fontWeight: 600, color: 'var(--text-muted)', display: 'flex', alignItems: 'center', gap: '6px' }}>
                <ExternalLink size={16} color="#03C75A" />
                네이버 블로그 스마트에디터 미리보기 (Naver Style Preview)
              </span>
            </div>

            {/* Naver Styled Preview Container */}
            <div 
              className="naver-smart-editor-preview"
              dangerouslySetInnerHTML={{ __html: getNaverFormattedHtml(editedContent) }}
            />
          </div>
        )}

      </div>

    </div>
  );
};
