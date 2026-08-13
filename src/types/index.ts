export type Category = '전체' | '육아' | 'IT' | '여행' | '주식' | '부동산';

export interface Post {
  id: string;
  title: string;
  category: Category;
  date: string;
  tags: string[];
  naverCategory: string;
  content: string;
  filePath: string;
}

export interface MosaicFaceArea {
  x: number;
  y: number;
  width: number;
  height: number;
  type: 'auto' | 'manual';
}
