/**
 * The CMO group (B4): the CMO chat's 20 tools for the founder's own Claude, run under the
 * founder's RLS session exactly as the in-app CMO chat runs them (`runCmoTool`,
 * `runResearchTool`). Nothing here posts: tasks become runs or calendar items, drafts become
 * approval cards. Over MCP a task thinks with the caller (`brain: "claude"`): it lands in the
 * inbox and holds no credits.
 *
 * Reads that cost OpenCMO money or load someone else's site are capped per founder per hour
 * (`cmo_read_hit`), since no agent credits stand behind them here.
 */

import { z } from "zod";

import { RESEARCH_TOOLS, runResearchTool } from "@/lib/agent/cmo-research";
import { CMO_TOOL_SPECS, isCmoWrite, runCmoTool } from "@/lib/agent/cmo-tools";
import type { ToolOutcome, ToolSpec } from "@/lib/agent/tools";
import { ScBudget } from "@/lib/cmo/social/scrapecreators";

import { fail, ok, type CmoMcpTool, type CmoToolContext, type McpAnnotations, type McpResult } from "./contract";

/**
 * Session A's editor group has its own `read_skill` (the founder's editing recipes) and
 * `get_transcript` (the clip's words); the CMO's versions take other names over MCP.
 */
const MCP_NAME: Record<string, string> = { read_skill: "read_cmo_playbook", get_transcript: "get_video_transcript" };

/** Lookups one MCP call may spend (`find_outliers` takes two). */
const LOOKUPS_PER_CALL = 3;

const TITLES: Record<string, string> = {
  read_doc: "Read a marketing document",
  list_calendar: "List the content calendar",
  list_approvals: "List Approvals",
  create_task: "Hand a task to an agent",
  remember: "Remember a note",
  read_skill: "Read a CMO playbook",
  read_site: "Read a website",
  get_run_result: "Get a task's result",
  set_week_goal: "Propose a weekly goal",
  update_document: "Update a marketing document",
  search_reddit: "Search Reddit",
  search_hackernews: "Search Hacker News",
  subreddit_posts: "Read a subreddit",
  reddit_thread: "Read a Reddit thread",
  x_profile: "Read an X profile",
  find_outliers: "Find standout posts",
  search_videos: "Search TikTok or YouTube",
  search_threads: "Search Threads",
  get_transcript: "Get a social video's transcript",
  research_credits: "Research lookups left",
};

/** Over MCP the caller is the brain: tell it where the task's work comes back. */
const MCP_NOTES: Record<string, string> = {
  create_task:
    "Over this connection a \"now\" task thinks with you: OpenCMO reads what it needs, then the task waits in your inbox (list_inbox, usually within a minute) for you to do the writing. No credits are held for it.",
  read_site: "Capped at 20 reads an hour.",
};

/** Which bucket of `cmo_read_hit` a read counts against, if any. */
const capOf = (name: string): "mcp_social" | "mcp_site" | null =>
  name === "read_site" ? "mcp_site" : RESEARCH_TOOLS.has(name) && name !== "research_credits" ? "mcp_social" : null;

function annotations(name: string): McpAnnotations {
  const outside = RESEARCH_TOOLS.has(name) || name === "read_site";
  if (!isCmoWrite(name)) return { readOnlyHint: true, openWorldHint: outside };
  // Writes are versioned or queued for approval: none destroys or publishes anything.
  return { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: false };
}

/** The tool's own content, which already wraps outside text in `untrusted_data`. */
const fromOutcome = (outcome: ToolOutcome): McpResult => (outcome.ok ? ok(outcome.content) : { ...fail(outcome.content) });

/** The chat's credit prices hold in the app only: over MCP these tasks think with the caller, for free. */
const withoutPrices = (text: string): string => text.replace(/\((\d+) credits?; /g, "(").replace(/ \((\d+) credits?\)/g, "").replace(/; (\d+) credits?\)/g, ")");

function toMcp(spec: ToolSpec): CmoMcpTool {
  const note = MCP_NOTES[spec.name];
  const description = spec.name === "create_task" ? withoutPrices(spec.description) : spec.description;
  return {
    name: MCP_NAME[spec.name] ?? spec.name,
    title: TITLES[spec.name] ?? spec.name,
    description: note ? `${description} ${note}` : description,
    // The chat's JSON Schema is the contract; the tool parses its input again with its own zod.
    inputSchema: z.fromJSONSchema(spec.schema as Parameters<typeof z.fromJSONSchema>[0]),
    annotations: annotations(spec.name),
    async run(input: unknown, { supabase }: CmoToolContext) {
      const cap = capOf(spec.name);
      if (cap) {
        const { data: allowed, error } = await supabase.rpc("cmo_read_hit", { p_bucket: cap });
        if (error) return fail("Could not check the hourly limit. Try again in a minute.");
        if (!allowed) return fail(`The hourly limit for ${cap === "mcp_site" ? "website reads" : "social research"} is reached. Work with what you have, or try again next hour.`);
      }
      const outcome = RESEARCH_TOOLS.has(spec.name)
        ? await runResearchTool(spec.name, input, new ScBudget(LOOKUPS_PER_CALL))
        : await runCmoTool(supabase, spec.name, input, { siteReads: 0, brain: "claude" });
      return fromOutcome(outcome);
    },
  };
}

// CMO_TOOL_SPECS already ends with the research tools.
export const CMO_TOOLS: CmoMcpTool[] = CMO_TOOL_SPECS.map(toMcp);
