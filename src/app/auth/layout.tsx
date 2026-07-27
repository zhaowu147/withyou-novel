import type { ReactNode } from "react";

export default function AuthLayout({ children }: Readonly<{ children: ReactNode }>) {
  return <main className="min-h-dvh">{children}</main>;
}
