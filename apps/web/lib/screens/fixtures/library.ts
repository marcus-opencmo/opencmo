import type { LibraryScreen } from "../library";
import { at } from "./shared";

/** `Library.dc.html`, all four tabs. */
export const libraryFixture: LibraryScreen = {
  site: "opencmo.io",
  documents: [
    { kind: "product", title: "Product Information", summary: "An AI CMO for solo founders: a video editor, post drafts and Reddit leads you approve.", fields: 9, editedBy: "user", editedAt: at("2026-10-14", "10:00"), note: null },
    { kind: "strategy", title: "Marketing Strategy", summary: "Ideal customer, their pains, positioning, why choose you, words and claims to avoid.", fields: 7, editedBy: "user", editedAt: at("2026-10-20", "10:00"), note: null },
    { kind: "competitors", title: "Competitor Analysis", summary: "4 competitors and the accounts Research watches each Sunday.", fields: 4, editedBy: "agent", editedAt: at("2026-10-25", "07:00"), note: "Research updates the outliers · you pick the competitors" },
    { kind: "content_strategy", title: "Content Strategy", summary: "Pillars, formats and how often to post on each platform.", fields: 5, editedBy: "agent", editedAt: at("2026-10-12", "09:00"), note: null },
  ],
  brandKits: [
    {
      id: "kit-sample",
      name: "OpenCMO · default kit",
      colors: { primary: "#ef4a1a", secondary: "#2b2723", accent: "#ffd8c6", text: "#ffffff", background: "#26282c" },
      fonts: { heading: "Inter", body: "Inter" },
      captionStyle: "spotlight",
      aspect: "9:16",
      fit: "fill",
      logo: { url: null, corner: "top-right", size: 0.08 },
    },
  ],
  voice: {
    notes: [
      { id: "v-1", text: "Short sentences, one idea each.", platform: null, source: "From your edit: wrong voice", at: at("2026-10-27", "09:12"), weight: 0.97, replaces: null },
      { id: "v-2", text: "“We” on X, “I” on LinkedIn.", platform: "linkedin", source: "From your edit: wrong voice", at: at("2026-10-22", "16:40"), weight: 0.88, replaces: null },
      { id: "v-3", text: "Name the feature, then show it.", platform: "x", source: "Approved as drafted", at: at("2026-10-14", "08:05"), weight: 0.75, replaces: "lead with the pain (Oct 9)" },
    ],
    wordsCut: ["game-changer", "unlock", "seamless", "leverage"],
  },
  skills: {
    writing: [
      { id: "no-ai-slop", name: "Plain writing (No AI Slop)", origin: "built_in", note: "Guidance on stock phrases and patterns to avoid, never a hard filter", readBy: ["Writer", "Checker", "Sales", "CMO chat"] },
      { id: "x-writing", name: "Writing for X", origin: "built_in", note: "One idea per post, a clear first line, no links and no hashtags", readBy: ["Writer", "Checker"] },
      { id: "s-launch", name: "Launch threads", origin: "yours", note: "Saved from a chat on Oct 18", readBy: ["Writer"] },
    ],
    video: [
      { id: "s-listicle", name: "Senior dev listicle", origin: "built_in", note: "A style skill for list videos", readBy: ["Studio", "Editor Assistant"] },
      { id: "s-demo", name: "OpenCMO demo cut", origin: "yours", note: "Saved from the editor Assistant", readBy: ["Editor Assistant"] },
    ],
  },
};

export const libraryEmpty: LibraryScreen = {
  site: null,
  documents: [],
  brandKits: [],
  voice: { notes: [], wordsCut: [] },
  skills: { writing: [], video: [] },
};
