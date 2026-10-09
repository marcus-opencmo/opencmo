import "server-only";

/**
 * Sổ agent của CMO (H1, Marcus 04/10): MỖI việc là một agent có provider/model/khoá riêng, để
 * thay agent hợp từng nhiệm vụ mà không sửa code. Chỗ đổi là env trên Vercel (Marcus chốt: không
 * UI, khoá không nằm trong DB):
 *
 *   CMO_AGENT_<ID>_PROVIDER = gemini | anthropic
 *   CMO_AGENT_<ID>_MODEL    = id model của provider đó
 *   CMO_AGENT_<ID>_API_KEY  = khoá riêng của agent; vắng thì khoá chung của provider
 *                             (GEMINI_API_KEY / ANTHROPIC_API_KEY)
 *
 * `<ID>` viết hoa: CMO, ONBOARDING, PLANNER, X_WRITER, SALES, RESEARCH, VIDEO, CHECKER, CAPTIONS.
 * Mặc định mọi agent chạy Gemini (Marcus: "giờ cứ dùng gemini"). Hai tầng như cũ: agent soạn
 * dùng bản Pro, agent chấm/kiểm dùng bản Flash — kiểm bài không cần nghĩ sâu, và context riêng
 * thì model kiểm không bị chính bản nháp thuyết phục.
 */

export type AgentId = "cmo" | "onboarding" | "planner" | "x_writer" | "sales" | "research" | "video" | "checker" | "captions";
export type ProviderKind = "gemini" | "anthropic";

export type AgentSpec = {
  id: AgentId;
  /** Tên hiện trong log/Activity (tiếng Anh: có thể lên UI). */
  label: string;
  /** Việc của agent — dùng trong prompt CMO khi giao việc. */
  role: string;
  tier: "draft" | "check";
};

export const AGENT_SPECS: Record<AgentId, AgentSpec> = {
  cmo: { id: "cmo", label: "CMO", role: "Talks with the founder, researches with social tools, and hands tasks to the other agents.", tier: "draft" },
  onboarding: { id: "onboarding", label: "Onboarding", role: "Reads the website and drafts the four marketing documents.", tier: "draft" },
  planner: { id: "planner", label: "Planner", role: "Plans the week of posts, Reddit replies and short videos.", tier: "draft" },
  x_writer: { id: "x_writer", label: "X writer", role: "Drafts X posts for the founder to approve and post.", tier: "draft" },
  sales: { id: "sales", label: "Sales", role: "Finds Reddit threads where people need the product and drafts helpful replies.", tier: "draft" },
  research: { id: "research", label: "Research", role: "Finds competitor and niche posts that outperform, and why they worked.", tier: "draft" },
  video: { id: "video", label: "Video", role: "Writes captions for clips cut from the founder's own videos.", tier: "draft" },
  checker: { id: "checker", label: "Checker", role: "Reviews drafts and scores threads in a separate context.", tier: "check" },
  captions: { id: "captions", label: "Captions", role: "Translates captions in the editor.", tier: "check" },
};

export const AGENT_IDS = Object.keys(AGENT_SPECS) as AgentId[];

/** Model mặc định theo tầng. Giữ tương thích env cũ (`AGENT_GEMINI_MODEL`, `CMO_GEMINI_CHECK_MODEL`). */
function defaultModel(provider: ProviderKind, tier: AgentSpec["tier"], env: NodeJS.ProcessEnv): string {
  if (provider === "anthropic") return tier === "check" ? "claude-haiku-4-5" : "claude-opus-5-5";
  return tier === "check" ? env.CMO_GEMINI_CHECK_MODEL || "gemini-flash-latest" : env.AGENT_GEMINI_MODEL || "gemini-pro-latest";
}

const sharedKey = (provider: ProviderKind, env: NodeJS.ProcessEnv): string =>
  provider === "anthropic" ? env.ANTHROPIC_API_KEY || env.ANTHROPIC_AUTH_TOKEN || "" : env.GEMINI_API_KEY || env.GOOGLE_API_KEY || "";

export type ResolvedAgent = AgentSpec & { provider: ProviderKind; model: string; apiKey: string; source: "env" | "default" };

/**
 * Provider/model/khoá thật của một agent. `apiKey` rỗng = agent chưa cấu hình được (thiếu khoá) —
 * nơi gọi báo lỗi tiếng Anh. Khoá không bao giờ rời server.
 */
export function resolveAgent(id: AgentId, env: NodeJS.ProcessEnv = process.env): ResolvedAgent {
  const spec = AGENT_SPECS[id];
  const prefix = `CMO_AGENT_${id.toUpperCase()}_`;
  const wanted = env[`${prefix}PROVIDER`]?.trim().toLowerCase();
  if (wanted && wanted !== "gemini" && wanted !== "anthropic") {
    console.error(`[cmo] ${prefix}PROVIDER="${wanted}" không hợp lệ — dùng gemini`);
  }
  const provider: ProviderKind = wanted === "anthropic" ? "anthropic" : "gemini";
  const model = env[`${prefix}MODEL`]?.trim() || defaultModel(provider, spec.tier, env);
  const apiKey = env[`${prefix}API_KEY`]?.trim() || sharedKey(provider, env);
  const source = wanted || env[`${prefix}MODEL`] || env[`${prefix}API_KEY`] ? "env" : "default";
  return { ...spec, provider, model, apiKey, source };
}

/** Bảng cấu hình hiện tại, không có khoá — cho log khởi động và trang chẩn đoán nội bộ. */
export function agentTable(env: NodeJS.ProcessEnv = process.env): { id: AgentId; provider: ProviderKind; model: string; ready: boolean; source: string }[] {
  return AGENT_IDS.map((id) => {
    const agent = resolveAgent(id, env);
    return { id, provider: agent.provider, model: agent.model, ready: Boolean(agent.apiKey), source: agent.source };
  });
}
