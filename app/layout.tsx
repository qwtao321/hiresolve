import type { Metadata } from "next";
import "./globals.css";

export const metadata: Metadata = {
  title: "HireSolve · AI 求职竞争力分析",
  description: "上传简历与岗位 JD，AI 秒出匹配度评分、STAR 改写建议与面试 5 问。",
};

export default function RootLayout({
  children,
}: Readonly<{
  children: React.ReactNode;
}>) {
  return (
    <html lang="zh-CN">
      <body className="antialiased">{children}</body>
    </html>
  );
}
