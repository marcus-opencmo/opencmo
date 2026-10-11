import "server-only";

/**
 * The CMO agent registry (H1): EVERY job is an agent with its own model and key, so an agent can
 * be swapped per task without code changes. Configured with env on Vercel (no UI, keys stay out of
 * the database). Every agent runs on Claude:
 *
 *   CMO_AGENT_<ID>_MODEL    = Claude model id
 *   CMO_AGENT_<ID>_API_KEY  = the agent's own key; defaults to ANTHROPIC_API_KEY
 *
 * `<ID>` in capitals: CMO, ONBOARDING, PLANNER, X_WRITER, SALES, RESEARCH, VIDEO, CHECKER, CAPTIONS.
 * Two tiers: drafting agents use Opus, checking agents use Haiku — a check does not need deep
 * reasoning, and a separate context keeps the checker from being persuaded by the draft.
 */

export type AgentId = "cmo" | "onboarding" | "planner" | "x_writer" | "sales" | "research" | "video" | "checker" | "captions";
export type ProviderKind = "anthropic";

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

const defaultModel = (tier: AgentSpec["tier"]): string => (tier === "check" ? "claude-haiku-4-5" : "claude-opus-5-5");

const sharedKey = (env: NodeJS.ProcessEnv): string => env.ANTHROPIC_API_KEY || env.ANTHROPIC_AUTH_TOKEN || "";

export type ResolvedAgent = AgentSpec & { provider: ProviderKind; model: string; apiKey: string; source: "env" | "default" };

/**
 * An agent's real model and key. An empty `apiKey` means the agent is not set up (no key); the
 * caller reports that in English. Keys never leave the server.
 */
export function resolveAgent(id: AgentId, env: NodeJS.ProcessEnv = process.env): ResolvedAgent {
  const spec = AGENT_SPECS[id];
  const prefix = `CMO_AGENT_${id.toUpperCase()}_`;
  const model = env[`${prefix}MODEL`]?.trim() || defaultModel(spec.tier);
  const apiKey = env[`${prefix}API_KEY`]?.trim() || sharedKey(env);
  const source = env[`${prefix}MODEL`] || env[`${prefix}API_KEY`] ? "env" : "default";
  return { ...spec, provider: "anthropic", model, apiKey, source };
}

/** Current configuration without keys — for the startup log and the internal diagnostics page. */
export function agentTable(env: NodeJS.ProcessEnv = process.env): { id: AgentId; provider: ProviderKind; model: string; ready: boolean; source: string }[] {
  return AGENT_IDS.map((id) => {
    const agent = resolveAgent(id, env);
    return { id, provider: agent.provider, model: agent.model, ready: Boolean(agent.apiKey), source: agent.source };
  });
}
