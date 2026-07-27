"use client";

import { useCallback, useEffect, useMemo, useState } from "react";

import {
  Archive,
  ArchiveRestore,
  MessageSquare,
  MoreHorizontal,
  Pencil,
  Pin,
  PinOff,
  Plus,
  Search,
  Trash2,
} from "lucide-react";

import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import {
  type Conversation,
  createConversation,
  deleteConversation,
  getActiveConversationId,
  getAllConversations,
  isMeaningfulConversation,
  renameConversation,
  setConversationArchived,
  setConversationPinned,
} from "@/lib/ai/conversations";

function conversationLabel(conversation: Conversation): string {
  const projectName = conversation.draft?.novelName;
  if (projectName && projectName !== "我的作品") return projectName;
  return conversation.title && conversation.title !== "(新对话)" ? conversation.title : "新会话";
}

function relativeTime(timestamp: number): string {
  const delta = Date.now() - timestamp;
  const minute = 60_000;
  if (delta < minute) return "刚刚";
  if (delta < 60 * minute) return `${Math.floor(delta / minute)} 分钟前`;
  if (delta < 24 * 60 * minute) return `${Math.floor(delta / (60 * minute))} 小时前`;
  return new Date(timestamp).toLocaleDateString("zh-CN", { month: "numeric", day: "numeric" });
}

export function ConversationSidebar() {
  const [conversations, setConversations] = useState<Conversation[]>([]);
  const [activeId, setActiveId] = useState<string | null>(null);
  const [query, setQuery] = useState("");
  const [showArchived, setShowArchived] = useState(false);

  const refresh = useCallback(() => {
    setConversations(getAllConversations());
    setActiveId(getActiveConversationId());
  }, []);

  useEffect(() => {
    refresh();
    window.addEventListener("conversations-changed", refresh);
    window.addEventListener("select-conversation", refresh);
    window.addEventListener("new-conversation", refresh);
    return () => {
      window.removeEventListener("conversations-changed", refresh);
      window.removeEventListener("select-conversation", refresh);
      window.removeEventListener("new-conversation", refresh);
    };
  }, [refresh]);

  const visible = useMemo(() => {
    const normalized = query.trim().toLocaleLowerCase();
    return conversations
      .filter((conversation) => conversation.archived === showArchived)
      .filter((conversation) => conversation.id === activeId || isMeaningfulConversation(conversation))
      .filter((conversation) => {
        if (!normalized) return true;
        return `${conversationLabel(conversation)} ${conversation.title}`.toLocaleLowerCase().includes(normalized);
      })
      .sort((a, b) => Number(Boolean(b.pinned)) - Number(Boolean(a.pinned)) || b.updatedAt - a.updatedAt);
  }, [activeId, conversations, query, showArchived]);

  const selectConversation = (id: string) => {
    if (id === activeId) return;
    window.dispatchEvent(new CustomEvent("select-conversation", { detail: id }));
    window.history.replaceState(null, "", `/studio/session/${encodeURIComponent(id)}`);
    setActiveId(id);
  };

  const createNew = () => {
    const conversation = createConversation("(新对话)");
    window.dispatchEvent(new CustomEvent("new-conversation", { detail: conversation.id }));
    window.dispatchEvent(new CustomEvent("conversations-changed"));
    window.history.replaceState(null, "", `/studio/session/${encodeURIComponent(conversation.id)}`);
    setActiveId(conversation.id);
    refresh();
  };

  const removeConversation = (conversation: Conversation) => {
    if (!window.confirm(`删除“${conversationLabel(conversation)}”？此操作只删除会话索引，不会自动删除磁盘作品目录。`)) {
      return;
    }
    const wasActive = conversation.id === activeId;
    deleteConversation(conversation.id);
    const remaining = getAllConversations()
      .filter((item) => !item.archived)
      .sort((a, b) => b.updatedAt - a.updatedAt);
    if (wasActive) {
      const fallback = remaining[0] ?? createConversation("(新对话)");
      window.dispatchEvent(new CustomEvent("select-conversation", { detail: fallback.id }));
      window.history.replaceState(null, "", `/studio/session/${encodeURIComponent(fallback.id)}`);
      setActiveId(fallback.id);
    }
    window.dispatchEvent(new CustomEvent("conversations-changed"));
    refresh();
  };

  const rename = (conversation: Conversation) => {
    const next = window.prompt("会话名称", conversationLabel(conversation));
    if (!next?.trim()) return;
    renameConversation(conversation.id, next);
    window.dispatchEvent(new CustomEvent("conversations-changed"));
  };

  return (
    <section className="flex min-h-0 flex-col gap-2">
      <button
        type="button"
        onClick={createNew}
        className="flex h-9 w-full items-center gap-2 rounded-md border bg-background px-3 font-medium text-sm shadow-xs transition-colors hover:bg-accent"
      >
        <Plus className="size-4" />
        <span>新会话</span>
      </button>

      <div className="relative">
        <Search className="absolute top-1/2 left-2.5 size-3.5 -translate-y-1/2 text-muted-foreground" />
        <input
          value={query}
          onChange={(event) => setQuery(event.target.value)}
          placeholder="搜索会话"
          className="h-8 w-full rounded-md border bg-background pr-2 pl-8 text-xs outline-none focus:border-primary/50"
        />
      </div>

      <div className="flex items-center justify-between px-1">
        <span className="font-medium text-[11px] text-muted-foreground">{showArchived ? "已归档" : "最近会话"}</span>
        <button
          type="button"
          onClick={() => setShowArchived((current) => !current)}
          className="text-[11px] text-muted-foreground hover:text-foreground"
        >
          {showArchived ? "返回最近" : "查看归档"}
        </button>
      </div>

      <div className="max-h-56 space-y-0.5 overflow-y-auto pr-1">
        {visible.length === 0 ? (
          <div className="rounded-md border border-dashed px-3 py-5 text-center text-muted-foreground text-xs">
            {showArchived ? "暂无归档会话" : query ? "没有匹配会话" : "开始创作后，会话会出现在这里"}
          </div>
        ) : (
          visible.map((conversation) => {
            const active = conversation.id === activeId;
            return (
              <div
                key={conversation.id}
                className={`group flex items-center rounded-md transition-colors ${
                  active ? "bg-accent text-accent-foreground" : "hover:bg-accent/60"
                }`}
              >
                <button
                  type="button"
                  onClick={() => selectConversation(conversation.id)}
                  className="flex min-w-0 flex-1 items-center gap-2 px-2 py-1.5 text-left"
                >
                  {conversation.pinned ? (
                    <Pin className="size-3.5 shrink-0 text-primary" />
                  ) : (
                    <MessageSquare className="size-3.5 shrink-0 text-muted-foreground" />
                  )}
                  <span className="min-w-0 flex-1">
                    <span className="block truncate font-medium text-xs">{conversationLabel(conversation)}</span>
                    <span className="block truncate text-[10px] text-muted-foreground">
                      {conversation.novelId ? "已绑定作品" : "未立项"} · {relativeTime(conversation.updatedAt)}
                    </span>
                  </span>
                </button>

                <DropdownMenu>
                  <DropdownMenuTrigger asChild>
                    <button
                      type="button"
                      className="mr-1 rounded p-1 text-muted-foreground opacity-0 hover:bg-background hover:text-foreground group-hover:opacity-100 data-[state=open]:opacity-100"
                      aria-label="会话操作"
                    >
                      <MoreHorizontal className="size-3.5" />
                    </button>
                  </DropdownMenuTrigger>
                  <DropdownMenuContent side="right" align="start" className="w-36">
                    <DropdownMenuItem onClick={() => rename(conversation)}>
                      <Pencil className="size-3.5" /> 重命名
                    </DropdownMenuItem>
                    <DropdownMenuItem
                      onClick={() => {
                        setConversationPinned(conversation.id, !conversation.pinned);
                        window.dispatchEvent(new CustomEvent("conversations-changed"));
                      }}
                    >
                      {conversation.pinned ? <PinOff className="size-3.5" /> : <Pin className="size-3.5" />}
                      {conversation.pinned ? "取消置顶" : "置顶"}
                    </DropdownMenuItem>
                    <DropdownMenuItem
                      onClick={() => {
                        const archiving = !conversation.archived;
                        setConversationArchived(conversation.id, archiving);
                        if (archiving && conversation.id === activeId) {
                          const fallback =
                            getAllConversations()
                              .filter((item) => !item.archived && item.id !== conversation.id)
                              .sort((a, b) => b.updatedAt - a.updatedAt)[0] ?? createConversation("(新对话)");
                          window.dispatchEvent(new CustomEvent("select-conversation", { detail: fallback.id }));
                          window.history.replaceState(null, "", `/studio/session/${encodeURIComponent(fallback.id)}`);
                          setActiveId(fallback.id);
                        }
                        window.dispatchEvent(new CustomEvent("conversations-changed"));
                        refresh();
                      }}
                    >
                      {conversation.archived ? (
                        <ArchiveRestore className="size-3.5" />
                      ) : (
                        <Archive className="size-3.5" />
                      )}
                      {conversation.archived ? "移出归档" : "归档"}
                    </DropdownMenuItem>
                    <DropdownMenuSeparator />
                    <DropdownMenuItem
                      onClick={() => removeConversation(conversation)}
                      className="text-destructive focus:text-destructive"
                    >
                      <Trash2 className="size-3.5" /> 删除
                    </DropdownMenuItem>
                  </DropdownMenuContent>
                </DropdownMenu>
              </div>
            );
          })
        )}
      </div>
    </section>
  );
}
