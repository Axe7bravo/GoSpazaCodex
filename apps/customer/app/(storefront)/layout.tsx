import type { ReactNode } from "react";
import { StorefrontShell } from "./shell";
export default function Layout({ children }: { children: ReactNode }) {
  return <StorefrontShell>{children}</StorefrontShell>;
}
