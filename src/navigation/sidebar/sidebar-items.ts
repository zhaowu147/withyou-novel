import {
  BarChart3,
  Bookmark,
  BookOpen,
  Brain,
  BrainCircuit,
  FileText,
  Globe,
  ImageIcon,
  List,
  ListOrdered,
  type LucideIcon,
  Sliders,
  Sparkles,
  Store,
  Tag,
  User,
  Wand2,
} from "lucide-react";

export type NavBadge = "new" | "free" | "soon";

export interface NavSubItem {
  id: string;
  title: string;
  url: string;
  icon?: LucideIcon;
  badge?: NavBadge;
  disabled?: boolean;
  newTab?: boolean;
  tool?: string;
  rollout?: "agent-workbench";
}

interface NavItemBase {
  id: string;
  title: string;
  icon?: LucideIcon;
  badge?: NavBadge;
  disabled?: boolean;
  newTab?: boolean;
  tool?: string;
  rollout?: "agent-workbench";
}

export interface NavMainLinkItem extends NavItemBase {
  url: string;
  subItems?: never;
}

export interface NavMainParentItem extends NavItemBase {
  subItems: NavSubItem[];
}

export type NavMainItem = NavMainLinkItem | NavMainParentItem;

export interface NavGroup {
  id: string;
  label?: string;
  items: NavMainItem[];
}

// tool=close → 回到默认（关闭工具面板）
//
// 分组规则：
//   创作工具 (1-10) — Agent 生成内容，预览后用户确认落盘文件树
//   写作增强 (11-16) — 辅助功能，直接操作文件树或对话区
export const sidebarItems: NavGroup[] = [
  {
    id: "1",
    label: "创作工具",
    items: [
      {
        id: "book-name",
        title: "书名生成器",
        url: "#book-name",
        icon: Tag,
        badge: "new",
        tool: "book-name",
      },
      {
        id: "brainstorm",
        title: "脑洞生成器",
        url: "#brainstorm",
        icon: Brain,
        tool: "brainstorm",
      },
      {
        id: "outline",
        title: "大纲生成器",
        url: "#outline",
        icon: List,
        tool: "outline",
      },
      {
        id: "detailed-outline",
        title: "细纲生成器",
        url: "#detailed-outline",
        icon: ListOrdered,
        tool: "detailed-outline",
      },
      {
        id: "opening",
        title: "黄金开篇",
        url: "#opening",
        icon: Sparkles,
        tool: "opening",
      },
      {
        id: "character",
        title: "角色生成器",
        url: "#character",
        icon: User,
        tool: "character",
      },
      {
        id: "worldview",
        title: "世界观生成器",
        url: "#worldview",
        icon: Globe,
        tool: "worldview",
      },
      {
        id: "goldfinger",
        title: "金手指生成器",
        url: "#goldfinger",
        icon: Wand2,
        tool: "goldfinger",
      },
      {
        id: "synopsis",
        title: "简介生成器",
        url: "#synopsis",
        icon: FileText,
        tool: "synopsis",
      },
    ],
  },
  {
    id: "2",
    label: "写作增强",
    items: [
      {
        id: "cover",
        title: "封面生成",
        url: "#cover",
        icon: ImageIcon,
        tool: "cover",
      },
      {
        id: "entities",
        title: "实体卡片",
        url: "#entities",
        icon: User,
        tool: "entities",
      },
      {
        id: "foreshadow",
        title: "伏笔账本",
        url: "#foreshadow",
        icon: Bookmark,
        tool: "foreshadow",
      },
      {
        id: "story-graph",
        title: "故事世界图谱",
        url: "#story-graph",
        icon: Globe,
        badge: "new",
        tool: "story-graph",
      },
    ],
  },
  {
    id: "3",
    label: "工作台",
    items: [
      {
        id: "agent-workbench",
        title: "Agent 工作台",
        url: "#agent-workbench",
        icon: BrainCircuit,
        badge: "new",
        tool: "agent-workbench",
        rollout: "agent-workbench",
      },
      {
        id: "book-analysis",
        title: "AI拆书",
        url: "#book-analysis",
        icon: BookOpen,
        badge: "new",
        tool: "book-analysis",
      },
      {
        id: "stats",
        title: "写作统计",
        url: "#stats",
        icon: BarChart3,
        tool: "stats",
      },
      {
        id: "prompt-market",
        title: "提示词市场",
        url: "#prompt-market",
        icon: Store,
        badge: "new",
        tool: "prompt-market",
      },
      {
        id: "settings",
        title: "模型设置",
        url: "#settings",
        icon: Sliders,
        tool: "settings",
      },
    ],
  },
];
