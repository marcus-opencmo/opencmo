import { expect, test, type Page } from "@playwright/test";

import { SOURCE_VIDEO } from "./global-setup";
import { makeClipsInEditor, signIn, state } from "./helpers";

/**
 * MCP (G5): khoá API tạo ở Settings → client MCP gọi `/api/mcp` như Claude Code/Cursor: liệt kê,
 * sửa clip bằng đúng tool của Assistant, sinh media HAI BƯỚC (báo giá rồi xác nhận), thu hồi khoá.
 */

type Rpc = { result?: { content?: { text: string }[]; isError?: boolean; tools?: { name: string }[]; protocolVersion?: string }; error?: unknown };

async function mcp(page: Page, key: string, method: string, params?: unknown, id = 1): Promise<{ status: number; body: Rpc }> {
  const response = await page.request.post("/api/mcp", {
    headers: { authorization: `Bearer ${key}`, "content-type": "application/json" },
    data: { jsonrpc: "2.0", id, method, ...(params ? { params } : {}) },
  });
  return { status: response.status(), body: (await response.json().catch(() => ({}))) as Rpc };
}

const call = async (page: Page, key: string, name: string, args: Record<string, unknown>) => {
  const { body } = await mcp(page, key, "tools/call", { name, arguments: args });
  const text = body.result?.content?.[0]?.text ?? "";
  return { text, isError: body.result?.isError === true, json: (() => { try { return JSON.parse(text) as Record<string, unknown>; } catch { return null; } })() };
};

test("MCP: khoá API, sửa clip, sinh media hai bước, thu hồi", async ({ page }) => {
  test.setTimeout(900_000);
  await signIn(page, state().users.a);
  const projectId = await makeClipsInEditor(page, SOURCE_VIDEO);
  const clipId = /\/app\/editor\/([0-9a-f-]+)$/.exec(page.url())![1]!;

  // Không khoá: 401, không lộ gì.
  expect((await mcp(page, "ocm_" + "0".repeat(48), "initialize")).status).toBe(401);

  await page.goto("/app/settings");
  await page.getByTestId("api-key-name").fill("E2E MCP");
  await page.getByTestId("api-key-create").click();
  const key = (await page.getByTestId("api-key-created").innerText()).trim();
  expect(key).toMatch(/^ocm_[0-9a-f]{48}$/);
  await expect(page.getByTestId("api-key-list")).toContainText("E2E MCP");

  const init = await mcp(page, key, "initialize", { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "e2e", version: "1" } });
  expect(init.status).toBe(200);
  expect(init.body.result?.protocolVersion).toBe("2025-06-18");
  const tools = (await mcp(page, key, "tools/list")).body.result?.tools?.map((tool) => tool.name) ?? [];
  expect(tools).toEqual(expect.arrayContaining(["list_projects", "list_clips", "get_project_state", "add_text", "generate_media"]));
  expect(tools).not.toContain("capture");
  expect(tools).not.toContain("ask_user");

  expect((await call(page, key, "list_projects", {})).text).toContain(projectId);
  expect((await call(page, key, "list_clips", { project_id: projectId })).text).toContain(clipId);
  expect((await call(page, key, "get_project_state", { clip_id: clipId })).isError).toBe(false);

  // Sửa bằng đúng tool của Assistant; lượt ghi để lại checkpoint "MCP".
  const added = await call(page, key, "add_text", { clip_id: clipId, text: "FROM MCP", start: 0, end: 2 });
  expect(added.isError, added.text).toBe(false);
  const doc = async () => JSON.stringify(await (await page.request.get(`/api/v1/editor/document?clip_id=${clipId}`)).json());
  expect(await doc()).toContain("FROM MCP");
  const history = JSON.stringify(await (await page.request.get(`/api/v1/editor/revisions?clip_id=${clipId}`)).json());
  expect(history).toContain("MCP");

  // Sinh media: lần 1 chỉ báo giá (không tốn credit, chưa đặt gì), lần 2 kèm confirm mới sinh.
  const brief = { clip_id: clipId, kind: "image", model: "fake-image", quote: "we built this", idea: "a small team ships fast", subject: "a laptop on a desk at night" };
  const priced = await call(page, key, "generate_media", brief);
  expect(priced.isError, priced.text).toBe(false);
  expect(priced.json?.price_credits).toEqual(expect.any(Number));
  expect(await doc()).not.toContain("a laptop on a desk at night");
  const confirmed = await call(page, key, "generate_media", { clip_id: clipId, confirm: priced.json!.confirm });
  expect(confirmed.isError, confirmed.text).toBe(false);
  expect(confirmed.json?.generation_id).toEqual(expect.any(String));
  expect(await doc()).toContain('"generate":"image"');
  // Mã xác nhận sửa tay bị từ chối.
  const forged = await call(page, key, "generate_media", { clip_id: clipId, confirm: `${String(priced.json!.confirm).slice(0, -2)}xx` });
  expect(forged.isError).toBe(true);

  // Lô quá lớn bị từ chối: không vượt giới hạn nhịp bằng một POST nhiều thông điệp.
  const batch = await page.request.post("/api/mcp", {
    headers: { authorization: `Bearer ${key}`, "content-type": "application/json" },
    data: Array.from({ length: 21 }, (_, index) => ({ jsonrpc: "2.0", id: index, method: "ping" })),
  });
  expect(batch.status()).toBe(400);

  // Thu hồi: khoá thành 401 ngay.
  await page.reload();
  await page.getByTestId(`api-key-revoke-${key.slice(0, 12)}`).click();
  await expect(page.getByTestId("api-key-list")).toHaveCount(0);
  expect((await mcp(page, key, "tools/list")).status).toBe(401);
});
