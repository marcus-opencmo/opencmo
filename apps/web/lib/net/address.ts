/**
 * Which hosts and addresses a server-side fetch of a user-supplied URL may reach.
 *
 * A port of `packages/engine/opencmo/capture/addresses.py`; both read the same cases from
 * `packages/contracts/private-addresses.json`, so the web app and the worker cannot drift apart.
 * The usual SSRF targets hide in encodings a prefix list misses: IPv4 inside IPv6 (mapped, 6to4,
 * Teredo, NAT64), and `2130706433` / `0x7f.1` for 127.0.0.1 — `new URL` turns the last two into
 * dotted quads, which is why callers must check `url.hostname`, never the raw string.
 *
 * No Node imports: it may be bundled for the browser.
 */

/** The only ports we fetch on; anything else is refused whatever the scheme. */
export const DEFAULT_PORTS: Record<string, number> = { "http:": 80, "https:": 443 };
const ALLOWED_PORTS = new Set(Object.values(DEFAULT_PORTS));

const BLOCKED_NAMES = ["localhost", "local", "internal", "intranet", "lan", "home.arpa", "onion"];

function ipv4Private(bytes: number[]): boolean {
  const [a, b, c] = bytes;
  return (
    a === 0 || a === 10 || a === 127 || a >= 224 ||
    (a === 100 && b >= 64 && b <= 127) ||
    (a === 169 && b === 254) ||
    (a === 172 && b >= 16 && b <= 31) ||
    (a === 192 && b === 168) ||
    (a === 192 && b === 0 && (c === 0 || c === 2)) ||
    (a === 192 && b === 88 && c === 99) ||
    (a === 198 && (b === 18 || b === 19)) ||
    (a === 198 && b === 51 && c === 100) ||
    (a === 203 && b === 0 && c === 113)
  );
}

function parseIpv4(text: string): number[] | null {
  const parts = text.split(".");
  if (parts.length !== 4 || !parts.every((p) => /^\d{1,3}$/.test(p))) return null;
  const bytes = parts.map(Number);
  return bytes.every((n) => n <= 255) ? bytes : null;
}

/** 16 bytes, or null when `text` is not an IPv6 address. */
function parseIpv6(text: string): number[] | null {
  let head = text;
  let tail: number[] = [];
  const v4 = text.match(/^(.*:)(\d+\.\d+\.\d+\.\d+)$/);
  if (v4) {
    const quad = parseIpv4(v4[2]);
    if (!quad) return null;
    head = v4[1].endsWith("::") ? v4[1] : v4[1].slice(0, -1);
    tail = [(quad[0] << 8) | quad[1], (quad[2] << 8) | quad[3]];
  }
  const halves = head.split("::");
  if (halves.length > 2) return null;
  const words = (part: string): number[] | null => {
    if (!part) return [];
    const groups = part.split(":");
    return groups.every((g) => /^[0-9a-f]{1,4}$/i.test(g)) ? groups.map((g) => parseInt(g, 16)) : null;
  };
  const before = words(halves[0]);
  const after = halves.length === 2 ? words(halves[1]) : [];
  if (!before || !after) return null;
  const known = before.length + after.length + tail.length;
  let all: number[];
  if (halves.length === 2) {
    if (known > 7) return null;
    all = [...before, ...Array(8 - known).fill(0), ...after, ...tail];
  } else {
    all = [...before, ...tail];
  }
  if (all.length !== 8) return null;
  return all.flatMap((w) => [w >> 8, w & 0xff]);
}

/** 4 or 6 for a literal address (brackets allowed), 0 for a name. */
export function ipVersion(host: string): 0 | 4 | 6 {
  const text = host.replace(/^\[|\]$/g, "");
  if (parseIpv4(text)) return 4;
  return text.includes(":") && parseIpv6(text.split("%", 1)[0]) ? 6 : 0;
}

/** True for every address a server-side fetch must never connect to; unparsable counts as private. */
export function privateAddress(address: string): boolean {
  const ip = address.split("%", 1)[0].replace(/^\[|\]$/g, "").toLowerCase();
  const quad = parseIpv4(ip);
  if (quad) return ipv4Private(quad);
  const b = parseIpv6(ip);
  if (!b) return true;
  const word = (i: number) => (b[i * 2] << 8) | b[i * 2 + 1];
  const zero = (from: number, to: number) => b.slice(from, to).every((x) => x === 0);
  // IPv4 carried inside IPv6 is judged as that IPv4 address.
  if (zero(0, 10) && word(5) === 0xffff) return ipv4Private(b.slice(12)); // ::ffff:a.b.c.d
  if (word(0) === 0x0064 && word(1) === 0xff9b && zero(4, 12)) return ipv4Private(b.slice(12)); // NAT64
  if (word(0) === 0x2002) return ipv4Private(b.slice(2, 6)); // 6to4
  if (word(0) === 0x2001 && word(1) === 0) return ipv4Private(b.slice(12).map((x) => x ^ 0xff)); // Teredo client
  // Global unicast is 2000::/3; inside it, 2001::/23 (IETF) and 2001:db8::/32 (docs) are not global.
  if ((word(0) & 0xe000) !== 0x2000) return true;
  if (word(0) === 0x2001 && (word(1) < 0x0200 || word(1) === 0x0db8)) return true;
  return false;
}

/** Names that are never public, whatever DNS says: `localhost`, single labels, `.internal`… */
export function blockedName(host: string): boolean {
  const name = host.toLowerCase().replace(/\.+$/, "");
  if (!name || !name.includes(".")) return true;
  return BLOCKED_NAMES.some((blocked) => name === blocked || name.endsWith(`.${blocked}`));
}

export type Refusal = { refused: string };

/**
 * The syntax half of the guard: scheme, userinfo, port, and the host itself when it is a literal
 * address or a never-public name. Hosts that need DNS are returned for the caller to resolve.
 */
export function checkUrl(url: URL): { host: string; port: number } | Refusal {
  const port = url.port ? Number(url.port) : DEFAULT_PORTS[url.protocol];
  if (!(url.protocol in DEFAULT_PORTS)) return { refused: "scheme" };
  if (url.username || url.password) return { refused: "userinfo" };
  if (!ALLOWED_PORTS.has(port)) return { refused: "port" };
  const host = url.hostname.replace(/^\[|\]$/g, "").toLowerCase().replace(/\.+$/, "");
  if (ipVersion(host)) return privateAddress(host) ? { refused: "private address" } : { host, port };
  // A host made only of digits, dots and hex is a number `new URL` did not turn into an address
  // (e.g. out of range); never send that to DNS.
  if (/^(0x[0-9a-f]*|\d+)(\.(0x[0-9a-f]*|\d+))*$/i.test(host)) return { refused: "private address" };
  if (blockedName(host)) return { refused: "name" };
  return { host, port };
}

export const refused = (result: ReturnType<typeof checkUrl>): result is Refusal => "refused" in result;
