import type { ReactNode } from "react";

import { cookies } from "next/headers";

import { PiDock } from "@/app/(main)/_components/pi-dock";
import { AppSidebar } from "@/app/(main)/_components/sidebar/app-sidebar";
import { SidebarInset, SidebarProvider } from "@/components/ui/sidebar";
import { LOCAL_USER } from "@/lib/local/constants";
import { SIDEBAR_COLLAPSIBLE_VALUES, SIDEBAR_VARIANT_VALUES } from "@/lib/preferences/layout";
import { getPreference } from "@/server/server-actions";

export default async function StudioLayout({ children }: Readonly<{ children: ReactNode }>) {
  const cookieStore = await cookies();
  const defaultOpen = cookieStore.get("sidebar_state")?.value !== "false";

  // 本地模式：固定用户，无远端鉴权
  const userData = {
    id: LOCAL_USER.id,
    name: LOCAL_USER.user_metadata.full_name,
    email: LOCAL_USER.email,
    avatar: "",
  };

  const [variant, collapsible] = await Promise.all([
    getPreference("sidebar_variant", SIDEBAR_VARIANT_VALUES, "inset"),
    getPreference("sidebar_collapsible", SIDEBAR_COLLAPSIBLE_VALUES, "icon"),
  ]);

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
      <SidebarInset className="h-svh min-w-0 overflow-hidden peer-data-[variant=inset]:border">
        {children}
        <PiDock />
      </SidebarInset>
    </SidebarProvider>
  );
}
