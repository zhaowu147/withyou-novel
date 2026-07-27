import type { ReactNode } from "react";

import { cookies } from "next/headers";

import { AppSidebar } from "@/app/(main)/_components/sidebar/app-sidebar";
import { SidebarInset, SidebarProvider } from "@/components/ui/sidebar";
import { SIDEBAR_COLLAPSIBLE_VALUES, SIDEBAR_VARIANT_VALUES } from "@/lib/preferences/layout";
import { getPreference } from "@/server/server-actions";

export default async function Layout({ children }: Readonly<{ children: ReactNode }>) {
  const cookieStore = await cookies();
  const defaultOpen = cookieStore.get("sidebar_state")?.value !== "false";

  // 本地模式: 无认证,直接取侧栏偏好
  const [variant, collapsible] = await Promise.all([
    getPreference("sidebar_variant", SIDEBAR_VARIANT_VALUES, "inset"),
    getPreference("sidebar_collapsible", SIDEBAR_COLLAPSIBLE_VALUES, "icon"),
  ]);

  const userData = {
    id: "local",
    name: "本地用户",
    email: "",
    avatar: "",
  };

  return (
    <SidebarProvider
      defaultOpen={defaultOpen}
      style={
        {
          "--sidebar-width": "calc(var(--spacing) * 68)",
        } as React.CSSProperties
      }
    >
      <AppSidebar variant={variant} collapsible={collapsible} user={userData} />
      <SidebarInset className="h-svh min-w-0 overflow-hidden peer-data-[variant=inset]:border">{children}</SidebarInset>
    </SidebarProvider>
  );
}
