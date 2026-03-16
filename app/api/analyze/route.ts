import { NextRequest, NextResponse } from "next/server";

const GLM_API = "https://open.bigmodel.cn/api/paas/v4/chat/completions";

// Use glm-4v-flash for vision (images), glm-4-flash for text-only (faster/cheaper)
const MODEL_VISION = "glm-4v-flash";
const MODEL_TEXT = "glm-4-flash";

function buildPrompt(resume: string, jd: string): string {
  return `你是一位资深 HR 顾问和求职教练。请严格分析以下简历与岗位 JD，输出 JSON 格式结果。

要求：
1. matchScore：0-100 整数，综合评估关键词、技能、经验的匹配程度
2. suggestions：针对简历实际内容给出 3 条具体改写建议，每条包含：
   - original：从简历中摘取的原始表述（若为图片则给出通用示例）
   - improved：改写版（严格遵循 STAR 法则：情境 S、任务 T、行动 A、结果 R，结果必须含量化数据）
   - tip：一句话优化要点
3. interviewQA：结合简历与 JD，预测面试官最可能提出的 5 个问题及参考回答（STAR 结构，第一人称）

只输出合法 JSON，不要 markdown 代码块，不要任何多余文字。

---简历：
${resume}

---岗位 JD：
${jd}`;
}

type VisionContent = Array<
  | { type: "text"; text: string }
  | { type: "image_url"; image_url: { url: string } }
>;

function buildMessages(
  resume: string,
  jd: string,
  resumeImage?: string,
  jdImage?: string
): { model: string; messages: { role: string; content: string | VisionContent }[] } {
  const hasImages = !!(resumeImage || jdImage);

  if (!hasImages) {
    return {
      model: MODEL_TEXT,
      messages: [{ role: "user", content: buildPrompt(resume, jd) }],
    };
  }

  // Multi-modal: images first, then text prompt
  const content: VisionContent = [];
  if (resumeImage) content.push({ type: "image_url", image_url: { url: resumeImage } });
  if (jdImage) content.push({ type: "image_url", image_url: { url: jdImage } });
  content.push({ type: "text", text: buildPrompt(resume, jd) });

  return {
    model: MODEL_VISION,
    messages: [{ role: "user", content }],
  };
}

export async function POST(req: NextRequest) {
  // .trim() removes any accidental newlines from env var injection
  const apiKey = process.env.GLM_API_KEY?.trim();
  if (!apiKey) {
    return NextResponse.json({ error: "GLM_API_KEY not configured" }, { status: 500 });
  }

  let body: { resume: string; jd: string; resumeImage?: string; jdImage?: string };
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: "Invalid request body" }, { status: 400 });
  }

  const { resume, jd, resumeImage, jdImage } = body;
  if (!resume?.trim() || !jd?.trim()) {
    return NextResponse.json({ error: "resume and jd are required" }, { status: 400 });
  }

  const { model, messages } = buildMessages(resume, jd, resumeImage, jdImage);

  let glmRes: Response;
  try {
    glmRes = await fetch(GLM_API, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${apiKey}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ model, messages, temperature: 0.7, max_tokens: 2048 }),
    });
  } catch (err) {
    console.error("GLM network error:", err);
    return NextResponse.json({ error: "无法连接智谱 AI，请检查网络" }, { status: 502 });
  }

  if (!glmRes.ok) {
    const errBody = await glmRes.text();
    console.error(`GLM ${glmRes.status}:`, errBody);
    // Surface GLM's actual error message to help debugging
    let detail = `GLM API returned ${glmRes.status}`;
    try {
      const parsed = JSON.parse(errBody);
      if (parsed?.error?.message) detail = parsed.error.message;
    } catch { /* not JSON */ }
    return NextResponse.json({ error: detail }, { status: 502 });
  }

  const glmData = await glmRes.json();
  const rawContent: string = glmData.choices?.[0]?.message?.content ?? "";

  // Strip markdown code fences if model wraps output
  const cleaned = rawContent
    .replace(/^```(?:json)?\s*/i, "")
    .replace(/\s*```$/i, "")
    .trim();

  try {
    const parsed = JSON.parse(cleaned);
    return NextResponse.json(parsed);
  } catch {
    console.error("Non-JSON from GLM:", cleaned);
    return NextResponse.json(
      { error: "模型返回格式异常，请重试", raw: cleaned },
      { status: 500 }
    );
  }
}
