import type { StudioItem, StudioScreen } from "../studio";
import { at } from "./shared";

const studioItem: Pick<
  StudioItem,
  "progress" | "favorite" | "editedAt" | "failure" | "projectId" | "editorHref" | "approvalId" | "canMarkFinished" | "edits"
> = {
  progress: null,
  favorite: false,
  editedAt: null,
  failure: null,
  projectId: null,
  editorHref: null,
  approvalId: null,
  canMarkFinished: false,
  edits: [],
};

export const studioFixture: StudioScreen = {
  items: [
    { ...studioItem, id: "st-1", kind: "upload", title: "Interview raw.mp4", subtitle: "Your upload · then transcript, about 2 min", status: "uploading", progress: 42, createdAt: at("2026-10-29", "10:40") },
    { ...studioItem, id: "st-2", kind: "video", title: "Editor launch · long take", subtitle: "AI video · 60 s · rendering 62%", status: "running", progress: 62, createdAt: at("2026-10-28", "09:00") },
    { ...studioItem, id: "st-3", kind: "video", title: "How the CMO plans a week", subtitle: "AI video · keyframes ready", status: "waiting_founder", favorite: true, createdAt: at("2026-10-28", "15:00"), approvalId: "card-price" },
    {
      ...studioItem,
      id: "st-4",
      kind: "upload",
      title: "Founder demo · recorded",
      subtitle: "Your upload · edited yesterday",
      status: "ready",
      createdAt: at("2026-10-27", "11:00"),
      editedAt: at("2026-10-28", "17:00"),
      projectId: "project-sample",
      editorHref: "/app/editor/clip-sample",
      canMarkFinished: true,
      clipId: "clip-sample",
      documentHash: "1".repeat(64),
      canCutShorts: false,
      edits: [{ id: "clip-sample", title: "Founder demo · first cut", editedAt: at("2026-10-28", "17:00"), editorHref: "/app/editor/clip-sample" }],
    },
    { ...studioItem, id: "st-5", kind: "short", title: "3 shorts · Editor launch", subtitle: "Cut from a finished edit · 9:16", status: "waiting_founder", createdAt: at("2026-10-29", "08:00"), approvalId: "card-shorts" },
    { ...studioItem, id: "st-6", kind: "video", title: "Cut by words · explainer", subtitle: "Explainer · 45 s · 2 shorts posted", status: "finished", createdAt: at("2026-10-22", "10:00"), editorHref: "/app/editor/clip-explainer" },
    { ...studioItem, id: "st-7", kind: "slideshow", title: "3 ways to cut a demo", subtitle: "Slideshow · 6 slides · MP4 + PNG set · posted Wed", status: "finished", createdAt: at("2026-10-27", "10:00") },
    { ...studioItem, id: "st-8", kind: "post_image", title: "Post image · launch card", subtitle: "Render failed", status: "failed", createdAt: at("2026-10-28", "12:00"), failure: "Moderation blocked one frame · credits refunded" },
  ],
  team: {
    title: "Editor launch · long take",
    steps: [
      { label: "Brief from Writer", state: "done" },
      { label: "Director: 12 beats", state: "done" },
      { label: "Reviewer checks", state: "done" },
      { label: "Keyframes · you approved the price", state: "done" },
      { label: "Shots · 8 of 12", state: "running" },
      { label: "Voice, music, render", state: "todo" },
      { label: "Look check → card 3", state: "todo" },
    ],
  },
  editStates: [{ clipId: "clip-sample", documentHash: "1".repeat(64), finishedAt: null, kind: "full" }],
};

export const studioEmpty: StudioScreen = { items: [], team: null, editStates: [] };
