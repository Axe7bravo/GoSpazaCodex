import type { ReactNode } from "react";
import { MerchantShell } from "./shell";
export default function Layout({ children }: { children: ReactNode }) {
  return <MerchantShell>{children}</MerchantShell>;
}
