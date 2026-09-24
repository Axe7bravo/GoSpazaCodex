import type { Metadata } from "next";
import type { ReactNode } from "react";
import "@gospaza/ui/tokens.css";
import "./globals.css";

export const metadata: Metadata = { title: "GoSpaza | Customer app", description: "GoSpaza application foundation" };
export default function Layout({ children }: { children: ReactNode }) {
  return <html lang="en-ZA"><body>{children}</body></html>;
}
