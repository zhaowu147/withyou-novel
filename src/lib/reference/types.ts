/** Legado / 阅读 书源子集类型 */

export interface BookSourceRules {
  bookList?: string;
  name?: string;
  author?: string;
  bookUrl?: string;
  coverUrl?: string;
  intro?: string;
  kind?: string;
  lastChapter?: string;
  wordCount?: string;
  checkKeyWord?: string;
  /** toc */
  chapterList?: string;
  chapterName?: string;
  chapterUrl?: string;
  nextTocUrl?: string;
  /** content */
  content?: string;
  nextContentUrl?: string;
  replaceRegex?: string;
  title?: string;
  /** bookInfo */
  tocUrl?: string;
  init?: string;
}

export interface BookSource {
  bookSourceName: string;
  bookSourceUrl: string;
  bookSourceType?: number;
  enabled?: boolean;
  enabledCookieJar?: boolean;
  weight?: number;
  respondTime?: number;
  searchUrl?: string;
  header?: string;
  exploreUrl?: string;
  ruleSearch?: BookSourceRules;
  ruleBookInfo?: BookSourceRules;
  ruleToc?: BookSourceRules;
  ruleContent?: BookSourceRules;
  /** 来源包文件名（调试） */
  _pack?: string;
}

export interface SearchHit {
  title: string;
  author: string;
  url: string;
  cover?: string;
  intro?: string;
  source: string;
  sourceUrl: string;
  lastChapter?: string;
}

export interface ChapterHit {
  title: string;
  url: string;
}

export interface ContentHit {
  title: string;
  content: string;
  prev: string | null;
  next: string | null;
  source?: string;
}
