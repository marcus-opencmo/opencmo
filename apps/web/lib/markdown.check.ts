/**
 * Markdown của Assistant: đúng cấu trúc, và không có đường nào ra HTML hay link lạ.
 */
import assert from "node:assert/strict";

import { parseInline, parseMarkdown, type Block, type Inline } from "@/lib/markdown";

const text = (nodes: Inline[]): string =>
  nodes.map((node) => (node.type === "text" || node.type === "code" ? node.text : text(node.children))).join("");

// Câu trả lời thật của Gemini (01/10): tiêu đề đậm có số, danh sách `*   ` lồng chữ đậm.
{
  const reply = [
    "Here are 3 concrete ideas:",
    "",
    '**1. Build a "Staircase" visual**',
    '*   **The Idea:** When he says "just like a little staircase" (at 9.3s), add a chart.',
    "*   **Why:** Visualizing the plan makes the comedy land.",
    "",
    "**2. Tighten the pacing**",
    "*   **The Idea:** Remove the silent pauses.",
  ].join("\n");
  const blocks = parseMarkdown(reply);
  assert.deepEqual(blocks.map((block) => block.type), ["paragraph", "paragraph", "list", "paragraph", "list"]);
  const heading = (blocks[1] as Extract<Block, { type: "paragraph" }>).children;
  assert.equal(heading[0]!.type, "strong");
  assert.equal(text(heading), '1. Build a "Staircase" visual');
  const list = (blocks[2] as Extract<Block, { type: "list" }>).list;
  assert.equal(list.ordered, false);
  assert.equal(list.items.length, 2);
  assert.equal(list.items[0]!.children[0]!.type, "strong");
  assert.equal(text(list.items[0]!.children), 'The Idea: When he says "just like a little staircase" (at 9.3s), add a chart.');
  // Không còn dấu markdown nào lọt ra chữ.
  assert.ok(!JSON.stringify(blocks).includes("**"));
}

// Danh sách có số, lồng, và dòng nối của một mục.
{
  const blocks = parseMarkdown("3. First\n   continued here\n4. Second\n   - nested a\n   - nested b\n5. Third");
  assert.equal(blocks.length, 1);
  const list = (blocks[0] as Extract<Block, { type: "list" }>).list;
  assert.equal(list.ordered, true);
  assert.equal(list.start, 3);
  assert.equal(list.items.length, 3);
  assert.equal(text(list.items[0]!.children), "First continued here");
  assert.equal(list.items[1]!.items?.items.length, 2);
  assert.equal(list.items[1]!.items?.ordered, false);
}

// Tiêu đề, trích dẫn, kẻ ngang, khối code (bên trong giữ nguyên, không đọc markdown).
{
  const blocks = parseMarkdown("## Plan\n\n> keep it **short**\n\n---\n\n```json\n{\"a\": \"**x**\"}\n```");
  assert.deepEqual(blocks.map((block) => block.type), ["heading", "quote", "rule", "code"]);
  assert.equal((blocks[0] as Extract<Block, { type: "heading" }>).level, 2);
  assert.equal((blocks[3] as Extract<Block, { type: "code" }>).text, '{"a": "**x**"}');
  assert.equal((blocks[3] as Extract<Block, { type: "code" }>).lang, "json");
}

// Trong dòng: code không bị đọc tiếp, nghiêng, snake_case không thành nghiêng.
{
  const nodes = parseInline("Use `set_props` on *one* layer, not my_clip_name.");
  assert.deepEqual(
    nodes.map((node) => node.type),
    ["text", "code", "text", "em", "text"],
  );
  assert.equal((nodes[1] as { text: string }).text, "set_props");
  assert.equal(text(nodes), "Use set_props on one layer, not my_clip_name.");
}

// An toàn: chỉ link http(s); HTML là chữ thường (React thoát ký tự khi vẽ).
{
  const ok = parseInline("[docs](https://opencmo.io/help)");
  assert.equal(ok[0]!.type, "link");
  for (const bad of ["[x](javascript:alert(1))", "[x](data:text/html,hi)", "[x](//evil.example)"]) {
    assert.ok(parseInline(bad).every((node) => node.type !== "link"), bad);
  }
  const html = parseMarkdown('<img src=x onerror="alert(1)">');
  assert.equal(html[0]!.type, "paragraph");
  assert.equal(text((html[0] as Extract<Block, { type: "paragraph" }>).children), '<img src=x onerror="alert(1)">');
}

// Đang stream: dấu chưa đóng hiện nguyên, không nuốt chữ.
{
  assert.equal(text(parseInline("**Build a sta")), "**Build a sta");
}

console.log("markdown: mọi kiểm tra xanh");
