import React, { useState } from 'react';
import { Header } from './components/Header';
import { PostManager } from './components/PostManager';
import { MosaicStudio } from './components/MosaicStudio';
import { GithubBackupManager } from './components/GithubBackupManager';
import { Post } from './types';

// Sample Posts Data
const samplePosts: Post[] = [
  {
    id: 'post-1',
    title: '초보 부모를 위한 신생아 수면 교육 팁 5가지',
    category: '육아',
    date: '2026-08-02',
    tags: ['육아', '신생아', '수면교육', '육아일기'],
    naverCategory: '육아일기',
    filePath: 'posts/parenting/first-baby-care.md',
    content: `# 초보 부모를 위한 신생아 수면 교육 팁 5가지

안녕하세요! 오늘 육아 일기에서는 신생아를 키우면서 가장 힘들고도 중요한 **수면 교육**에 대해 이야기해 보려고 합니다.

아기가 밤에 깨지 않고 푹 자는 것은 아기의 성장발달뿐만 아니라 부모의 정신 건강에도 정말 중요한데요. 저희 아이에게 직접 적용해 보고 효과를 본 핵심 팁 5가지를 정리해 드립니다!

---

## 1. 낮과 밤의 환경 차이 확실히 해주기

아기는 처음 태어났을 때 낮과 밤의 개념이 없습니다.

- **낮 시간**: 커튼을 환하게 열고 집안 소음(청소기 소리, 백색소음 등)을 적당히 들려줍니다.
- **밤 시간**: 조명을 최소한(수유등)으로 줄이고, 조용하고 정숙한 분위기를 만들어 줍니다.

> 💡 **Tip**: 밤에 수유하거나 기저귀를 갈 때도 말을 크게 걸지 않고 조용히 처리해 주는 것이 포인트입니다!

---

## 2. 수면 의식(Bedtime Routine) 만들기

매일 밤 같은 순서로 행동을 반복하면 아기는 "아, 이제 자야 할 시간이구나!" 하고 인식하게 됩니다.

1. **따뜻한 물로 목욕하기**
2. **베이비 로션으로 마사지해주기**
3. **속싸개 싸고 자장가 불러주기**
4. **소등 후 침대에 눕히기**

---

## 요약 테이블

| 단계 | 수면 교육 활동 | 핵심 효과 |
| --- | --- | --- |
| 1단계 | 낮/밤 환경 분리 | 멜라토닌 분비 촉진 |
| 2단계 | 일관된 수면 의식 | 정서적 안점감 제공 |
| 3단계 | 스스로 잠들기 훈련 | 밤중 깸 최소화 |

다음 포스팅에서는 **개월수별 수유량 조절 방법**에 대해 공유하도록 하겠습니다. 육아맘 & 육아빠 모두 화이팅입니다! 😊`
  },
  {
    id: 'post-2',
    title: '개발자와 블로거를 위한 저소음 기계식 키보드 추천 Top 3',
    category: 'IT',
    date: '2026-08-01',
    tags: ['IT', '키보드', '테크리뷰', '생산성', '개발자'],
    naverCategory: 'IT·컴퓨터',
    filePath: 'posts/it/keyboard-recommendation.md',
    content: `# 개발자와 블로거를 위한 저소음 기계식 키보드 추천 Top 3

오랜 시간 키보드를 치는 개발자나 블로거에게 손목 피로감을 줄여주고 타건감이 좋은 키보드는 필수 아이템입니다.

오늘은 사무실이나 집에서 시끄럽지 않게 사용할 수 있는 **저소음 기계식 키보드** 추천 제품 3가지를 정리해보았습니다.

---

## 1. 토프레 무접점 Realforce R3 (저소음 적축)

무접점 키보드의 끝판왕이라 불리는 리얼포스입니다.

- **장점**: 서걱서걱하는 독보적인 타건감, 손목 피로도 최소화, 뛰어난 내구성
- **단점**: 높은 가격대 (30만 원 후반~40만 원대)

> 💬 *"한 번 무접점에 적응하면 다른 키보드로 돌아가기 힘들다"*는 말이 괜히 있는 게 아니죠!

---

## 2. 한성컴퓨터 GK893B Sports 무접점

가성비 좋은 무접점 키보드를 찾으신다면 좋은 선택입니다.

- **장점**: 블루투스 멀티페어링 지원, 도각거리는 경쾌한 타건음, 깔끔한 미니멀 디자인
- **가격**: 10만 원 후반대

---

## 3. 키크론 Q1 Pro (저소음 적축 커스텀)

커스텀 알루미늄 키보드의 감성을 느끼고 싶으신 분들께 추천합니다.

- 풀 알루미늄 하우징으로 묵직하고 안정적인 타건감
- 핫스왑 지원으로 언제든 스위치 교체 가능

본인에게 꼭 맞는 키보드로 생산성을 극대화해 보세요! 네이버 블로그 포스팅 시 도움이 되셨길 바랍니다.`
  },
  {
    id: 'post-3',
    title: '2박 3일 제주도 감성 여행 코스 & 필수 맛집 총정리',
    category: '여행',
    date: '2026-07-28',
    tags: ['여행', '제주도', '국내여행', '제주맛집', '여행코스'],
    naverCategory: '국내여행',
    filePath: 'posts/travel/jeju-weekend-trip.md',
    content: `# 2박 3일 제주도 감성 여행 코스 & 필수 맛집 총정리

푸른 바다와 고즈넉한 숲길을 만끽할 수 있는 제주도 2박 3일 코스를 알차게 소개해 드립니다!

가족, 연인, 혹은 홀로 떠나는 힐링 여행을 계획 중이신 분들은 주목해 주세요 🌊

---

## Day 1: 애월 해안도로 & 서쪽 일몰 코스

1. **제주 공항 도착** ➔ 렌터카 수령
2. **애월 한담해변 산책로**: 에메랄드빛 바다 보며 커피 한 잔의 여유!
3. **협재 해수욕장**: 비양도를 배경으로 멋진 인생샷 남기기 📸

> ⚠️ **사진 찍을 때 주의사항**: 사람이 많은 해변에서는 촬영 후 인물 얼굴 모자이크 처리를 해주는 매너가 필수입니다!

---

## Day 2: 안돌오름 비밀의 숲 & 성산일출봉

- **안돌오름 비밀의 숲**: 편백나무 숲길 사이로 햇살이 비추는 몽환적인 스팟
- **성산일출봉 근처 흑돼지 맛집**: 숯불 향이 가득한 오겹살과 멜젓의 조화!

---

## 여행 준비 꿀팁 체크리스트

- [x] 항공권 및 렌터카 예약
- [x] 제주 안심코드 및 카메라이동 장비 챙기기
- [x] 네이버 블로그에 업로드할 사진 얼굴 모자이크 처리 툴 준비

여행은 준비할 때부터 마음이 설레죠. 모두 안전하고 행복한 여행 되시길 바랍니다! ✈️`
  }
];

export const App: React.FC = () => {
  const [activeTab, setActiveTab] = useState<'posts' | 'mosaic' | 'github'>('posts');

  return (
    <div style={{ maxWidth: '1280px', margin: '0 auto', padding: '24px 16px' }}>
      {/* Top Navigation Header */}
      <Header activeTab={activeTab} setActiveTab={setActiveTab} />

      {/* Main Tab Content */}
      <main>
        {activeTab === 'posts' && <PostManager initialPosts={samplePosts} />}
        {activeTab === 'mosaic' && <MosaicStudio />}
        {activeTab === 'github' && <GithubBackupManager />}
      </main>

      {/* Footer */}
      <footer style={{ marginTop: '40px', textAlign: 'center', color: 'var(--text-muted)', fontSize: '0.85rem', padding: '20px 0' }}>
        <p>네이버 블로그 포스팅 매니저 & AI 모자이크 스튜디오 © 2026. GitHub Markdown Powered.</p>
      </footer>
    </div>
  );
};

export default App;
