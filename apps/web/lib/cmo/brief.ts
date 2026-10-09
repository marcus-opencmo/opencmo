/**
 * Video brief (architecture P3) → the message the project assistant receives. Shared by the
 * Approvals card and the project page, so the founder sees exactly what will be sent.
 */

export type VideoBrief = { hook: string; broll: string; visuals: string; pacing: string };

export function briefPrompt(brief: VideoBrief): string {
  const lines = [`Edit these clips to this brief from my CMO. Show me the changes before applying them.`, `Hook: ${brief.hook}`];
  if (brief.broll) lines.push(`B-roll: ${brief.broll}`);
  if (brief.visuals) lines.push(`Visuals: ${brief.visuals}`);
  if (brief.pacing) lines.push(`Pacing: ${brief.pacing}`);
  return lines.join("\n");
}
