"use client";

import Link from "next/link";
import { usePathname, useRouter } from "next/navigation";

import { ChevronRight } from "lucide-react";

import { Collapsible, CollapsibleContent, CollapsibleTrigger } from "@/components/ui/collapsible";
import {
  SidebarGroup,
  SidebarGroupContent,
  SidebarGroupLabel,
  SidebarMenu,
  SidebarMenuBadge,
  SidebarMenuButton,
  SidebarMenuItem,
  SidebarMenuSub,
  SidebarMenuSubButton,
  SidebarMenuSubItem,
  useSidebar,
} from "@/components/ui/sidebar";
import { getActiveConversationId } from "@/lib/ai/conversations";
import { agentWorkbenchRolloutEnabled } from "@/lib/features/agent-rollout";
import { cn } from "@/lib/utils";
import type {
  NavBadge,
  NavGroup,
  NavMainItem,
  NavMainLinkItem,
  NavMainParentItem,
} from "@/navigation/sidebar/sidebar-items";
import { usePreferencesStore } from "@/stores/preferences/preferences-provider";

interface NavMainProps {
  readonly items: readonly NavGroup[];
}

interface NavItemProps {
  readonly item: NavMainItem;
  readonly isItemActive: (item: NavMainItem) => boolean;
  readonly isSubItemActive: (url: string) => boolean;
  readonly isSubmenuOpen: (item: NavMainParentItem) => boolean;
}

interface NavLinkItemProps {
  readonly item: NavMainLinkItem;
  readonly isActive: boolean;
  readonly showIconFallback: boolean;
}

interface NavDropdownItemProps {
  readonly item: NavMainParentItem;
  readonly isActive: boolean;
  readonly isSubItemActive: (url: string) => boolean;
}

interface NavCollapsibleItemProps {
  readonly item: NavMainParentItem;
  readonly isActive: boolean;
  readonly defaultOpen: boolean;
  readonly isSubItemActive: (url: string) => boolean;
}

function CollapsedIconFallback({ title }: { title: string }) {
  return (
    <span className="flex size-4 shrink-0 items-center justify-center rounded-xs font-medium text-[10px] outline">
      {title.slice(0, 1)}
    </span>
  );
}

function hasSubItems(item: NavMainItem): item is NavMainParentItem {
  return Boolean(item.subItems?.length);
}

export function NavMain({ items }: NavMainProps) {
  const pathname = usePathname();
  const path = pathname || "";
  const visibleItems = items.map((group) => ({
    ...group,
    items: group.items.filter((item) => item.rollout !== "agent-workbench" || agentWorkbenchRolloutEnabled(path)),
  }));

  const isItemActive = (item: NavMainItem) => {
    if (item.tool) return path.endsWith(`/tools/${item.tool}`);
    if (hasSubItems(item)) {
      return item.subItems.some((sub) => path.startsWith(sub.url));
    }
    return path === item.url;
  };

  const isSubItemActive = (url: string) => path === url;
  const isSubmenuOpen = (item: NavMainParentItem) => item.subItems.some((sub) => path.startsWith(sub.url));

  return (
    <>
      {visibleItems.map((group) => (
        <Collapsible key={group.id} defaultOpen className="group/collapsible">
          <SidebarGroup>
            <CollapsibleTrigger asChild>
              <SidebarGroupLabel className="cursor-pointer font-semibold text-muted-foreground text-xs uppercase tracking-wider transition-colors hover:text-foreground">
                <ChevronRight className="size-4 transition-transform duration-200 group-data-[state=open]/collapsible:rotate-90" />
                {group.label}
              </SidebarGroupLabel>
            </CollapsibleTrigger>
            <CollapsibleContent>
              <SidebarGroupContent>
                <SidebarMenu>
                  {group.items.map((item) => (
                    <NavItem
                      key={item.id}
                      item={item}
                      isItemActive={isItemActive}
                      isSubItemActive={isSubItemActive}
                      isSubmenuOpen={isSubmenuOpen}
                    />
                  ))}
                </SidebarMenu>
              </SidebarGroupContent>
            </CollapsibleContent>
          </SidebarGroup>
        </Collapsible>
      ))}
    </>
  );
}

function NavItem({ item, isItemActive, isSubItemActive, isSubmenuOpen }: NavItemProps) {
  const { state, isMobile } = useSidebar();
  const isCollapsedDesktop = state === "collapsed" && !isMobile;

  if (!hasSubItems(item)) {
    return <NavLinkItem item={item} isActive={isItemActive(item)} showIconFallback={isCollapsedDesktop} />;
  }

  if (isCollapsedDesktop) {
    return <NavDropdownItem item={item} isActive={isItemActive(item)} isSubItemActive={isSubItemActive} />;
  }

  return (
    <NavCollapsibleItem
      item={item}
      isActive={isItemActive(item)}
      defaultOpen={isSubmenuOpen(item)}
      isSubItemActive={isSubItemActive}
    />
  );
}

function NavLinkItem({ item, isActive, showIconFallback }: NavLinkItemProps) {
  const Icon = item.icon;
  const setWorkspaceTool = usePreferencesStore((s) => s.setWorkspaceTool);
  const router = useRouter();

  const handleToolClick = () => {
    if (item.tool) {
      const tool = item.tool === "close" ? null : item.tool;
      setWorkspaceTool(tool);
      const conversationId = getActiveConversationId();
      if (conversationId) {
        router.replace(
          tool
            ? `/studio/session/${encodeURIComponent(conversationId)}/tools/${encodeURIComponent(tool)}`
            : `/studio/session/${encodeURIComponent(conversationId)}`,
        );
      }
    }
  };

  if (item.disabled) {
    return (
      <SidebarMenuItem>
        <SidebarMenuButton aria-disabled tooltip={item.title}>
          {Icon ? <Icon /> : showIconFallback ? <CollapsedIconFallback title={item.title} /> : null}
          <span className="text-muted-foreground/50">{item.title}</span>
          {item.badge && <NavItemBadge badge={item.badge} />}
        </SidebarMenuButton>
      </SidebarMenuItem>
    );
  }

  // 工具项
  if (item.tool) {
    return (
      <SidebarMenuItem>
        <SidebarMenuButton
          aria-disabled={item.disabled}
          tooltip={item.title}
          isActive={isActive}
          onClick={handleToolClick}
        >
          {Icon ? <Icon /> : showIconFallback ? <CollapsedIconFallback title={item.title} /> : null}
          <span>{item.title}</span>
        </SidebarMenuButton>
        <NavItemBadge badge={item.badge} />
      </SidebarMenuItem>
    );
  }

  // 普通链接项
  return (
    <SidebarMenuItem>
      <SidebarMenuButton asChild aria-disabled={item.disabled} tooltip={item.title} isActive={isActive}>
        <Link
          prefetch={false}
          href={item.url}
          target={item.newTab ? "_blank" : undefined}
          rel={item.newTab ? "noreferrer" : undefined}
        >
          {Icon ? <Icon /> : showIconFallback ? <CollapsedIconFallback title={item.title} /> : null}
          <span>{item.title}</span>
        </Link>
      </SidebarMenuButton>
      <NavItemBadge badge={item.badge} />
    </SidebarMenuItem>
  );
}

function NavDropdownItem({ item, isActive, isSubItemActive }: NavDropdownItemProps) {
  const Icon = item.icon;
  const _setWorkspaceTool = usePreferencesStore((s) => s.setWorkspaceTool);

  return (
    <SidebarMenuItem>
      <SidebarMenuButton tooltip={item.title} isActive={isActive} disabled={item.disabled}>
        {Icon ? <Icon /> : <CollapsedIconFallback title={item.title} />}
        <span>{item.title}</span>
      </SidebarMenuButton>
    </SidebarMenuItem>
  );
}

function NavCollapsibleItem({ item, isActive, defaultOpen, isSubItemActive }: NavCollapsibleItemProps) {
  const Icon = item.icon;
  const setWorkspaceTool = usePreferencesStore((s) => s.setWorkspaceTool);

  return (
    <Collapsible asChild defaultOpen={defaultOpen} className="group/collapsible">
      <SidebarMenuItem>
        <CollapsibleTrigger asChild>
          <SidebarMenuButton tooltip={item.title} isActive={isActive} disabled={item.disabled}>
            {Icon && <Icon />}
            <span>{item.title}</span>
            <ChevronRight className="ml-auto transition-transform duration-200 group-data-[state=open]/collapsible:rotate-90" />
          </SidebarMenuButton>
        </CollapsibleTrigger>
        <NavItemBadge badge={item.badge} />

        <CollapsibleContent>
          <SidebarMenuSub>
            {item.subItems.map((subItem) => {
              const SubIcon = subItem.icon;

              // 工具子项
              if (subItem.tool) {
                return (
                  <SidebarMenuSubItem key={subItem.id}>
                    <SidebarMenuSubButton aria-disabled={subItem.disabled}>
                      <Link
                        prefetch={false}
                        href={subItem.url}
                        onClick={() => setWorkspaceTool((subItem.tool === "close" ? null : subItem.tool) ?? null)}
                      >
                        {SubIcon && <SubIcon />}
                        <span>{subItem.title}</span>
                      </Link>
                    </SidebarMenuSubButton>
                  </SidebarMenuSubItem>
                );
              }

              return (
                <SidebarMenuSubItem key={subItem.id}>
                  <SidebarMenuSubButton
                    asChild
                    aria-disabled={subItem.disabled}
                    isActive={isSubItemActive(subItem.url)}
                  >
                    <Link
                      prefetch={false}
                      href={subItem.url}
                      target={subItem.newTab ? "_blank" : undefined}
                      rel={subItem.newTab ? "noreferrer" : undefined}
                    >
                      {SubIcon && <SubIcon />}
                      <span>{subItem.title}</span>
                    </Link>
                  </SidebarMenuSubButton>
                </SidebarMenuSubItem>
              );
            })}
          </SidebarMenuSub>
        </CollapsibleContent>
      </SidebarMenuItem>
    </Collapsible>
  );
}

function NavItemBadge({ badge }: { badge?: NavBadge }) {
  if (!badge) return null;

  return (
    <SidebarMenuBadge
      className={cn(
        "rounded-sm border capitalize",
        badge === "new" &&
          "border-green-600 text-green-600 peer-hover/menu-button:text-green-600 peer-data-active/menu-button:text-green-600",
        badge === "soon" && "border-muted-foreground text-muted-foreground",
      )}
    >
      {badge}
    </SidebarMenuBadge>
  );
}
