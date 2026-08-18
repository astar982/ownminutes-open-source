import type { Metadata } from "next";
import "./globals.css";

export const metadata: Metadata = {
  title: "OwnMinutes",
  description: "实时会议记录、总结、分享和 Obsidian 沉淀工具",
};

export default function RootLayout({
  children,
}: Readonly<{
  children: React.ReactNode;
}>) {
  return (
    <html lang="zh-CN" className="h-full antialiased">
      <body className="min-h-full flex flex-col">{children}</body>
    </html>
  );
}
