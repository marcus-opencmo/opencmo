/**
 * The v2 rail (Main.dc.html). Each entry names the screen it opens, so the rail can hide a screen that is not live in
 * production instead of showing it as "coming soon".
 */

export type ScreenName =
  | "dashboard"
  | "analytics"
  | "brain"
  | "library"
  | "research"
  | "writer"
  | "studio"
  | "sales"
  | "schedule"
  | "settings";

/** Departments that can be stuck; the rail puts a red square next to them. */
export type DepartmentName = "research" | "writer" | "studio" | "sales" | "schedule" | "publish";

export type NavEntry = {
  /** Null for entries that are not a v2 screen (the editor) and are always shown. */
  screen: ScreenName | null;
  label: string;
  href: string;
  /** Layout segments under `app/app/` that light this entry. */
  segments: (string | null)[];
  department?: DepartmentName;
};

export const NAV_MAIN: NavEntry[] = [
  { screen: "dashboard", label: "Dashboard", href: "/app", segments: [null, "inbox"] },
  { screen: "analytics", label: "Analytics", href: "/app/analytics", segments: ["analytics"] },
  { screen: "brain", label: "Brain", href: "/app/brain", segments: ["brain"] },
  { screen: "library", label: "Library", href: "/app/library", segments: ["library", "brand"] },
];

export const NAV_DEPARTMENTS: NavEntry[] = [
  { screen: "research", label: "Research", href: "/app/research", segments: ["research"], department: "research" },
  { screen: "writer", label: "Writer", href: "/app/writer", segments: ["writer"], department: "writer" },
  { screen: "studio", label: "Studio", href: "/app/studio", segments: ["studio", "projects", "jobs"], department: "studio" },
  { screen: "sales", label: "Sales", href: "/app/sales", segments: ["sales"], department: "sales" },
  { screen: "schedule", label: "Schedule", href: "/app/schedule", segments: ["schedule"], department: "schedule" },
];

export const NAV_MAKE: NavEntry[] = [{ screen: null, label: "Editor", href: "/app/editor", segments: ["editor", "video"] }];

export const NAV_SETTINGS: NavEntry = { screen: "settings", label: "Settings", href: "/app/settings", segments: ["settings", "billing"] };

/** Screens whose page works today whatever their v2 data says, so they are never hidden. */
const ALWAYS: ReadonlySet<ScreenName> = new Set(["dashboard", "settings"]);

export function isShown(entry: NavEntry, hideSample: boolean, available: Partial<Record<ScreenName, boolean>>): boolean {
  if (!entry.screen || !hideSample || ALWAYS.has(entry.screen)) return true;
  return available[entry.screen] === true;
}

export const isCurrent = (entry: NavEntry, segment: string | null) => entry.segments.includes(segment);
