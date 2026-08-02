# 📝 네이버 블로그 포스팅 매니저 & AI 사진 모자이크 스튜디오

네이버 블로그(Naver Blog) 운영자를 위한 **카테고리별 Markdown 원본 관리**, **AI 얼굴 자동 모자이크**, **네이버 스마트에디터 원클릭 복사**, **GitHub 영구 백업** 통합 웹 도구입니다.

---

## 🌟 핵심 기능

### 1. 📂 카테고리별 Markdown (.md) 원본 포스트 관리
- `posts/parenting/`: 육아 관련 마크다운 원본 글
- `posts/it/`: IT/테크 관련 마크다운 원본 글
- `posts/travel/`: 여행 관련 마크다운 원본 글
- 카테고리별 필터링, 새 글 작성, Markdown 실시간 수정 및 미리보기 지원.

### 2. 🎭 AI 사진 얼굴 자동 모자이크 스튜디오 (`/mosaic`)
- 인물 사진 선택 시 브라우저 내 AI가 사진 속 사람 얼굴을 **자동 감지**하여 모자이크/블러 적용.
- 모자이크 픽셀 크기 조절, 수동 영역 추가, 가이드 라인 켜기/끄기 지원.
- 100% 브라우저 온디바이스(Client-side) 처리로 인물 사진 외부 유출 위험 제로.
- 모자이크 처리된 사진 **1-Click 다운로드**.

### 3. 📋 네이버 스마트에디터 ONE 원클릭 변환기
- 마크다운으로 작성된 글을 네이버 스마트에디터 전용 서식(Maru Buri 폰트, 인용구, 본문 스타일, 표 등)으로 변환.
- **[네이버 스마트에디터용 복사]** 버튼 클릭 후 네이버 블로그 글쓰기 창에서 `Ctrl + V`만 누르면 서식이 적용된 상태로 붙여넣기 완료.

### 4. 🐙 GitHub 백업 및 버전 관리
- 작성한 포스트 원본(`.md`)과 모자이크 완료된 안전한 사진들을 GitHub 저장소에 밀어넣어 평생 안전하게 보존.

---

## 🚀 시작하기 및 로컬 실행

### 패키지 설치 및 개발 서버 실행
```bash
npm install
npm run dev
```
브라우저에서 `http://localhost:5173`으로 접속하여 포스팅 헬퍼 및 모자이크 스튜디오를 바로 사용할 수 있습니다.

### GitHub 저장소 연동하기
```bash
git init
git add .
git commit -m "feat: setup naver blog posts & mosaic helper"
git branch -M main
git remote add origin https://github.com/사용자아이디/naver-blog-vault.git
git push -u origin main
```
