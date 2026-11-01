/**
 * S4 Studio squad evals (P6, `studio.md` §10). One case per squad that raises a video-like card, on fixed
 * inputs; each squad's own reviewer is the code tier, the judge's questions are the model tier.
 *
 *   s4-shorts    — the Clip editor (`pickShorts`) on a fixed 90 s founder talk: `reviewShorts` (15–60 s,
 *                  whole sentences, the hook in the first 3 s, the right count), then the judge per short
 *   s4-slideshow — `write_slides` on the fixture's brief, then the frame (`reviewSlides`: text fits) and
 *                  the writer's checks (no invented numbers, avoid words), then the judge
 *   s4-long-take — the video brief → `create_video` request (`briefRequest`): the Director's input has the
 *                  goal, the hooks and the key points; the render-level measures (frozen shots, jumps at shot
 *                  boundaries, look-check pass rate) need a render on the worker, so they are reported as
 *                  pending here and measured by the look check at runtime
 *
 * Judge questions are constants below; they go into the report word for word.
 */

import type { CaseResult } from "@/lib/eval/compare";
import { pickShorts, reviewShorts, shortCount, candidates, type Word } from "@/lib/departments/studio/shorts/squad";
import { reviewSlides } from "@/lib/departments/studio/slideshow/build";
import { briefRequest } from "@/lib/departments/studio/video";

import { SlidesDraftSchema, VideoBriefSchema } from "../../../writer/types";
import { checkPost } from "../../check-post";
import { checkRules } from "../../context";
import { cascade } from "../../judge";
import { memoryStore } from "../../memory-store";
import { FIXTURES } from "../fixtures";
import type { EvalSquad } from "../studio-types";
import { registerCases, type EvalCase, type EvalEnv } from "../types";

const BUDGET_MS = 240_000;

export const SHORT_QUESTIONS = [
  "The short makes sense on its own: someone who never saw the full video understands it.",
  "Its first sentence is a hook that makes a founder want to keep watching.",
] as const;
export const SLIDES_QUESTIONS = [
  "Each slide holds one idea a reader takes in within a few seconds.",
  "The first slide is a hook and the last one says what to do next.",
] as const;
export const LONG_TAKE_QUESTIONS = ["The request tells a video team exactly what to show, for whom, and what the viewer should do after."] as const;

/** A fixed 90 s founder talk (Paylane, the first fixture): sentences timed at about 2.5 words a second. */
export const TALK = [
  "Most freelancers lose money on invoices they already earned.",
  "Not because clients refuse to pay, but because nobody reminds them.",
  "I learned this the hard way in my first year of freelancing.",
  "Half my invoices went quiet, and I felt rude chasing them.",
  "So I wrote one polite reminder and sent it on day three, day seven and day fourteen.",
  "The tone matters more than the timing.",
  "Say the amount, say the due date, and make paying one click away.",
  "Never apologise for asking to be paid for work you finished.",
  "After a few months I stopped dreading the end of the month.",
  "That reminder flow is what Paylane does for you now.",
  "You write the invoice, and it sends the reminders on your schedule.",
  "Clients get a friendly note with a pay button, nothing more.",
  "If they pay, the reminders stop on their own.",
  "If they do not, you see who is late before it becomes a problem.",
  "It costs twelve dollars a month, which is less than one late invoice.",
  "Try it on the next invoice you send this week.",
];

export function timedWords(sentences: readonly string[], wordsPerSecond = 2.5, pause = 0.4): Word[] {
  const words: Word[] = [];
  let at = 0;
  for (const sentence of sentences) {
    for (const text of sentence.split(/\s+/)) {
      const end = at + 1 / wordsPerSecond;
      words.push({ text, start: Math.round(at * 100) / 100, end: Math.round((end - 0.05) * 100) / 100 });
      at = end;
    }
    at += pause;
  }
  return words;
}

const fail = (id: string, epoch: number, note: string): CaseResult => ({ id, epoch, pass: false, decided_by: "error", notes: [note] });
const caseId = (squad: EvalSquad, fixture: string, output: string) => `s4-${squad.replace("_", "-")}:${fixture}:${output}`;

const shortsCase: EvalCase = {
  job: "s4-shorts",
  once: true,
  async run(_fixture, env) {
    const fixture = FIXTURES[0]!;
    const words = timedWords(TALK);
    const id = (output: string) => caseId("shorts", fixture.name, output);
    const picked = await pickShorts({ words, about: String(fixture.docs.product?.one_liner ?? "") });
    if (typeof picked === "string") return [fail(id("run"), env.epoch, picked)];
    const count = shortCount(candidates(words));
    const results: CaseResult[] = [{ id: id("run"), epoch: env.epoch, pass: true, decided_by: "code" }];
    const reviewer = reviewShorts(picked, words, count);
    results.push({ id: id("review"), epoch: env.epoch, pass: reviewer.length === 0, decided_by: "code", ...(reviewer.length ? { notes: reviewer } : {}) });
    for (const [index, short] of picked.entries()) {
      const text = words.filter((w) => w.start >= short.start && w.end <= short.end).map((w) => w.text).join(" ");
      env.log(`[short ${index + 1}] ${short.start}–${short.end} s · ${short.hook}: ${text}`);
      results.push(await cascade(id(`short-${index}`), env.epoch, [], env.judge, { job: "A stand-alone short cut from the founder's own video", docs: fixture.docs, output: text, criteria: [...SHORT_QUESTIONS] }));
    }
    return results;
  },
};

const slideshowCase: EvalCase = {
  job: "s4-slideshow",
  async run(fixture, env) {
    const id = (output: string) => caseId("slideshow", fixture.name, output);
    const mem = memoryStore(fixture.docs, []);
    // A slideshow item's idea comes from the plan, which takes it from a content pillar: short, like a heading.
    const pillars = (fixture.docs.content_strategy?.pillars ?? []) as { ideas?: string[] }[];
    const idea = pillars[0]?.ideas?.[0] ?? fixture.brief;
    const run = mem.enqueue("write_slides", { idea, reason: "From the content strategy" });
    await env.drain(mem.store, { runId: run.id, budgetMs: BUDGET_MS });
    const parsed = SlidesDraftSchema.pick({ slides: true }).safeParse(run.output);
    if (run.status !== "done" || !parsed.success) return [fail(id("run"), env.epoch, run.error ?? "no slides")];
    const slides = parsed.data.slides;
    const rules = checkRules(fixture.docs);
    const issues = [
      ...reviewSlides(slides),
      ...(slides.length < 5 || slides.length > 10 ? [`${slides.length} slides`] : []),
      ...slides.flatMap((s, i) => checkPost(`${s.heading}\n${s.body}`, rules).filter((issue) => !/characters|link/i.test(issue)).map((issue) => `slide ${i + 1}: ${issue}`)),
    ];
    const text = slides.map((s, i) => `${i + 1}. ${s.heading}${s.body ? ` — ${s.body}` : ""}`).join("\n");
    env.log(text);
    return [
      { id: id("run"), epoch: env.epoch, pass: true, decided_by: "code" },
      await cascade(id("slides"), env.epoch, issues, env.judge, { job: `A slideshow about "${idea}"`, docs: fixture.docs, output: text, criteria: [...SLIDES_QUESTIONS] }),
    ];
  },
};

const longTakeCase: EvalCase = {
  job: "s4-long-take",
  async run(fixture, env) {
    const id = (output: string) => caseId("long_take", fixture.name, output);
    const mem = memoryStore(fixture.docs, []);
    const run = mem.enqueue("write_video_brief", { order_id: "eval-long-take", idea: fixture.brief, reason: "From the content strategy", seconds: 60, aspect: "9:16" });
    await env.drain(mem.store, { runId: run.id, budgetMs: BUDGET_MS });
    const brief = VideoBriefSchema.safeParse((run.output as { brief?: unknown } | null)?.brief);
    if (run.status !== "done" || !brief.success) return [fail(id("run"), env.epoch, run.error ?? "no brief")];
    const request = briefRequest(brief.data, { avoid: checkRules(fixture.docs).avoid ?? [] });
    const issues = [
      ...(!/^Goal: /.test(request.prompt) ? ["the request has no goal"] : []),
      ...(brief.data.hooks.length && !request.prompt.includes(brief.data.hooks[0]!) ? ["the first hook is not in the request"] : []),
      ...brief.data.keyPoints.filter((p) => !request.prompt.includes(p)).map((p) => `key point missing: ${p.slice(0, 60)}`),
      ...(request.seconds > 90 ? [`${request.seconds} s is over the 90 s cap`] : []),
    ];
    env.log(request.prompt);
    return [
      { id: id("run"), epoch: env.epoch, pass: true, decided_by: "code" },
      await cascade(id("request"), env.epoch, issues, env.judge, { job: "The request a video team makes a 60 s marketing video from", docs: fixture.docs, output: request.prompt, criteria: [...LONG_TAKE_QUESTIONS] }),
      { id: id("render"), epoch: env.epoch, pass: null, decided_by: "code", pending: "needs a render on the worker: frozen shots, jumps at shot boundaries and the look check are measured at runtime" },
    ];
  },
};

/** Shared for a check: the fake env runs the three cases end to end without a network. */
export const STUDIO_CASES: readonly EvalCase[] = [shortsCase, slideshowCase, longTakeCase];
export type { EvalEnv };

registerCases([...STUDIO_CASES]);
