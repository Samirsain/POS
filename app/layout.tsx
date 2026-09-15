import type { Metadata } from "next";
import Link from "next/link";
import AgentStatus from "./agent-status";
import "./globals.css";

export const metadata: Metadata = {
  title: "Plot Receipts",
  description: "Thermal receipt printing",
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en" className="h-full antialiased">
      <body className="min-h-full flex flex-col bg-neutral-100 text-neutral-900">
        <header className="flex items-center gap-4 border-b border-neutral-300 bg-white px-4 py-3">
          <nav className="flex gap-1 text-sm font-medium">
            <Link className="rounded px-3 py-1.5 hover:bg-neutral-100" href="/">
              New Receipt
            </Link>
            <Link className="rounded px-3 py-1.5 hover:bg-neutral-100" href="/queue">
              Queue
            </Link>
          </nav>
          <div className="ml-auto">
            <AgentStatus />
          </div>
        </header>
        <main className="flex-1 p-4">{children}</main>
      </body>
    </html>
  );
}
