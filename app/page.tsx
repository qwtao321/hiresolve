"use client";

import { useState, useRef, useCallback } from "react";

// ─── Types ───────────────────────────────────────────────────────────────────
interface RewriteSuggestion {
  original: string;
  improved: string;
  tip: string;
}
interface InterviewQA {
  question: string;
  answer: string;
}
interface AnalysisResult {
  matchScore: number;
  suggestions: RewriteSuggestion[];
  interviewQA: InterviewQA[];
}
type ParseState = "idle" | "parsing" | "done" | "error";

// ─── File Parsing ─────────────────────────────────────────────────────────────
const ACCEPT = ".txt,.md,.pdf,.jpg,.jpeg,.png,.webp,.gif";
const IMAGE_TYPES = ["image/jpeg", "image/png", "image/webp", "image/gif"];

async function extractPdfText(file: File): Promise<string> {
  // Lazy-load pdfjs-dist only on the client, avoiding SSR DOMMatrix errors
  const pdfjsLib = await import("pdfjs-dist");
  pdfjsLib.GlobalWorkerOptions.workerSrc = "/pdf.worker.min.mjs";

  const buffer = await file.arrayBuffer();
  const pdf = await pdfjsLib.getDocument({ data: buffer }).promise;
  const pages: string[] = [];
  for (let i = 1; i <= pdf.numPages; i++) {
    const page = await pdf.getPage(i);
    const content = await page.getTextContent();
    const lineText = content.items
      .map((item) => ("str" in item ? item.str : ""))
      .join(" ");
    pages.push(lineText);
  }
  return pages.join("\n");
}

async function readFileAsText(file: File): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = (e) => resolve((e.target?.result as string) ?? "");
    reader.onerror = reject;
    reader.readAsText(file, "utf-8");
  });
}

async function readFileAsDataURL(file: File): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = (e) => resolve((e.target?.result as string) ?? "");
    reader.onerror = reject;
    reader.readAsDataURL(file);
  });
}

/** Resize image to max 1024px on longest side and re-encode as JPEG (quality 0.85).
 *  Keeps base64 payload well under GLM's size limit. */
async function compressImage(file: File): Promise<string> {
  const raw = await readFileAsDataURL(file);
  return new Promise((resolve) => {
    const img = new Image();
    img.onload = () => {
      const MAX = 1024;
      let { width, height } = img;
      if (width > MAX || height > MAX) {
        if (width >= height) { height = Math.round((height / width) * MAX); width = MAX; }
        else { width = Math.round((width / height) * MAX); height = MAX; }
      }
      const canvas = document.createElement("canvas");
      canvas.width = width;
      canvas.height = height;
      canvas.getContext("2d")!.drawImage(img, 0, 0, width, height);
      resolve(canvas.toDataURL("image/jpeg", 0.85));
    };
    img.onerror = () => resolve(raw); // fallback to original
    img.src = raw;
  });
}

async function parseFile(file: File): Promise<{ text: string; preview?: string }> {
  if (file.type === "application/pdf") {
    const text = await extractPdfText(file);
    return { text };
  }
  if (IMAGE_TYPES.includes(file.type)) {
    // Compress to ≤1024px / JPEG 0.85 before sending to GLM vision API
    const compressed = await compressImage(file);
    const placeholder =
      `[图片文件：${file.name}（${(file.size / 1024).toFixed(0)} KB）]\n` +
      `图片已压缩上传，GLM 视觉模型将直接读取图片内容进行分析。`;
    return { text: placeholder, preview: compressed };
  }
  // .txt / .md
  const text = await readFileAsText(file);
  return { text };
}

// ─── Real API Call ────────────────────────────────────────────────────────────
async function callAnalyzeAPI(
  resume: string,
  jd: string,
  resumeImage?: string,
  jdImage?: string
): Promise<AnalysisResult> {
  const res = await fetch("/api/analyze", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ resume, jd, resumeImage, jdImage }),
  });

  if (!res.ok) {
    const err = await res.json().catch(() => ({ error: "Unknown error" }));
    throw new Error(err.error ?? `HTTP ${res.status}`);
  }

  return res.json();
}

// ─── Score Color Helper ───────────────────────────────────────────────────────
function getScoreColor(score: number): string {
  if (score >= 80) return "#22c55e";
  if (score >= 60) return "#f59e0b";
  return "#ef4444";
}

// ─── Neumorphic Card ─────────────────────────────────────────────────────────
function NeuCard({
  children,
  className = "",
  hover = true,
}: {
  children: React.ReactNode;
  className?: string;
  hover?: boolean;
}) {
  const [lifted, setLifted] = useState(false);
  return (
    <div
      className={`rounded-2xl transition-all duration-300 ${className}`}
      style={{
        background: "#E8EBF0",
        boxShadow: lifted
          ? "10px 10px 24px #c5c9d1, -10px -10px 24px #ffffff"
          : "6px 6px 16px #c5c9d1, -6px -6px 16px #ffffff",
        transform: lifted ? "translateY(-3px)" : "translateY(0)",
      }}
      onMouseEnter={() => hover && setLifted(true)}
      onMouseLeave={() => hover && setLifted(false)}
    >
      {children}
    </div>
  );
}

// ─── Upload Button ────────────────────────────────────────────────────────────
function UploadButton({
  onClick,
  parsing,
}: {
  onClick: () => void;
  parsing: boolean;
}) {
  return (
    <button
      onClick={onClick}
      disabled={parsing}
      className="flex items-center gap-1.5 text-xs text-[#5b6af0] px-4 py-2 rounded-lg transition-all duration-200 disabled:opacity-50 disabled:cursor-wait"
      style={{
        background: "#E8EBF0",
        boxShadow: "3px 3px 8px #c5c9d1, -3px -3px 8px #ffffff",
      }}
      onMouseEnter={(e) => {
        if (!parsing)
          e.currentTarget.style.boxShadow =
            "inset 2px 2px 5px #c5c9d1, inset -2px -2px 5px #ffffff";
      }}
      onMouseLeave={(e) => {
        e.currentTarget.style.boxShadow =
          "3px 3px 8px #c5c9d1, -3px -3px 8px #ffffff";
      }}
    >
      {parsing ? (
        <>
          <svg className="animate-spin h-3 w-3" viewBox="0 0 24 24" fill="none">
            <circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4" />
            <path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4z" />
          </svg>
          解析中…
        </>
      ) : (
        <>↑ 上传文件</>
      )}
    </button>
  );
}

// ─── Image Preview ────────────────────────────────────────────────────────────
function ImagePreview({ src, onClear }: { src: string; onClear: () => void }) {
  return (
    <div className="mt-3 flex items-center gap-3">
      <div
        className="relative w-14 h-14 rounded-lg overflow-hidden flex-shrink-0"
        style={{ boxShadow: "inset 2px 2px 5px #c5c9d1, inset -2px -2px 5px #ffffff" }}
      >
        {/* eslint-disable-next-line @next/next/no-img-element */}
        <img src={src} alt="preview" className="w-full h-full object-cover" />
      </div>
      <div className="flex-1 min-w-0">
        <p className="text-[11px] text-[#5b6af0]">图片已上传</p>
        <p className="text-[10px] text-[#9aa0bb] mt-0.5 leading-snug">
          接入 OCR 服务后可自动识别文字，当前以文件信息参与模拟分析
        </p>
      </div>
      <button
        onClick={onClear}
        className="text-[11px] text-[#b8bdd4] hover:text-red-400 transition-colors flex-shrink-0"
        title="移除图片"
      >
        ✕
      </button>
    </div>
  );
}

// ─── Input Card ───────────────────────────────────────────────────────────────
function InputCard({
  icon,
  title,
  subtitle,
  value,
  onChange,
  placeholder,
  preview,
  onClearPreview,
  parsing,
  onUploadClick,
  fileInputRef,
  onFileChange,
}: {
  icon: string;
  title: string;
  subtitle: string;
  value: string;
  onChange: (v: string) => void;
  placeholder: string;
  preview?: string;
  onClearPreview: () => void;
  parsing: boolean;
  onUploadClick: () => void;
  fileInputRef: React.RefObject<HTMLInputElement | null>;
  onFileChange: (e: React.ChangeEvent<HTMLInputElement>) => void;
}) {
  return (
    <NeuCard className="flex-1 p-8">
      <div className="flex items-center gap-3 mb-5">
        <div
          className="w-10 h-10 rounded-xl flex items-center justify-center text-lg flex-shrink-0"
          style={{
            background: "#E8EBF0",
            boxShadow: "inset 3px 3px 7px #c5c9d1, inset -3px -3px 7px #ffffff",
          }}
        >
          {icon}
        </div>
        <div>
          <h2 className="text-sm font-semibold text-[#1a1c2e]">{title}</h2>
          <p className="text-xs text-[#9aa0bb] mt-0.5">{subtitle}</p>
        </div>
      </div>

      <textarea
        value={value}
        onChange={(e) => onChange(e.target.value)}
        placeholder={placeholder}
        className="w-full h-48 resize-none bg-transparent text-sm text-[#3d4166] placeholder-[#b8bdd4] outline-none leading-relaxed"
      />

      {preview && <ImagePreview src={preview} onClear={onClearPreview} />}

      <div className="mt-4 flex items-center gap-3">
        <input
          ref={fileInputRef}
          type="file"
          accept={ACCEPT}
          className="hidden"
          onChange={onFileChange}
          // allow re-selecting the same file
          onClick={(e) => ((e.target as HTMLInputElement).value = "")}
        />
        <UploadButton onClick={onUploadClick} parsing={parsing} />
        <span className="text-[10px] text-[#b8bdd4]">
          TXT · MD · PDF · JPG · PNG · WEBP · GIF
        </span>
        {value && !preview && (
          <span className="ml-auto text-[11px] text-[#9aa0bb]">{value.length} 字符</span>
        )}
      </div>
    </NeuCard>
  );
}

// ─── Main Page ────────────────────────────────────────────────────────────────
export default function Home() {
  const [resume, setResume] = useState("");
  const [jd, setJd] = useState("");
  const [resumePreview, setResumePreview] = useState<string | undefined>();
  const [jdPreview, setJdPreview] = useState<string | undefined>();
  const [resumeParseState, setResumeParseState] = useState<ParseState>("idle");
  const [jdParseState, setJdParseState] = useState<ParseState>("idle");

  const [result, setResult] = useState<AnalysisResult | null>(null);
  const [analyzing, setAnalyzing] = useState(false);
  const [analyzeError, setAnalyzeError] = useState<string | null>(null);
  const [activeQA, setActiveQA] = useState<number | null>(null);

  const resumeFileRef = useRef<HTMLInputElement>(null);
  const jdFileRef = useRef<HTMLInputElement>(null);
  const resultRef = useRef<HTMLDivElement>(null);

  const handleFileChange = useCallback(
    async (
      e: React.ChangeEvent<HTMLInputElement>,
      setText: (s: string) => void,
      setPreview: (s: string | undefined) => void,
      setParseState: (s: ParseState) => void
    ) => {
      const file = e.target.files?.[0];
      if (!file) return;
      setParseState("parsing");
      setPreview(undefined);
      try {
        const { text, preview } = await parseFile(file);
        setText(text);
        setPreview(preview);
        setParseState("done");
      } catch {
        setParseState("error");
        setText(`[文件解析失败：${file.name}，请改用文本粘贴]`);
      }
    },
    []
  );

  const onAnalyze = async () => {
    if (!resume.trim() || !jd.trim()) return;
    setAnalyzing(true);
    setResult(null);
    setAnalyzeError(null);
    setActiveQA(null);
    try {
      const data = await callAnalyzeAPI(
        resume,
        jd,
        resumePreview,  // base64 data URL if image was uploaded
        jdPreview
      );
      setResult(data);
      setTimeout(
        () => resultRef.current?.scrollIntoView({ behavior: "smooth" }),
        100
      );
    } catch (err) {
      setAnalyzeError(err instanceof Error ? err.message : "分析请求失败，请稍后重试");
    } finally {
      setAnalyzing(false);
    }
  };

  const canAnalyze = resume.trim().length > 0 && jd.trim().length > 0;
  const scoreColor = result ? getScoreColor(result.matchScore) : "#5b6af0";

  return (
    <div
      className="min-h-screen bg-[#E8EBF0]"
      style={{ fontFamily: "'Inter','PingFang SC','Microsoft YaHei',sans-serif" }}
    >
      {/* ── Header ── */}
      <header className="pt-16 pb-10 text-center select-none">
        <div className="inline-flex items-center gap-2 mb-4">
          <div
            className="w-9 h-9 rounded-xl flex items-center justify-center text-white font-bold text-base"
            style={{
              background: "linear-gradient(135deg, #5b6af0, #818cf8)",
              boxShadow: "3px 3px 10px #c5c9d1, -2px -2px 6px #ffffff",
            }}
          >
            H
          </div>
          <h1 className="text-4xl font-extrabold tracking-tight text-[#1a1c2e]">
            Hire<span style={{ color: "#5b6af0" }}>Solve</span>
          </h1>
        </div>
        <p className="text-xs text-[#9aa0bb] tracking-[0.2em] uppercase">
          AI · 求职竞争力分析平台
        </p>
      </header>

      <main className="max-w-5xl mx-auto px-6 pb-20">
        {/* ── Input Cards ── */}
        <div className="flex flex-col md:flex-row gap-6 mb-8">
          <InputCard
            icon="📄"
            title="个人简历"
            subtitle="粘贴文本或上传文件"
            value={resume}
            onChange={(v) => { setResume(v); setResumePreview(undefined); }}
            placeholder={"将简历内容粘贴于此…\n\n例：教育背景、工作经历、项目成果、技能栈…"}
            preview={resumePreview}
            onClearPreview={() => { setResume(""); setResumePreview(undefined); }}
            parsing={resumeParseState === "parsing"}
            onUploadClick={() => resumeFileRef.current?.click()}
            fileInputRef={resumeFileRef}
            onFileChange={(e) =>
              handleFileChange(e, setResume, setResumePreview, setResumeParseState)
            }
          />
          <InputCard
            icon="💼"
            title="岗位 JD"
            subtitle="粘贴职位描述或上传文件"
            value={jd}
            onChange={(v) => { setJd(v); setJdPreview(undefined); }}
            placeholder={"将岗位 JD 粘贴于此…\n\n例：岗位职责、任职要求、技术栈偏好…"}
            preview={jdPreview}
            onClearPreview={() => { setJd(""); setJdPreview(undefined); }}
            parsing={jdParseState === "parsing"}
            onUploadClick={() => jdFileRef.current?.click()}
            fileInputRef={jdFileRef}
            onFileChange={(e) =>
              handleFileChange(e, setJd, setJdPreview, setJdParseState)
            }
          />
        </div>

        {/* ── Analyze Button ── */}
        <div className="flex justify-center mb-14">
          <button
            onClick={onAnalyze}
            disabled={analyzing || !canAnalyze}
            className="px-14 py-4 rounded-2xl text-white font-semibold text-sm tracking-wide transition-all duration-200 disabled:opacity-40 disabled:cursor-not-allowed"
            style={{
              background: "linear-gradient(135deg, #5b6af0 0%, #818cf8 100%)",
              boxShadow: analyzing
                ? "inset 3px 3px 8px rgba(0,0,0,0.2)"
                : "6px 6px 16px #c5c9d1, -4px -4px 12px #ffffff, 0 4px 24px rgba(91,106,240,0.35)",
            }}
            onMouseEnter={(e) => {
              if (!analyzing && canAnalyze) {
                e.currentTarget.style.boxShadow =
                  "8px 8px 20px #c5c9d1, -4px -4px 12px #ffffff, 0 6px 32px rgba(91,106,240,0.5)";
                e.currentTarget.style.transform = "translateY(-2px)";
              }
            }}
            onMouseLeave={(e) => {
              e.currentTarget.style.boxShadow =
                "6px 6px 16px #c5c9d1, -4px -4px 12px #ffffff, 0 4px 24px rgba(91,106,240,0.35)";
              e.currentTarget.style.transform = "translateY(0)";
            }}
          >
            {analyzing ? (
              <span className="flex items-center gap-2">
                <svg className="animate-spin h-4 w-4" viewBox="0 0 24 24" fill="none">
                  <circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4" />
                  <path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4z" />
                </svg>
                AI 分析中…
              </span>
            ) : (
              "开始 AI 分析 →"
            )}
          </button>
        </div>

        {/* ── Error ── */}
        {analyzeError && (
          <div
            className="mb-8 mx-auto max-w-xl rounded-xl px-5 py-4 text-sm text-red-500 text-center"
            style={{
              background: "#fef2f2",
              boxShadow: "inset 2px 2px 5px #e5c0c0, inset -2px -2px 5px #ffffff",
            }}
          >
            ⚠️ {analyzeError}
          </div>
        )}

        {/* ── Results ── */}
        {result && (
          <div ref={resultRef} className="space-y-6 fade-in">
            {/* Match Score */}
            <NeuCard hover={false} className="p-8">
              <p className="text-[10px] uppercase tracking-[0.18em] text-[#9aa0bb] mb-6">
                匹配度评分
              </p>
              <div className="flex items-center gap-8">
                <div className="relative w-28 h-28 flex-shrink-0">
                  <svg viewBox="0 0 100 100" className="w-full h-full -rotate-90">
                    <circle cx="50" cy="50" r="40" fill="none" stroke="#d1d5e2" strokeWidth="9" />
                    <circle
                      cx="50" cy="50" r="40" fill="none"
                      stroke={scoreColor} strokeWidth="9"
                      strokeLinecap="round"
                      strokeDasharray={`${2 * Math.PI * 40}`}
                      strokeDashoffset={`${2 * Math.PI * 40 * (1 - result.matchScore / 100)}`}
                      style={{ transition: "stroke-dashoffset 1.2s cubic-bezier(.4,0,.2,1)" }}
                    />
                  </svg>
                  <div className="absolute inset-0 flex flex-col items-center justify-center">
                    <span className="text-2xl font-bold" style={{ color: scoreColor }}>
                      {result.matchScore}%
                    </span>
                    <span className="text-[10px] text-[#9aa0bb] mt-0.5">匹配</span>
                  </div>
                </div>
                <div className="flex-1">
                  <p className="text-sm text-[#3d4166] leading-relaxed mb-4">
                    {result.matchScore >= 80
                      ? "🎯 优秀！简历与目标岗位高度契合，建议重点打磨表达质量与数据密度。"
                      : result.matchScore >= 60
                      ? "📌 中等匹配，建议针对 JD 核心关键词补充相关项目经历与技能描述。"
                      : "⚠️ 匹配度偏低，建议大幅调整简历结构，优先对齐 JD 核心要求。"}
                  </p>
                  <div
                    className="w-full h-2 rounded-full overflow-hidden"
                    style={{ background: "#d1d5e2", boxShadow: "inset 1px 1px 3px #c5c9d1" }}
                  >
                    <div
                      className="h-full rounded-full"
                      style={{
                        width: `${result.matchScore}%`,
                        background: scoreColor,
                        transition: "width 1.2s cubic-bezier(.4,0,.2,1)",
                      }}
                    />
                  </div>
                </div>
              </div>
            </NeuCard>

            {/* Suggestions */}
            <NeuCard hover={false} className="p-8">
              <p className="text-[10px] uppercase tracking-[0.18em] text-[#9aa0bb] mb-6">
                简历改写建议 · STAR 法则
              </p>
              <div className="space-y-5">
                {result.suggestions.map((s, i) => (
                  <div
                    key={i}
                    className="rounded-xl p-5"
                    style={{
                      background: "#eaedf3",
                      boxShadow: "inset 2px 2px 5px #c5c9d1, inset -2px -2px 5px #ffffff",
                    }}
                  >
                    <div className="flex items-start gap-2.5 mb-3">
                      <span className="text-[10px] bg-red-100 text-red-400 px-2 py-0.5 rounded-full flex-shrink-0 mt-0.5 font-medium">
                        原文
                      </span>
                      <p className="text-sm text-[#9aa0bb] line-through leading-relaxed">{s.original}</p>
                    </div>
                    <div className="flex items-start gap-2.5 mb-3">
                      <span className="text-[10px] bg-emerald-100 text-emerald-600 px-2 py-0.5 rounded-full flex-shrink-0 mt-0.5 font-medium">
                        改写
                      </span>
                      <p className="text-sm text-[#1a1c2e] leading-relaxed">{s.improved}</p>
                    </div>
                    <div className="flex items-start gap-2.5">
                      <span className="text-[10px] bg-indigo-100 text-indigo-400 px-2 py-0.5 rounded-full flex-shrink-0 mt-0.5 font-medium">
                        技巧
                      </span>
                      <p className="text-xs text-[#5b6af0] leading-relaxed">{s.tip}</p>
                    </div>
                  </div>
                ))}
              </div>
            </NeuCard>

            {/* Interview Q&A */}
            <NeuCard hover={false} className="p-8">
              <p className="text-[10px] uppercase tracking-[0.18em] text-[#9aa0bb] mb-6">
                面试官 5 问 · 参考答案
              </p>
              <div className="space-y-3">
                {result.interviewQA.map((qa, i) => (
                  <div
                    key={i}
                    className="rounded-xl overflow-hidden"
                    style={{
                      background: "#eaedf3",
                      boxShadow: "inset 2px 2px 5px #c5c9d1, inset -2px -2px 5px #ffffff",
                    }}
                  >
                    <button
                      className="w-full text-left px-5 py-4 flex items-center justify-between gap-4"
                      onClick={() => setActiveQA(activeQA === i ? null : i)}
                    >
                      <div className="flex items-center gap-3">
                        <span
                          className="w-6 h-6 rounded-full text-white text-xs font-bold flex items-center justify-center flex-shrink-0"
                          style={{ background: "linear-gradient(135deg, #5b6af0, #818cf8)" }}
                        >
                          {i + 1}
                        </span>
                        <span className="text-sm font-medium text-[#1a1c2e]">{qa.question}</span>
                      </div>
                      <span
                        className="text-[#9aa0bb] text-xs transition-transform duration-200 flex-shrink-0"
                        style={{ transform: activeQA === i ? "rotate(180deg)" : "rotate(0deg)" }}
                      >
                        ▾
                      </span>
                    </button>
                    {activeQA === i && (
                      <div className="px-5 pb-5">
                        <div className="pl-4 border-l-2 pt-1" style={{ borderColor: "#5b6af0" }}>
                          <p className="text-sm text-[#3d4166] leading-relaxed">{qa.answer}</p>
                        </div>
                      </div>
                    )}
                  </div>
                ))}
              </div>
            </NeuCard>

            <p className="text-center text-[11px] text-[#b8bdd4] pb-4">
              以上内容由模拟 AI 生成，仅供参考。接入真实 LLM API 后将提供个性化分析。
            </p>
          </div>
        )}
      </main>
    </div>
  );
}
