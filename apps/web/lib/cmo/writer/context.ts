/**
 * The data a writer prompt carries after its fixed system prompt (the cached prefix): the platform profile,
 * the founder's rules (memory tier 0), their voice notes, then documents, other memories, recent texts and
 * research. Everything here is data inside tags; outside text (research) stays marked as such.
 *
 * Order matters: the founder's rules first, then how they write. Both beat the No AI Slop guidance in the
 * prefix when they disagree (`writer.md` §5).
 */

import { correctionsBlock, documentsBlock, lessonsBlock, memoriesBlock } from "../jobs/context";
import type { CmoStore, MemoryTopic } from "../jobs/types";
import { profileOf } from "../platforms";
import type { VoiceNote, WriterContext, WriterProfile } from "./types";

/** At most this many voice notes reach a prompt; the read RPC already sorts them newest and heaviest first. */
export const VOICE_NOTES_MAX = 12;

export function profileBlock(profile: WriterProfile): string {
  const lines = [
    `platform: ${profile.id} (${profile.label})`,
    `kind: ${profile.kind}`,
    profile.kind === "youtube" ? `title limit: ${profile.title ?? 100} characters; description limit: ${profile.limit} characters` : `limit: ${profile.limit} characters`,
    profile.visibleBeforeMore ? `visible before "more": about ${profile.visibleBeforeMore} characters; the hook must land before the cut` : "visible before \"more\": all of it",
    `tone: ${profile.tone}`,
    `hashtags: ${profile.hashtags ? `at most ${profile.hashtags}` : "none"}`,
    `links: ${profile.links ? "allowed" : "none"}`,
  ];
  return `<platform>\n${lines.join("\n")}\n</platform>`;
}

/** The profile a writer prompt was built for, read back from the `<platform>` block it starts with. */
export function profileFromPrompt(prompt: string): string | null {
  return /^<platform>\nplatform: ([a-z_]+)/.exec(prompt)?.[1] ?? null;
}

/**
 * How the founder writes, weightiest (newest) first; each note says its platform and how much it counts, so a newer
 * habit outweighs an older one and a LinkedIn habit is read as LinkedIn's.
 */
export function voiceBlock(notes: readonly VoiceNote[]): string {
  if (!notes.length) return "";
  const top = [...notes].sort((a, b) => b.weight - a.weight || b.createdAt.localeCompare(a.createdAt)).slice(0, VOICE_NOTES_MAX);
  const label = (platform: string | null) => (platform ? (profileOf(platform)?.label ?? platform) : "any platform");
  const lines = top.map((note) => `- (${label(note.platform)}, weight ${note.weight.toFixed(2)}, ${note.createdAt.slice(0, 10)}) ${note.body}`);
  return `<founder_voice learned_from="the founder's approvals and edits" newer_counts_more="true">\n${lines.join("\n")}\n</founder_voice>`;
}

/**
 * What a writer remembers, split so each part takes its place in the prompt: the founder's rules (tier 0), their
 * voice notes (read apart, newest and heaviest first), then the topic's lessons and the other notes.
 */
export async function writerMemory(store: CmoStore, userId: string, topic: MemoryTopic = "post"): Promise<Pick<WriterContext, "corrections" | "voiceNotes" | "memories">> {
  const [corrections, notes, lessons, memories] = await Promise.all([
    store.corrections(userId),
    store.voiceNotes(userId, VOICE_NOTES_MAX),
    store.lessons(userId),
    store.memories(userId, 15, topic, { voice: false }),
  ]);
  const relevant = lessons.filter((lesson) => lesson.topic === topic || lesson.topic === "general");
  return {
    corrections,
    voiceNotes: notes.map((note) => ({ body: note.body, platform: note.platform, weight: note.weight, createdAt: note.created_at })),
    memories: [lessonsBlock(relevant), memoriesBlock(memories)].filter(Boolean).join("\n\n"),
  };
}

/** Everything after the cached prefix, in the order the writer reads it. `brief` is the kind's work order. */
export function writerData(context: WriterContext, profile: WriterProfile | null, brief: string): string {
  return [
    profile ? profileBlock(profile) : "",
    correctionsBlock(context.corrections),
    voiceBlock(context.voiceNotes),
    documentsBlock(context.documents),
    context.memories ?? "",
    context.insight ?? "",
    context.niche ?? "",
    context.recent.length ? `<recent_texts>\n${context.recent.map((text) => `- ${text}`).join("\n")}\n</recent_texts>` : "",
    brief,
  ].filter(Boolean).join("\n\n");
}
