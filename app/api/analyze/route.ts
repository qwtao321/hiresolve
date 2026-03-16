import { NextRequest, NextResponse } from "next/server";

const GLM_API = "https://open.bigmodel.cn/api/paas/v4/chat/completions";

// glm-4v-flash only accepts public URLs (not base64); use glm-4-flash for all text analysis
const MODEL = "glm-4-flash";

function buildPrompt(resume: string, jd: string): string {
  return `你是一位以严苛著称的硅谷资深技术 HR，兼任 Staff Engineer 级别的代码审查官。你的任务是对以下简历与 JD 做"工程级"深度评审，杜绝一切"逻辑通顺但无实际价值"的废话。

【评审准则 — 必须严格遵守】

① 拒绝虚假匹配
- 不能只看关键词相似度。若 JD 要求"高并发分布式架构"而简历只有"简单 CRUD"，必须在 gaps 字段犀利指出，严禁模糊处理。
- matchScore 必须真实反映差距，不得因"措辞积极"而虚高。

② STAR 法则强制工程化
- [S] Situation：必须包含业务规模（如 DAU 100万+、QPS 5000+、团队规模）
- [A] Action：必须是具象技术动作（"通过引入 Redis 多级缓存" 而非 "负责优化缓存"）
- [R] Result：必须量化（响应延迟降低 45%、成本节省 20%、故障率从 0.5% 降至 0.02%）
- 缺少以上任一要素的改写视为不合格，重新生成

③ 面试追问必须基于简历漏洞
- 严禁"请做自我介绍""你的优缺点是什么"等通用题
- 每个问题必须锁定简历中某个具体项目或技术，并追问其边界场景、异常处理或规模挑战
- 示例格式："你在 [项目X] 中使用了 [技术Y]，当遇到 [场景Z] 时，你如何保证数据一致性？"

【防幻觉铁律 — 最高优先级】
- suggestions 的 original 字段：必须是简历原文的逐字复制，不得修改任何一个字，不得补充、推断或虚构。
- 如果简历中找不到足够的可优化语句，suggestions 数量可以少于 3 条，绝对禁止捏造原文。
- interviewQA 的问题：必须基于简历中真实存在的项目名称、技术名称或经历，禁止引用简历中未提及的内容。
- 如果简历内容极少或为空，matchScore 给 0，suggestions 给空数组 []，并在 gaps 中说明"简历内容不足以评估"。

【输出格式 — 只输出合法 JSON，禁止 markdown 代码块和多余文字】

{
  "matchScore": <0-100 整数，严格评分>,
  "gaps": [<关键差距1>, <关键差距2>],
  "suggestions": [
    {
      "original": "<简历原文逐字复制，禁止任何改动或虚构>",
      "improved": "<工程化改写，严格包含 S/A/R 三要素且均量化>",
      "tip": "<一句话指出原文最致命的缺陷>"
    }
  ],
  "interviewQA": [
    {
      "question": "<必须引用简历中真实存在的项目或技术，禁止通用题>",
      "answer": "<STAR结构回答，S含规模，A含具体技术手段，R含量化结果>"
    }
  ]
}

---简历：
${resume}

---岗位 JD：
${jd}`;
}

// glm-4v-flash only supports public URLs, not base64.
// We always use glm-4-flash (text) — images are shown as previews client-side only.
function buildMessages(resume: string, jd: string) {
  return [{ role: "user", content: buildPrompt(resume, jd) }];
}

export async function POST(req: NextRequest) {
  // .trim() removes any accidental newlines from env var injection
  const apiKey = process.env.GLM_API_KEY?.trim();
  if (!apiKey) {
    return NextResponse.json({ error: "GLM_API_KEY not configured" }, { status: 500 });
  }

  let body: { resume: string; jd: string };
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: "Invalid request body" }, { status: 400 });
  }

  const { resume, jd } = body;
  if (!resume?.trim() || !jd?.trim()) {
    return NextResponse.json({ error: "resume and jd are required" }, { status: 400 });
  }

  const messages = buildMessages(resume, jd);

  let glmRes: Response;
  try {
    glmRes = await fetch(GLM_API, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${apiKey}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ model: MODEL, messages, temperature: 0.7, max_tokens: 2048 }),
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
