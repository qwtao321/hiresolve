import { NextRequest, NextResponse } from "next/server";

const GLM_API = "https://open.bigmodel.cn/api/paas/v4/chat/completions";

const MODEL_TEXT = "glm-4-flash";
const MODEL_VISION = "glm-4v";

const SYSTEM_INSTRUCTION = `你是一位以严苛著称的硅谷资深技术 HR，兼任 Staff Engineer 级别的代码审查官。你的任务是对以下简历与 JD 做"工程级"深度评审，杜绝一切"逻辑通顺但无实际价值"的废话。

【防幻觉铁律 — 最高优先级，违反即重新生成】
- suggestions 的 original 字段：必须是简历原文的逐字复制，一个字都不能改，不得补充、推断或虚构。
- 简历中找不到足够可优化语句时，suggestions 数量可少于 3 条，绝对禁止捏造原文。
- interviewQA 的问题：必须基于简历中真实存在的项目名称或技术名称，禁止引用简历中未提及的内容。
- 简历内容极少或为空：matchScore 给 0，suggestions 给空数组，gaps 中说明"简历内容不足以评估"。

【评审准则】

① 拒绝虚假匹配
- 不能只看关键词相似度。若 JD 要求"高并发分布式架构"而简历只有"简单 CRUD"，必须在 gaps 字段犀利指出，严禁模糊处理。
- matchScore 必须真实反映差距，不得因"措辞积极"而虚高。

② STAR 法则强制工程化
- Situation：必须包含业务规模（如 DAU 100万+、QPS 5000+、团队规模）
- Action：必须是具象技术动作（"通过引入 Redis 多级缓存" 而非 "负责优化缓存"）
- Result：必须量化（响应延迟降低 45%、成本节省 20%、故障率从 0.5% 降至 0.02%）

③ 面试追问必须基于简历漏洞
- 严禁"请做自我介绍""你的优缺点是什么"等通用题
- 每个问题必须锁定简历中某个具体项目或技术，追问其边界场景、异常处理或规模挑战

【输出格式与数量铁律】
- 只输出一个合法 JSON 对象，禁止包含任何 markdown、注释、解释性文字，从第一个 { 开始到最后一个 } 结束
- interviewQA 数组：必须恰好包含 5 条，不能多也不能少
- suggestions 数组：包含 1-3 条（简历内容不足时可为 0 条）
- gaps 数组：包含 2-5 条关键差距

{"matchScore":整数,"gaps":["差距1","差距2","差距3"],"suggestions":[{"original":"简历原文逐字复制","improved":"STAR改写版","tip":"一句话缺陷"},{"original":"原文2","improved":"改写2","tip":"技巧2"}],"interviewQA":[{"question":"追问1","answer":"STAR回答1"},{"question":"追问2","answer":"STAR回答2"},{"question":"追问3","answer":"STAR回答3"},{"question":"追问4","answer":"STAR回答4"},{"question":"追问5","answer":"STAR回答5"}]}`;

/** Build plain-text messages when no images are involved */
function buildTextMessages(resume: string, jd: string) {
  const content = `${SYSTEM_INSTRUCTION}\n\n---简历：\n${resume}\n\n---岗位 JD：\n${jd}`;
  return [{ role: "user", content }];
}

type VisionPart =
  | { type: "text"; text: string }
  | { type: "image_url"; image_url: { url: string } };

/** Build vision messages when one or both inputs are images.
 *  GLM-4V requires: all image_url parts first, then a single text part. */
function buildVisionMessages(
  resume: string,
  jd: string,
  resumeImage?: string,
  jdImage?: string
) {
  const parts: VisionPart[] = [];

  // Images must come before text for GLM-4V
  if (resumeImage) {
    parts.push({ type: "image_url", image_url: { url: resumeImage } });
  }
  if (jdImage) {
    parts.push({ type: "image_url", image_url: { url: jdImage } });
  }

  // Single combined text block after images
  let context = "";
  if (resumeImage && jdImage) {
    context = "第一张图片是求职者简历，第二张图片是岗位 JD。";
  } else if (resumeImage) {
    context = `上面图片是求职者的简历。\n\n---岗位 JD：\n${jd}`;
  } else {
    context = `---简历：\n${resume}\n\n上面图片是岗位 JD。`;
  }

  parts.push({ type: "text", text: `${SYSTEM_INSTRUCTION}\n\n${context}` });

  return [{ role: "user", content: parts }];
}

/** Robustly extract JSON from model output that may contain prose, fences, or comments */
function extractJSON(raw: string): string {
  // 1. Strip markdown code fences
  let s = raw
    .replace(/^```(?:json)?\s*/im, "")
    .replace(/```\s*$/im, "")
    .trim();

  // 2. Find outermost { ... } to tolerate leading/trailing prose
  const start = s.indexOf("{");
  const end = s.lastIndexOf("}");
  if (start !== -1 && end !== -1 && end > start) {
    s = s.slice(start, end + 1);
  }

  // 3. Remove JS-style single-line comments (// ...) which are invalid JSON
  s = s.replace(/\/\/[^\n]*/g, "");

  // 4. Remove trailing commas before } or ] (common model mistake)
  s = s.replace(/,\s*([}\]])/g, "$1");

  return s.trim();
}

export async function POST(req: NextRequest) {
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

  const hasResumeContent = resume?.trim() || resumeImage;
  const hasJdContent = jd?.trim() || jdImage;
  if (!hasResumeContent || !hasJdContent) {
    return NextResponse.json({ error: "resume and jd are required" }, { status: 400 });
  }

  const useVision = !!(resumeImage || jdImage);
  const messages = useVision
    ? buildVisionMessages(resume ?? "", jd ?? "", resumeImage, jdImage)
    : buildTextMessages(resume, jd);
  const model = useVision ? MODEL_VISION : MODEL_TEXT;

  let glmRes: Response;
  try {
    glmRes = await fetch(GLM_API, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${apiKey}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ model, messages, temperature: 0.5, max_tokens: 4096 }),
    });
  } catch (err) {
    console.error("GLM network error:", err);
    return NextResponse.json({ error: "无法连接智谱 AI，请检查网络" }, { status: 502 });
  }

  if (!glmRes.ok) {
    const errBody = await glmRes.text();
    console.error(`GLM ${glmRes.status}:`, errBody);
    let detail = `GLM API returned ${glmRes.status}`;
    try {
      const parsed = JSON.parse(errBody);
      if (parsed?.error?.message) detail = parsed.error.message;
    } catch { /* not JSON */ }
    return NextResponse.json({ error: detail }, { status: 502 });
  }

  const glmData = await glmRes.json();
  const rawContent: string = glmData.choices?.[0]?.message?.content ?? "";

  const cleaned = extractJSON(rawContent);

  try {
    const parsed = JSON.parse(cleaned);
    return NextResponse.json(parsed);
  } catch {
    console.error("Non-JSON from GLM after extraction:", cleaned);
    return NextResponse.json(
      { error: "模型返回格式异常，请重试", raw: cleaned },
      { status: 500 }
    );
  }
}
