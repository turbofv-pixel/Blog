import React, { useState, useMemo } from 'react';
import { Category, Post } from '../types';
import { FileText, Copy, Check, Plus, Tag, Calendar, Folder, ExternalLink, Sparkles, Code, Edit3, Trash2, Download, Film } from 'lucide-react';
import { marked } from 'marked';

interface PostManagerProps {
  initialPosts: Post[];
}

export const PostManager: React.FC<PostManagerProps> = ({ initialPosts }) => {
  const [posts, setPosts] = useState<Post[]>(initialPosts);
  const [selectedCategory, setSelectedCategory] = useState<Category>('전체');
  const [selectedPost, setSelectedPost] = useState<Post>(initialPosts[0]);
  const [copiedStatus, setCopiedStatus] = useState<boolean>(false);
  const [copiedImageSrc, setCopiedImageSrc] = useState<string | null>(null);
  const [isEditing, setIsEditing] = useState<boolean>(false);
  const [editedContent, setEditedContent] = useState<string>(initialPosts[0]?.content || '');

  // Local src -> already-uploaded Naver image URL (e.g. https://postfiles.pstatic.net/...).
  // Once a photo has one of these, the "글+사진 한 번에 복사" button can embed a real <img
  // src> pointing at Naver's own domain instead of a manual-upload notice — that's what
  // actually survives Naver's paste sanitizer (see buildNaverClipboardHtml below). Persisted
  // so it doesn't need to be re-entered every time.
  const [naverUrlMap, setNaverUrlMap] = useState<Record<string, string>>(() => {
    try {
      return JSON.parse(localStorage.getItem('naverImageUrlMap') || '{}');
    } catch (e) {
      return {};
    }
  });
  const [bulkUrlText, setBulkUrlText] = useState<string>('');

  // Photo and video files referenced in the current post, for manual download/copy. Naver's
  // editor doesn't reliably accept pasted <img>/<video> HTML tags (external URLs get dropped,
  // data URIs get stripped) but a real image dropped on the clipboard (the same way "우클릭
  // > 이미지 복사" works on any webpage) pastes in fine — see copyImageToClipboard below
  const mediaSources = useMemo(() => {
    const rawHtml = marked.parse(editedContent) as string;
    const container = document.createElement('div');
    container.innerHTML = rawHtml;
    const images = Array.from(container.querySelectorAll('img')).map((img) => ({ src: img.getAttribute('src') || '', isVideo: false }));
    const videos = Array.from(container.querySelectorAll('video')).map((video) => ({ src: video.getAttribute('src') || '', isVideo: true }));
    const seen = new Set<string>();
    return [...images, ...videos].filter((m) => m.src && !seen.has(m.src) && seen.add(m.src));
  }, [editedContent]);

  // Resolve a relative src (e.g. "/images/x.jpg") into an absolute URL, against the deployed
  // base path (e.g. "/Blog/") rather than just the domain root, so it also works on GitHub
  // Pages project sites as well as the local dev server
  const toAbsoluteUrl = (src: string): string => {
    try {
      const siteBase = new URL(import.meta.env.BASE_URL, window.location.origin);
      return new URL(src.replace(/^\//, ''), siteBase).href;
    } catch (e) {
      return src;
    }
  };

  // Copy an actual photo onto the clipboard as real image bytes — exactly what the browser
  // does for "우클릭 > 이미지 복사" — instead of an HTML/text reference to it. Chrome's
  // Clipboard API only accepts 'image/png' for writes, so any JPEG gets re-encoded via canvas.
  const copyImageToClipboard = async (src: string) => {
    try {
      const res = await fetch(toAbsoluteUrl(src));
      const blob = await res.blob();
      const bitmap = await createImageBitmap(blob);

      const canvas = document.createElement('canvas');
      canvas.width = bitmap.width;
      canvas.height = bitmap.height;
      const ctx = canvas.getContext('2d');
      if (!ctx) throw new Error('canvas 2d context unavailable');
      ctx.drawImage(bitmap, 0, 0);

      const pngBlob = await new Promise<Blob>((resolve, reject) => {
        canvas.toBlob((b) => (b ? resolve(b) : reject(new Error('toBlob failed'))), 'image/png');
      });

      await navigator.clipboard.write([new ClipboardItem({ 'image/png': pngBlob })]);
      setCopiedImageSrc(src);
      setTimeout(() => setCopiedImageSrc(null), 2500);
    } catch (e) {
      alert('사진 복사에 실패했습니다. 대신 다운로드 후 직접 올려주세요.');
    }
  };

  // Just the photo srcs, in the order they appear in the post — used to line up a bulk-
  // pasted list of Naver URLs with the right image without the user having to pair them up
  // one field at a time
  const imageSrcsInOrder = useMemo(() => mediaSources.filter((m) => !m.isVideo).map((m) => m.src), [mediaSources]);

  const persistNaverUrlMap = (next: Record<string, string>) => {
    setNaverUrlMap(next);
    localStorage.setItem('naverImageUrlMap', JSON.stringify(next));
  };

  const updateNaverUrl = (src: string, url: string) => {
    const next = { ...naverUrlMap };
    if (url.trim()) next[src] = url.trim();
    else delete next[src];
    persistNaverUrlMap(next);
  };

  // Fill each photo's Naver URL field in document order from one pasted block of URLs (one
  // per line) — matches how photos get inserted in order when dragged/selected as a batch
  // into a Naver draft
  const applyBulkUrls = () => {
    const urls = bulkUrlText.split('\n').map((line) => line.trim()).filter(Boolean);
    const next = { ...naverUrlMap };
    imageSrcsInOrder.forEach((src, i) => {
      if (urls[i]) next[src] = urls[i];
    });
    persistNaverUrlMap(next);
    setBulkUrlText('');
  };

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

  // Convert Markdown to Naver SmartEditor ONE formatted HTML (used for on-screen preview).
  // Post content references media with root-absolute paths like "/images/x.jpg", which the
  // browser resolves against the domain root — wrong once the app is served under a base path
  // (e.g. GitHub Pages project sites at "/Blog/"). Rewrite every img/video src through
  // toAbsoluteUrl so the preview (and the live site, which renders through this same path)
  // actually loads the file instead of 404ing.
  const getNaverFormattedHtml = (markdownText: string) => {
    try {
      const rawHtml = marked.parse(markdownText) as string;
      const container = document.createElement('div');
      container.innerHTML = rawHtml;
      container.querySelectorAll('img, video').forEach((el) => {
        const src = el.getAttribute('src');
        if (src) el.setAttribute('src', toAbsoluteUrl(src));
      });
      // Wrap with Naver SmartEditor inline styles
      return `
        <div style="font-family: 'Maru Buri', 'Nanum Gothic', sans-serif; color: #222222; font-size: 16px; line-height: 1.8;">
          ${container.innerHTML}
        </div>
      `;
    } catch (e) {
      return markdownText;
    }
  };

  // Build the HTML that actually goes on the clipboard. Text/formatting pastes cleanly into
  // Naver's editor on its own. Photos are trickier: Naver's paste sanitizer drops <img src>
  // pointing at an outside domain and strips data URIs outright, but it keeps one pointing at
  // its own CDN (postfiles.pstatic.net etc.) just fine — so any photo with a registered Naver
  // URL (see naverUrlMap) gets embedded for real, right where it sits in the article. Anything
  // without one yet (and all video, since browsers can't put video bytes on the clipboard at
  // all) falls back to a short manual-upload notice pointing at the list below.
  const buildNaverClipboardHtml = (markdownText: string, urlMap: Record<string, string>): string => {
    const rawHtml = marked.parse(markdownText) as string;
    const container = document.createElement('div');
    container.innerHTML = rawHtml;

    const replaceWithNotice = (el: Element, kind: string, src: string) => {
      const fileName = src.split('/').pop() || kind;
      const notice = document.createElement('p');
      notice.style.cssText = 'padding:12px 16px;background:#f2f5f3;border-left:4px solid #03C75A;color:#333;';
      notice.textContent = `[${kind}: ${fileName}] 아래 "사진·동영상 다운로드" 목록에서 파일을 저장한 뒤, 네이버 에디터의 사진/동영상 추가 버튼으로 직접 올려주세요.`;
      el.replaceWith(notice);
    };

    container.querySelectorAll('img').forEach((img) => {
      const src = img.getAttribute('src') || '';
      const naverUrl = urlMap[src];
      if (naverUrl) img.setAttribute('src', naverUrl);
      else replaceWithNotice(img, '사진', src);
    });
    container.querySelectorAll('video').forEach((video) => replaceWithNotice(video, '동영상', video.getAttribute('src') || ''));

    return `
      <div style="font-family: 'Maru Buri', 'Nanum Gothic', sans-serif; color: #222222; font-size: 16px; line-height: 1.8;">
        ${container.innerHTML}
      </div>
    `;
  };

  // One-click Copy for Naver SmartEditor
  const handleCopyToNaver = async () => {
    const htmlContent = buildNaverClipboardHtml(editedContent, naverUrlMap);
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
            클립보드에 복사되었습니다! 네이버 블로그 글쓰기 창에서 [Ctrl + V]를 눌러 붙여넣으세요. (네이버 URL이 등록된 사진은 그 자리에 그대로 포함됩니다. 미등록 사진은 안내 문구로, 동영상은 다운로드해 직접 올려주세요)
          </div>
        )}

        {/* Naver URL registration: photos with a registered pstatic.net URL get embedded for
            real when "네이버 스마트에디터용 복사" runs (see buildNaverClipboardHtml), so the
            whole article + inline photos paste in one shot, matching what already works when
            copying an existing, previously-published Naver post. New photos still need one
            manual round trip through Naver's own upload button to get that URL in the first
            place — nothing client-side can skip that — but "사진 복사" below makes that trip
            fast, and pasting the resulting URLs here can be done all at once, in order. */}
        {mediaSources.length > 0 && (
          <div style={{
            background: 'rgba(255, 255, 255, 0.04)',
            border: '1px solid var(--border-color)',
            borderRadius: '10px',
            padding: '14px 18px',
            display: 'flex',
            flexDirection: 'column',
            gap: '12px'
          }}>
            <div style={{ display: 'flex', alignItems: 'center', gap: '8px', fontSize: '0.88rem', fontWeight: 600, color: 'var(--text-muted)' }}>
              <Film size={16} color="#03C75A" />
              네이버 URL이 등록된 사진은 복사 시 자동으로 포함됩니다. 아직 없다면 "사진 복사"로 네이버에 한 번 올린 뒤, 그 주소를 아래에 등록해 주세요.
            </div>

            {imageSrcsInOrder.length > 0 && (
              <div style={{ display: 'flex', flexDirection: 'column', gap: '6px' }}>
                <span style={{ fontSize: '0.78rem', color: 'var(--text-muted)' }}>
                  네이버에 올린 순서대로 사진 주소를 한 줄에 하나씩 붙여넣으면, 이 글의 사진 순서에 맞춰 한 번에 등록됩니다.
                </span>
                <textarea
                  value={bulkUrlText}
                  onChange={(e) => setBulkUrlText(e.target.value)}
                  placeholder={'https://postfiles.pstatic.net/...\nhttps://postfiles.pstatic.net/...'}
                  style={{
                    width: '100%',
                    height: '70px',
                    background: '#090d16',
                    color: '#f8fafc',
                    border: '1px solid var(--border-color)',
                    borderRadius: '8px',
                    padding: '10px 12px',
                    fontFamily: 'monospace',
                    fontSize: '0.8rem',
                    resize: 'vertical'
                  }}
                />
                <button
                  onClick={applyBulkUrls}
                  className="btn-secondary"
                  style={{ alignSelf: 'flex-start', fontSize: '0.82rem', padding: '6px 12px' }}
                  disabled={!bulkUrlText.trim()}
                >
                  순서대로 채우기
                </button>
              </div>
            )}

            <div style={{ display: 'flex', flexDirection: 'column', gap: '8px' }}>
              {mediaSources.map(({ src, isVideo }) => (
                <div key={src} style={{ display: 'flex', alignItems: 'center', gap: '6px', flexWrap: 'wrap' }}>
                  {!isVideo && (
                    <button
                      onClick={() => copyImageToClipboard(src)}
                      className="btn-secondary"
                      style={{ fontSize: '0.82rem', padding: '6px 12px' }}
                    >
                      {copiedImageSrc === src ? <Check size={14} /> : <Copy size={14} />}
                      {copiedImageSrc === src ? '복사됨!' : '사진 복사'}
                    </button>
                  )}
                  <a
                    href={toAbsoluteUrl(src)}
                    download
                    className="btn-secondary"
                    style={{ fontSize: '0.82rem', padding: '6px 12px' }}
                  >
                    <Download size={14} />
                    다운로드
                  </a>
                  <span style={{ fontSize: '0.78rem', color: 'var(--text-muted)', minWidth: '90px' }}>
                    {src.split('/').pop()}
                  </span>
                  {!isVideo && (
                    <input
                      type="text"
                      value={naverUrlMap[src] || ''}
                      onChange={(e) => updateNaverUrl(src, e.target.value)}
                      placeholder="네이버 사진 URL 붙여넣기"
                      style={{
                        flex: 1,
                        minWidth: '220px',
                        background: '#090d16',
                        color: '#f8fafc',
                        border: `1px solid ${naverUrlMap[src] ? '#03C75A' : 'var(--border-color)'}`,
                        borderRadius: '6px',
                        padding: '5px 10px',
                        fontSize: '0.78rem'
                      }}
                    />
                  )}
                  {!isVideo && naverUrlMap[src] && (
                    <span style={{ fontSize: '0.75rem', color: '#03C75A', fontWeight: 600 }}>✓ 등록됨</span>
                  )}
                </div>
              ))}
            </div>
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
