import type { ReactNode } from "react";
import Link from "next/link";
import "./globals.css";

export const metadata = { title: "Work Ledger", description: "A durable record of work humans and agents share" };

export default function RootLayout({ children }: { children: ReactNode }) {
  return (
    <html lang="en">
      <body>
        <header className="topbar">
          <span className="brand">Work Ledger</span>
          <nav>
            <Link href="/work">Work</Link>
            <Link href="/workers">Workers</Link>
            <Link href="/runs">Runs</Link>
          </nav>
        </header>
        <main>{children}</main>
      </body>
    </html>
  );
}
