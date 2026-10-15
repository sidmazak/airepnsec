import type { Metadata } from "next";
import { Geist, Geist_Mono } from "next/font/google";
import "./globals.css";
import { Toaster } from "@/components/ui/toaster";

const geistSans = Geist({
  variable: "--font-geist-sans",
  subsets: ["latin"],
});

const geistMono = Geist_Mono({
  variable: "--font-geist-mono",
  subsets: ["latin"],
});

export const metadata: Metadata = {
  title: "AI Secretary — self-hosted AI receptionist & back office",
  description: "Self-hosted AI receptionist with real bookings, invoices, ledger, knowledge retrieval and phone support. Bring your own AI provider (local Ollama or OpenAI-compatible) — your data stays yours.",
  keywords: ["AI receptionist", "AI secretary", "bookings", "invoices", "self-hosted", "Next.js", "TypeScript", "Tailwind CSS", "shadcn/ui"],
  authors: [{ name: "AI Secretary" }],
  icons: { icon: "/favicon.ico" },
  openGraph: {
    title: "AI Secretary",
    description: "Self-hosted AI receptionist with real bookings, invoices and ledger",
    type: "website",
  },
  twitter: {
    card: "summary_large_image",
    title: "AI Secretary",
    description: "Self-hosted AI receptionist with real bookings, invoices and ledger",
  },
};

export default function RootLayout({
  children,
}: Readonly<{
  children: React.ReactNode;
}>) {
  return (
    <html lang="en" suppressHydrationWarning>
      <body
        className={`${geistSans.variable} ${geistMono.variable} antialiased bg-background text-foreground`}
      >
        {children}
        <Toaster />
      </body>
    </html>
  );
}
