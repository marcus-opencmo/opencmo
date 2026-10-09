/**
 * Markdown của câu trả lời Assistant → cây khối/đoạn, để panel dựng thành
 * phần tử React. Model (Claude, Gemini) trả lời bằng markdown; in thẳng ra là
 * `**1. Build…**` và `*   **The Idea:**` nằm nguyên trên màn hình.
 *
 * Không dùng thư viện và không đi qua HTML: cây này chỉ có chữ, React tự thoát
 * ký tự, nên chữ của model (hay chữ người dùng dán vào lặp lại) không chèn được
 * thẻ nào. Link chỉ nhận http(s).
 *
 * Phạm vi đúng bằng thứ model hay viết trong chat: tiêu đề, đoạn, danh sách có
 * lồng, trích dẫn, đường kẻ, khối code; trong dòng là đậm, nghiêng, code, link.
 * Bảng và HTML thô hiện nguyên chữ. Đang stream thì dấu chưa đóng (`**abc`) hiện
 * nguyên tới khi đóng — không đoán.
 */

export type Inline =
  | { type: "text"; text: string }
  | { type: "strong"; children: Inline[] }
  | { type: "em"; children: Inline[] }
  | { type: "code"; text: string }
  | { type: "link"; href: string; children: Inline[] };

export type ListItem = { children: Inline[]; items?: List };
export type List = { ordered: boolean; start: number; items: ListItem[] };

export type Block =
  | { type: "heading"; level: 1 | 2 | 3; children: Inline[] }
  | { type: "paragraph"; children: Inline[] }
  | { type: "list"; list: List }
  | { type: "quote"; children: Inline[] }
  | { type: "code"; lang: string; text: string }
  | { type: "rule" };

const BULLET = /^(\s*)([-*+]|\d{1,3}[.)])\s+(.*)$/;
const FENCE = /^\s*```\s*([\w+-]*)\s*$/;

export function parseMarkdown(source: string): Block[] {
  const lines = source.replace(/\r\n?/g, "\n").split("\n");
  const blocks: Block[] = [];
  let paragraph: string[] = [];
  const flush = () => {
    if (paragraph.length) blocks.push({ type: "paragraph", children: parseInline(paragraph.join("\n")) });
    paragraph = [];
  };

  for (let index = 0; index < lines.length; index++) {
    const line = lines[index]!;
    const fence = FENCE.exec(line);
    if (fence) {
      flush();
      const body: string[] = [];
      while (++index < lines.length && !FENCE.test(lines[index]!)) body.push(lines[index]!);
      blocks.push({ type: "code", lang: fence[1] ?? "", text: body.join("\n") });
      continue;
    }
    if (!line.trim()) {
      flush();
      continue;
    }
    const heading = /^(#{1,6})\s+(.*?)\s*#*\s*$/.exec(line);
    if (heading) {
      flush();
      blocks.push({ type: "heading", level: Math.min(3, heading[1]!.length) as 1 | 2 | 3, children: parseInline(heading[2]!) });
      continue;
    }
    if (/^\s*([-*_])(\s*\1){2,}\s*$/.test(line)) {
      flush();
      blocks.push({ type: "rule" });
      continue;
    }
    if (/^\s*>/.test(line)) {
      flush();
      const quoted: string[] = [];
      for (; index < lines.length && /^\s*>/.test(lines[index]!); index++) quoted.push(lines[index]!.replace(/^\s*>\s?/, ""));
      index--;
      blocks.push({ type: "quote", children: parseInline(quoted.join("\n")) });
      continue;
    }
    if (BULLET.test(line)) {
      flush();
      const taken: string[] = [];
      for (; index < lines.length; index++) {
        const next = lines[index]!;
        if (BULLET.test(next)) taken.push(next);
        // Dòng tiếp của một mục (thụt vào) dính vào mục đó.
        else if (next.trim() && /^\s{2,}/.test(next) && taken.length) taken[taken.length - 1] += ` ${next.trim()}`;
        else if (!next.trim() && index + 1 < lines.length && BULLET.test(lines[index + 1]!)) continue;
        else break;
      }
      index--;
      blocks.push({ type: "list", list: parseList(taken) });
      continue;
    }
    paragraph.push(line);
  }
  flush();
  return blocks;
}

function parseList(lines: string[]): List {
  const indentOf = (line: string) => BULLET.exec(line)![1]!.replace(/\t/g, "    ").length;
  const build = (from: number, base: number): [List, number] => {
    const first = BULLET.exec(lines[from]!)!;
    const ordered = /\d/.test(first[2]!);
    const list: List = { ordered, start: ordered ? Number.parseInt(first[2]!, 10) : 1, items: [] };
    let index = from;
    while (index < lines.length) {
      const indent = indentOf(lines[index]!);
      if (indent < base) break;
      if (indent > base && list.items.length) {
        const [nested, next] = build(index, indent);
        list.items[list.items.length - 1]!.items = nested;
        index = next;
        continue;
      }
      list.items.push({ children: parseInline(BULLET.exec(lines[index]!)![3]!) });
      index++;
    }
    return [list, index];
  };
  return build(0, indentOf(lines[0]!))[0];
}

const SAFE_URL = /^https?:\/\/[^\s<>"']+$/i;

/** Trong dòng: code trước (bên trong không xử lý gì), rồi link, đậm, nghiêng. */
export function parseInline(text: string): Inline[] {
  const out: Inline[] = [];
  let plain = "";
  const push = (node: Inline) => {
    if (plain) out.push({ type: "text", text: plain });
    plain = "";
    out.push(node);
  };
  for (let index = 0; index < text.length; ) {
    const rest = text.slice(index);
    const code = /^(`+)([\s\S]*?[^`])\1(?!`)/.exec(rest);
    if (code) {
      push({ type: "code", text: code[2]!.trim() });
      index += code[0].length;
      continue;
    }
    const link = /^\[([^\]\n]+)\]\(([^)\s]+)\)/.exec(rest);
    if (link && SAFE_URL.test(link[2]!)) {
      push({ type: "link", href: link[2]!, children: parseInline(link[1]!) });
      index += link[0].length;
      continue;
    }
    const strong = /^(\*\*|__)(?=\S)([\s\S]*?\S)\1/.exec(rest);
    if (strong) {
      push({ type: "strong", children: parseInline(strong[2]!) });
      index += strong[0].length;
      continue;
    }
    // `_` giữa chữ (snake_case, tên file) không phải nghiêng.
    const em = /^(\*|_)(?=\S)([\s\S]*?\S)\1(?![\w*])/.exec(rest);
    if (em && !(em[1] === "_" && /\w$/.test(plain))) {
      push({ type: "em", children: parseInline(em[2]!) });
      index += em[0].length;
      continue;
    }
    plain += text[index];
    index++;
  }
  if (plain) out.push({ type: "text", text: plain });
  return out;
}
