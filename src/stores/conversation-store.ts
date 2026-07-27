"use client";

import { create } from "zustand";

interface ConversationState {
  currentId: string | null;
  setCurrentId: (id: string | null) => void;
}

export const useConversationStore = create<ConversationState>()((set) => ({
  currentId: null,
  setCurrentId: (id) => set({ currentId: id }),
}));
