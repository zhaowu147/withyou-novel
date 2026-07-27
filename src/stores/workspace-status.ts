"use client";

import { create } from "zustand";

export type WorkspaceSaveStatus = "idle" | "saving" | "saved" | "error";

interface WorkspaceStatusState {
  conversationId: string | null;
  saveStatus: WorkspaceSaveStatus;
  setSaveStatus: (conversationId: string | null, saveStatus: WorkspaceSaveStatus) => void;
  activateWorkspace: (conversationId: string | null) => void;
}

export const useWorkspaceStatusStore = create<WorkspaceStatusState>((set) => ({
  conversationId: null,
  saveStatus: "idle",
  setSaveStatus: (conversationId, saveStatus) =>
    set((state) => (state.conversationId === conversationId ? { saveStatus } : state)),
  activateWorkspace: (conversationId) => set({ conversationId, saveStatus: "idle" }),
}));
