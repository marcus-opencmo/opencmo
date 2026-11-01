/**
 * Runs for real (an in-memory Supabase):
 *
 *     cd apps/web && NODE_OPTIONS=--conditions=react-server npx tsx lib/mcp/versions.check.ts
 *
 * list_versions / restore_version over MCP (editor-MCP plan, item 1): a restore saves the old document
 * behind the optimistic lock, after a checkpoint of the current one.
 */
import assert from "node:assert/strict";

import { listVersions, restoreVersion } from "./versions";

const CLIP = "11111111-1111-4111-8111-111111111111";
const doc = (name: string) => ({
  version: 1,
  stage: { children: [{ kind: "scene", name, width: 1080, height: 1920, fill: "#000000", active: true, workarea: [0, 10], children: [] }] },
});

type Revision = { id: string; clip_id: string; number: number; kind: string; label: string | null; created_at: string; document: unknown };

function fakeSupabase(start: { document: unknown; generated: unknown }) {
  const state = {
    project: { clip_id: CLIP, version: 3, document: start.document, generated_document: start.generated },
    revisions: [] as Revision[],
    calls: [] as string[],
  };
  const query = (table: string) => {
    const filters: Record<string, unknown> = {};
    const builder = {
      select: () => builder,
      eq: (column: string, value: unknown) => ((filters[column] = value), builder),
      order: () => builder,
      limit: () => builder,
      maybeSingle: async () => {
        if (table === "editor_projects") return { data: filters.clip_id === CLIP ? state.project : null, error: null };
        return { data: state.revisions.find((row) => row.clip_id === filters.clip_id && row.id === filters.id) ?? null, error: null };
      },
      then: (resolve: (value: unknown) => void) =>
        resolve({ data: [...state.revisions].filter((row) => row.clip_id === filters.clip_id).sort((a, b) => b.number - a.number), error: null }),
    };
    return builder;
  };
  const rpc = async (name: string, args: Record<string, unknown>) => {
    state.calls.push(name);
    if (name === "checkpoint_editor_project") {
      if (args.p_expected_version != null && args.p_expected_version !== state.project.version) {
        return { data: null, error: { code: "P0409", message: "This clip was changed in another tab." } };
      }
      const row = { id: `00000000-0000-4000-8000-00000000000${state.revisions.length + 1}`, clip_id: CLIP, number: state.revisions.length + 1, kind: String(args.p_kind), label: String(args.p_label), created_at: "2026-10-20T00:00:00Z", document: state.project.document };
      state.revisions.push(row);
      return { data: row, error: null };
    }
    if (name === "save_editor_document") {
      if (args.p_expected_version !== state.project.version) return { data: null, error: { code: "P0409", message: "This clip was changed in another tab." } };
      state.project = { ...state.project, document: args.p_document, version: state.project.version + 1 };
      return { data: { ...state.project, document_hash: "h", updated_at: "now", manifest: null }, error: null };
    }
    return { data: null, error: { message: `unexpected ${name}` } };
  };
  return { client: { from: query, rpc } as never, state };
}

async function main() {
  const { client, state } = fakeSupabase({ document: doc("A"), generated: doc("Original") });

  // An edit was checkpointed (A), then the clip changed to B.
  await rpc(client, "checkpoint_editor_project", { p_clip_id: CLIP, p_kind: "agent", p_label: "MCP" });
  state.project.document = doc("B");

  const listed = await listVersions(client, CLIP);
  assert.ok(listed.ok);
  assert.equal((listed.value.versions as unknown[]).length, 1);
  assert.equal(listed.value.original, true);
  const [first] = listed.value.versions as { id: string }[];

  const restored = await restoreVersion(client, CLIP, first!.id);
  assert.ok(restored.ok, JSON.stringify(restored));
  assert.equal((state.project.document as ReturnType<typeof doc>).stage.children[0]!.name, "A", "the old document is back");
  assert.deepEqual(state.calls.slice(-2), ["checkpoint_editor_project", "save_editor_document"], "checkpoint first, then the save");
  assert.equal((state.revisions.at(-1)!.document as ReturnType<typeof doc>).stage.children[0]!.name, "B", "what was there is kept");

  const original = await restoreVersion(client, CLIP, "original");
  assert.ok(original.ok);
  assert.equal((state.project.document as ReturnType<typeof doc>).stage.children[0]!.name, "Original");

  const gone = await restoreVersion(client, CLIP, "99999999-9999-4999-8999-999999999999");
  assert.ok(!gone.ok && /no longer available/.test(gone.message));
  const other = await listVersions(client, "22222222-2222-4222-8222-222222222222");
  assert.ok(!other.ok && /not found/.test(other.message), "another user's clip reads as not found under RLS");

  const again = await restoreVersion(client, CLIP, "original");
  assert.ok(again.ok && again.value.unchanged === true, "restoring what is already there is a no-op");
  assert.equal(state.calls.at(-1), "save_editor_document", "and writes nothing");

  const before = state.revisions.length;
  state.revisions.push({ id: "00000000-0000-4000-8000-0000000000aa", clip_id: CLIP, number: 99, kind: "manual", label: null, created_at: "", document: { version: 1, stage: "broken" } });
  const unreadable = await restoreVersion(client, CLIP, "00000000-0000-4000-8000-0000000000aa");
  assert.ok(!unreadable.ok && /older editor/.test(unreadable.message), JSON.stringify(unreadable));
  assert.equal(state.revisions.length, before + 1, "no checkpoint for a restore that cannot happen");

  const racing = fakeSupabase({ document: doc("A"), generated: doc("Original") });
  // The editor saves between the read and the restore's save.
  const calls = racing.client as { rpc: (name: string, args: Record<string, unknown>) => Promise<unknown> };
  const realRpc = calls.rpc;
  calls.rpc = async (name, args) => {
    if (name === "save_editor_document") racing.state.project = { ...racing.state.project, version: racing.state.project.version + 1 };
    return realRpc(name, args);
  };
  const raced = await restoreVersion(racing.client, CLIP, "original");
  assert.ok(!raced.ok && /changed while restoring/.test(raced.message), JSON.stringify(raced));

  // The editor autosaves while restore_version reads and validates: refused at the checkpoint, so
  // no "before restoring" version is left for a restore that never happened.
  const stale = fakeSupabase({ document: doc("A"), generated: doc("Original") });
  const staleCalls = stale.client as { rpc: (name: string, args: Record<string, unknown>) => Promise<unknown> };
  const staleRpc = staleCalls.rpc;
  staleCalls.rpc = async (name, args) => {
    if (name === "checkpoint_editor_project") stale.state.project = { ...stale.state.project, version: stale.state.project.version + 1 };
    return staleRpc(name, args);
  };
  const late = await restoreVersion(stale.client, CLIP, "original");
  assert.ok(!late.ok && /changed while restoring/.test(late.message), JSON.stringify(late));
  assert.equal(stale.state.revisions.length, 0, "no phantom version");

  const noOriginal = fakeSupabase({ document: doc("A"), generated: null });
  const none = await restoreVersion(noOriginal.client, CLIP, "original");
  assert.ok(!none.ok && /no original/.test(none.message));

  console.log("versions.check: ok");
}

const rpc = (client: never, name: string, args: Record<string, unknown>) => (client as { rpc: (n: string, a: Record<string, unknown>) => Promise<unknown> }).rpc(name, args);

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
