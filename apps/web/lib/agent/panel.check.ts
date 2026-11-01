/**
 * The CMO chat opens screens in column 3 (`view.open`) and tells the model which screen is open.
 *
 *     NODE_OPTIONS=--conditions=react-server tsx lib/agent/panel.check.ts
 */
import assert from "node:assert/strict";

import type { SupabaseClient } from "@/lib/api/handler";

import { CMO_TOOL_SPECS, runCmoTool } from "./cmo-tools";
import { panelHref, PANEL_SCREENS, screenContextText, screenOfPath } from "./panel";

const RUN = "7f1e2d3c-4b5a-4968-8776-655443322110";

async function main() {
  // Every rail screen can be opened, and opens the rail's own path.
  assert.deepEqual([...PANEL_SCREENS].sort(), ["analytics", "brain", "dashboard", "library", "research", "sales", "schedule", "settings", "studio", "writer"]);
  assert.equal(panelHref({ screen: "sales" }), "/app/sales");
  assert.equal(panelHref({ screen: "dashboard", ids: [RUN] }), "/app");
  // The tab goes in the key the screen reads; a screen without tabs ignores it.
  assert.equal(panelHref({ screen: "schedule", tab: "month" }), "/app/schedule?view=month");
  assert.equal(panelHref({ screen: "writer", tab: "thread" }), "/app/writer?kind=thread");
  assert.equal(panelHref({ screen: "sales", tab: "leads" }), "/app/sales");

  // Anything that does not validate never moves the panel: unknown screens, paths, odd tabs, non-uuid ids.
  for (const bad of [undefined, null, "sales", { screen: "editor" }, { screen: "/admin" }, { screen: "sales", tab: "a&b=c" }, { screen: "sales", ids: ["x"] }, { screen: "sales", ids: Array(21).fill(RUN) }]) {
    assert.equal(panelHref(bad), null, JSON.stringify(bad));
  }

  // Paths back to screens, by the rail's segments.
  assert.equal(screenOfPath("/app"), "dashboard");
  assert.equal(screenOfPath("/app/inbox/abc"), "dashboard");
  assert.equal(screenOfPath("/app/sales"), "sales");
  assert.equal(screenOfPath("/app/billing"), "settings");
  assert.equal(screenOfPath("/app/projects/1/clips/2"), "studio");
  assert.equal(screenOfPath("/app/editor/123"), null, "the editor has its own Assistant");
  assert.equal(screenOfPath("/app/setup"), null);
  assert.equal(screenOfPath("/login"), null);

  // The context line holds only the screen name and ids.
  assert.equal(screenContextText(undefined), "");
  const line = screenContextText({ name: "sales", ids: [RUN] });
  assert.ok(line.startsWith("<on_screen>") && line.includes("sales screen") && line.includes(RUN), line);

  // open_screen: a tool the model calls; it reads nothing, writes nothing, and its result carries `view.open`.
  assert.ok(CMO_TOOL_SPECS.some((spec) => spec.name === "open_screen"));
  assert.equal(CMO_TOOL_SPECS.at(-1)?.name, "open_screen", "added last: the tool list is the head of the prompt cache");
  const noDb = null as unknown as SupabaseClient;
  const opened = await runCmoTool(noDb, "open_screen", { screen: "sales", ids: [RUN] });
  assert.ok(opened.ok);
  assert.deepEqual(opened.view, { open: { screen: "sales", ids: [RUN] } });
  assert.equal(panelHref(opened.view?.open), "/app/sales");
  const wrong = await runCmoTool(noDb, "open_screen", { screen: "editor" });
  assert.ok(!wrong.ok && wrong.content.includes("INVALID_INPUT"));
  assert.equal(wrong.view, undefined);

  console.log("panel.check ok");
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
