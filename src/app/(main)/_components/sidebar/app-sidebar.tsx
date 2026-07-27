"use client";

import { useRouter } from "next/navigation";

import { LogOut } from "lucide-react";

import { Avatar, AvatarFallback, AvatarImage } from "@/components/ui/avatar";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import {
  Sidebar,
  SidebarContent,
  SidebarFooter,
  SidebarHeader,
  SidebarMenu,
  SidebarMenuButton,
  SidebarMenuItem,
} from "@/components/ui/sidebar";
import { APP_CONFIG } from "@/config/app-config";
import { AUTH_ROUTES } from "@/lib/auth/routes";
import { sidebarItems } from "@/navigation/sidebar/sidebar-items";

import { ConversationSidebar } from "../../_components/conversation-sidebar";
import { NavMain } from "./nav-main";

export function AppSidebar({
  user,
  ...props
}: React.ComponentProps<typeof Sidebar> & {
  user: {
    id?: string;
    name: string;
    email: string;
    avatar: string;
  };
}) {
  const router = useRouter();

  const handleLogout = async () => {
    await fetch(AUTH_ROUTES.logoutApi, { method: "POST" });
    router.push(AUTH_ROUTES.login);
  };

  return (
    <Sidebar {...props}>
      <SidebarHeader>
        <SidebarMenu>
          <SidebarMenuItem>
            <SidebarMenuButton>
              <span className="cursor-default font-semibold text-base">{APP_CONFIG.name}</span>
            </SidebarMenuButton>
          </SidebarMenuItem>
        </SidebarMenu>
      </SidebarHeader>
      <SidebarContent>
        <div className="px-2 pb-2">
          <ConversationSidebar />
        </div>
        <NavMain items={sidebarItems} />
      </SidebarContent>
      <SidebarFooter>
        <SidebarMenu>
          <SidebarMenuItem>
            <DropdownMenu>
              <DropdownMenuTrigger asChild>
                <SidebarMenuButton>
                  <Avatar className="size-5">
                    <AvatarImage src={user.avatar} />
                    <AvatarFallback>{user.name?.charAt(0)?.toUpperCase()}</AvatarFallback>
                  </Avatar>
                  <span className="text-sm">{user.name}</span>
                </SidebarMenuButton>
              </DropdownMenuTrigger>
              <DropdownMenuContent side="top" align="start" className="w-[--radix-popper-anchor-width]">
                <div className="px-2 py-1.5">
                  <p className="text-muted-foreground text-xs">{user.email}</p>
                </div>
                <DropdownMenuSeparator />
                <DropdownMenuItem onClick={handleLogout} className="cursor-pointer text-red-500 focus:text-red-500">
                  <LogOut className="size-4" />
                  <span>退出登录</span>
                </DropdownMenuItem>
              </DropdownMenuContent>
            </DropdownMenu>
          </SidebarMenuItem>
        </SidebarMenu>
      </SidebarFooter>
    </Sidebar>
  );
}
