"use client";

import { StoryGraph3D } from "./story-graph-3d";

interface StoryGraphPanelProps {
  novelId: string;
  onClose: () => void;
}

/** 兼容旧组件入口，统一使用新的全屏故事世界图谱。 */
export function StoryGraphPanel(props: StoryGraphPanelProps) {
  return <StoryGraph3D {...props} />;
}
