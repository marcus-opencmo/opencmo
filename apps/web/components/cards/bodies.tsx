"use client";

import Link from "next/link";
import { useState } from "react";

import { Button, Tabs, Toggle } from "@/components/ui";
import type { CardBody, ScheduleOptions } from "@/lib/screens/approval-card";
import { DEPARTMENT_LABEL, PLATFORM_LABEL, type Platform } from "@/lib/screens/common";

import { CaptionList, charCount, type SaveCaption } from "./captions";
import { joinSlideText, slideTextProblem, splitSlideText } from "./slides";
import { formatSeconds } from "./labels";
import { AI_LABEL_PLATFORMS, PRIVACY_LABEL, TIKTOK_MUSIC_TERMS, formatWhen } from "./schedule";

type Body<K extends CardBody["kind"]> = Extract<CardBody, { kind: K }>;

/** Post: one tab per platform, the chosen version, the checks it passed and why it was written. */
export function PostBody({
  body,
  cardId,
  editing,
  draft,
  onDraft,
  onPick,
}: {
  body: Body<"post">;
  cardId: string;
  editing: boolean;
  draft: string;
  onDraft: (text: string) => void;
  /** Reports the text on screen, so Approve sends what the founder saw. */
  onPick: (text: string) => void;
}) {
  const [platform, setPlatform] = useState<Platform>(body.platforms[0]?.platform ?? "x");
  const [version, setVersion] = useState(0);
  const current = body.platforms.find((p) => p.platform === platform) ?? body.platforms[0];
  const versions = current?.versions ?? [];
  const index = Math.min(version, versions.length - 1);
  const text = versions[index] ?? "";
  const tabbed = body.platforms.length > 1;

  function pick(nextPlatform: Platform, nextVersion: number) {
    setPlatform(nextPlatform);
    setVersion(nextVersion);
    const list = body.platforms.find((p) => p.platform === nextPlatform)?.versions ?? [];
    onPick(list[Math.min(nextVersion, list.length - 1)] ?? "");
  }

  const length = charCount(editing ? draft : text);
  const limit = current?.limit ?? 0;
  const fold = current?.visibleBeforeMore ?? null;

  if (current?.thread) return <ThreadPosts posts={current.thread} limit={limit || 280} why={body.why} />;

  return (
    <>
      {tabbed ? (
        <Tabs
          label="Platform"
          idBase={`${cardId}-platform`}
          value={platform}
          onChange={(p) => pick(p, 0)}
          items={body.platforms.map((p) => ({ id: p.platform, label: PLATFORM_LABEL[p.platform] }))}
        />
      ) : null}
      <div id={`${cardId}-platform-panel`} role={tabbed ? "tabpanel" : undefined} aria-labelledby={tabbed ? `${cardId}-platform-${platform}` : undefined}>
        {editing ? (
          <label className="v2-field">
            <span>Edit before you approve</span>
            <textarea className="v2-input" value={draft} maxLength={4000} onChange={(event) => onDraft(event.target.value)} />
          </label>
        ) : (
          <FoldedText text={text} fold={fold} />
        )}
      </div>
      <div className="v2-card-chips">
        {limit ? (
          <span className={`v2-chip ${length > limit ? "is-stuck" : "is-posted"}`}>
            {length}/{limit}
          </span>
        ) : null}
        {body.checks.map((check) => (
          <span key={check} className="v2-chip is-posted">
            {check}
          </span>
        ))}
      </div>
      <div className="v2-card-meta">
        {versions.length > 1 ? (
          <span className="v2-card-versions">
            Version {index + 1} of {versions.length}
            <button type="button" className="v2-card-link" disabled={editing} onClick={() => pick(platform, (index + 1) % versions.length)}>
              Next version
            </button>
          </span>
        ) : null}
        {body.why ? <span>Why: {body.why}</span> : null}
        {fold ? <span>The first {fold} characters show before “more” on a phone.</span> : null}
      </div>
    </>
  );
}

/** An X thread (P6 W4): one numbered post per row, each with its own length; X shows them in this order. */
function ThreadPosts({ posts, limit, why }: { posts: string[]; limit: number; why: string | null }) {
  return (
    <>
      <ol className="v2-card-thread" aria-label={`Thread of ${posts.length} posts`} data-testid="thread-posts">
        {posts.map((post, i) => {
          const length = charCount(post);
          return (
            <li key={i}>
              <span className="v2-card-thread-n" aria-hidden="true">
                {i + 1}
              </span>
              <p className="v2-card-text">{post}</p>
              <span className={`v2-chip ${length > limit ? "is-stuck" : "is-posted"}`}>
                {length}/{limit}
              </span>
            </li>
          );
        })}
      </ol>
      <div className="v2-card-meta">
        <span>{posts.length} posts, posted as one thread on X.</span>
        {why ? <span>Why: {why}</span> : null}
      </div>
    </>
  );
}

/** The post as the platform shows it: what is past the "more" cut is set apart, so the hook is judged on its own. */
function FoldedText({ text, fold }: { text: string; fold: number | null }) {
  const chars = Array.from(text);
  if (!fold || chars.length <= fold) return <p className="v2-card-text">{text}</p>;
  // The platform cuts before the word that crosses the limit.
  const space = chars.slice(0, fold + 1).findLastIndex((c) => /\s/.test(c));
  const cut = space > fold / 2 ? space : fold;
  return (
    <p className="v2-card-text">
      {chars.slice(0, cut).join("")}
      <span className="v2-card-fold">
        <span aria-hidden="true">…more</span>
        <span className="v2-visually-hidden"> (on a phone the post is cut here behind “more”) </span>
      </span>
      <span className="v2-card-after-fold">{chars.slice(cut).join("")}</span>
    </p>
  );
}

export function ReplyBody({ body }: { body: Body<"reply"> }) {
  return (
    <>
      <p className="v2-card-strong">
        {body.community} · “{body.threadTitle}”
      </p>
      {body.quotes.map((quote) => (
        <blockquote key={quote.text} className="v2-card-quote">
          “{quote.text}” <span className="v2-muted">({quote.from})</span>
        </blockquote>
      ))}
      {body.parts.length > 0 ? (
        <dl className="v2-card-scores" style={{ gridTemplateColumns: `repeat(${Math.min(4, body.parts.length)}, minmax(0, 1fr))` }}>
          {body.parts.map((part) => (
            <div key={part.label}>
              <dt>{part.label}</dt>
              <dd className="v2-num">
                {part.score}/{part.max}
              </dd>
            </div>
          ))}
        </dl>
      ) : null}
      {body.rule?.kind === "help_only" ? (
        // Why the draft never names the product: the subreddit's rule, or the 1-in-10 mention limit.
        <p className="v2-card-state is-help_only" data-testid="reply-help-only">
          <b>Help only</b>
          <span>{body.rule.text}</span>
        </p>
      ) : null}
      <div className="v2-card-draft">{body.draft}</div>
      <div className="v2-card-meta">Rules: {body.rules}</div>
    </>
  );
}

export function GoalBody({ body }: { body: Body<"goal"> }) {
  return (
    <>
      <p className="v2-card-goal">{body.goal}</p>
      {body.plan.length > 0 ? (
        <ul className="v2-card-plan">
          {body.plan.map((line) => (
            <li key={line.what}>
              <span>{line.what}</span>
              <span className="v2-muted">{DEPARTMENT_LABEL[line.department]}</span>
            </li>
          ))}
        </ul>
      ) : null}
      <div className="v2-card-meta">
        <span>
          Target: {body.target} {body.metric}
        </span>
        {body.budgetCredits !== null ? <span>Budget {body.budgetCredits} credits</span> : null}
      </div>
    </>
  );
}

export function ScriptBody({
  body,
  cardId,
  editing,
  beat,
  draft,
  onDraft,
  onBeat,
}: {
  body: Body<"script">;
  cardId: string;
  editing: boolean;
  /** The beat being edited (index into `body.beats`). */
  beat: number;
  draft: string;
  onDraft: (text: string) => void;
  onBeat: (index: number) => void;
}) {
  return (
    <>
      <ol className="v2-card-beats">
        {body.beats.map((line, index) => (
          <li key={index} data-editing={editing && index === beat ? "" : undefined}>
            <b className="v2-card-beat-n">{String(index + 1).padStart(2, "0")}</b>
            <span>
              <b>“{editing && index === beat ? draft : line.words}”</b> {line.picture}
              {line.motion ? <span className="v2-muted"> Motion: {line.motion}</span> : null}
            </span>
          </li>
        ))}
      </ol>
      {editing ? (
        <div className="v2-card-beat-edit">
          <div className="v2-field">
            <label htmlFor={`${cardId}-beat`}>Beat</label>
            <select id={`${cardId}-beat`} className="v2-input is-compact" value={beat} onChange={(event) => onBeat(Number(event.target.value))}>
              {body.beats.map((_, index) => (
                <option key={index} value={index}>
                  {String(index + 1).padStart(2, "0")}
                </option>
              ))}
            </select>
          </div>
          <div className="v2-field">
            <label htmlFor={`${cardId}-words`}>What is said in this beat</label>
            <input id={`${cardId}-words`} className="v2-input" value={draft} maxLength={300} onChange={(event) => onDraft(event.target.value)} />
          </div>
        </div>
      ) : null}
      <div className="v2-card-meta">
        {body.seconds ? <span>{formatSeconds(body.seconds)}</span> : null}
        {body.aspect ? <span>{body.aspect}</span> : null}
        {body.nextPriceCredits !== null ? <span>Keyframes next: {body.nextPriceCredits} credits</span> : null}
      </div>
    </>
  );
}

export function PriceBody({ body, price }: { body: Body<"price">; price: number | null }) {
  return (
    <>
      {body.keyframes.length > 0 ? (
        <ol className="v2-card-sheet" aria-label="Contact sheet">
          {body.keyframes.map((frame) => (
            <li key={frame.index}>
              {frame.thumbUrl ? <img src={frame.thumbUrl} alt="" loading="lazy" /> : <span className="v2-card-sheet-empty" aria-hidden="true" />}
              <span className="v2-card-sheet-label">
                <b className="v2-card-beat-n">{String(frame.index + 1).padStart(2, "0")}</b> {frame.label}
              </span>
              {frame.garbled ? <span className="v2-chip is-stuck">Text may be garbled</span> : null}
            </li>
          ))}
        </ol>
      ) : (
        <div className="v2-card-frames" aria-hidden="true">
          {Array.from({ length: Math.min(8, Math.max(1, body.shots)) }, (_, index) => (
            <span key={index} className={index % 3 === 0 ? "is-light" : undefined} />
          ))}
        </div>
      )}
      <div className="v2-card-price">
        <span className="v2-muted">
          {formatSeconds(body.seconds)}
          {body.readyInMinutes ? ` · ready in about ${body.readyInMinutes} min` : null}
        </span>
        <b className="v2-num">{price === null ? "–" : `${price} cr`}</b>
      </div>
    </>
  );
}

/** `editable`: null when captions may be edited now, else why not. */
type CaptionProps = { cardId: string; editable: string | null; onSaveCaption: SaveCaption };

export function FinishedVideoBody({ body, cardId, editable, onSaveCaption }: { body: Body<"finished_video"> } & CaptionProps) {
  return (
    <>
      <div className="v2-card-player">
        {body.previewUrl ? (
          // No poster image exists: the fragment seeks the render to the still the brain picked.
          <video src={`${body.previewUrl}#t=${body.frameAt}`} controls preload="metadata" playsInline />
        ) : (
          <span className="v2-card-play" aria-hidden="true">
            <svg width="20" height="20" viewBox="0 0 24 24">
              <path d="M8 5l11 7-11 7z" fill="currentColor" />
            </svg>
          </span>
        )}
      </div>
      <div className="v2-card-meta">Approving marks it finished: Shorts can be cut from it</div>
      <CaptionList captions={body.captions} idBase={`${cardId}-captions`} heading="Captions and YouTube text" editable={editable} onSave={onSaveCaption} />
    </>
  );
}

export function ShortsBody({ body, cardId, editable, onSaveCaption }: { body: Body<"shorts_batch"> } & CaptionProps) {
  return (
    <>
      <ul className="v2-card-shorts">
        {body.shorts.map((short) => (
          <li key={`${short.start}-${short.end}`}>
            {short.previewUrl ? <video className="v2-card-poster" src={short.previewUrl} controls preload="metadata" playsInline /> : <span className="v2-card-poster" aria-hidden="true" />}
            <span>
              <b>
                {formatSeconds(short.start)}–{formatSeconds(short.end)}
              </b>
              <br />
              <span className="v2-muted">Hook: “{short.hook}”</span>
              <br />
              <span>{short.reason}</span>
            </span>
          </li>
        ))}
      </ul>
      {body.shorts.map((short, index) => (
        <CaptionList
          key={`${short.start}-${short.end}`}
          captions={short.captions}
          idBase={`${cardId}-short-${index + 1}`}
          heading={`Captions for short ${index + 1} · “${short.hook}”`}
          editable={editable}
          onSave={onSaveCaption}
        />
      ))}
    </>
  );
}

/** Saves one slide's words; resolves false when the save was refused (the reason is toasted). */
export type SaveSlide = (index: number, heading: string, body: string) => Promise<boolean>;

/**
 * Slideshow: every slide as rendered (its PNG, or its words until the stills exist), the MP4, the PNG set, and a quick
 * text edit per slide. `edited`: a slide's words were saved since the card was made, so the renders above are older.
 */
export function SlideshowBody({
  body,
  cardId,
  editable,
  edited,
  onSaveSlide,
  onSaveCaption,
}: {
  body: Body<"slideshow">;
  cardId: string;
  /** null when the words may be changed now, else why not. */
  editable: string | null;
  edited: boolean;
  onSaveSlide: SaveSlide;
  onSaveCaption: SaveCaption;
}) {
  const [picked, setPicked] = useState<number | null>(null);
  const [heading, setHeading] = useState("");
  const [words, setWords] = useState("");
  const [saving, setSaving] = useState(false);
  const total = body.slides.reduce((sum, slide) => sum + slide.seconds, 0);
  const problem = picked === null ? null : slideTextProblem(heading, words);
  const unchanged = picked !== null && joinSlideText(heading, words) === body.slides[picked]?.text;

  function pick(index: number) {
    const parts = splitSlideText(body.slides[index]?.text ?? "");
    setPicked(index);
    setHeading(parts.heading);
    setWords(parts.body);
  }

  return (
    <>
      <ol className="v2-card-slides is-strip" aria-label={`${body.slides.length} slides`} data-aspect={body.aspect ?? undefined}>
        {body.slides.map((slide, index) => (
          <li key={index} className={index === 0 ? "is-cover" : undefined} aria-current={picked === index || undefined}>
            <button
              type="button"
              className="v2-card-slide"
              aria-label={`Slide ${index + 1}, ${formatSeconds(slide.seconds)}: ${slide.text}. Edit its text`}
              disabled={!!editable}
              title={editable ?? undefined}
              onClick={() => pick(index)}
            >
              {slide.stillUrl ? <img src={slide.stillUrl} alt="" loading="lazy" /> : <span>{slide.text}</span>}
              <span className="v2-card-slide-n" aria-hidden="true">
                {index + 1} · {formatSeconds(slide.seconds)}
              </span>
            </button>
          </li>
        ))}
      </ol>
      {body.previewUrl ? (
        <div className={`v2-card-player${body.aspect === "9:16" ? " is-tall" : ""}`}>
          <video src={body.previewUrl} controls preload="metadata" playsInline aria-label="Slideshow MP4 preview" />
        </div>
      ) : null}
      <div className="v2-card-meta">
        {/* The head already names the slide count and the formats. */}
        {formatSeconds(total)} in all
        {body.pngSetUrl ? (
          <>
            {" · "}
            <a href={body.pngSetUrl} download data-testid="slideshow-png-set">
              Download PNG set
            </a>
          </>
        ) : null}
      </div>
      {edited ? (
        <p className="v2-card-state is-expired" data-testid="slideshow-edited">
          <b>Rendering again</b>
          <span>The MP4 and PNGs above show the old words. A new card with your changes replaces this one when it is ready.</span>
        </p>
      ) : null}
      {body.captions?.length ? (
        <CaptionList captions={body.captions} idBase={`${cardId}-captions`} heading="Captions" editable={editable} onSave={onSaveCaption} />
      ) : null}
      {picked !== null ? (
        <form
          className="v2-card-decline"
          onSubmit={(event) => {
            event.preventDefault();
            if (problem || unchanged || saving) return;
            setSaving(true);
            void onSaveSlide(picked, heading, words).then((ok) => {
              setSaving(false);
              if (ok) setPicked(null);
            });
          }}
        >
          <label className="v2-field" htmlFor={`${cardId}-slide-heading`}>
            Slide {picked + 1} heading
            <input id={`${cardId}-slide-heading`} className="v2-input is-compact" value={heading} maxLength={200} autoFocus onChange={(event) => setHeading(event.target.value)} />
          </label>
          <label className="v2-field" htmlFor={`${cardId}-slide-body`}>
            Slide {picked + 1} text under it (optional)
            <textarea id={`${cardId}-slide-body`} className="v2-input" rows={2} value={words} maxLength={600} onChange={(event) => setWords(event.target.value)} />
          </label>
          {problem ? <p className="v2-card-meta" role="status">{problem}</p> : null}
          <div className="v2-actions">
            <Button type="submit" variant="primary" compact disabled={!!problem || unchanged || saving}>
              Save slide {picked + 1}
            </Button>
            <Button variant="quiet" compact onClick={() => setPicked(null)}>
              Keep it
            </Button>
          </div>
        </form>
      ) : null}
    </>
  );
}

/**
 * Schedule: what goes out, where and when (in the founder's zone), and the platform's own fields. Changing a field
 * here is a draft: saving it raises a new card, because what was approved must be exactly what posts.
 */
export function ScheduleBody({
  body,
  cardId,
  options,
  onOptions,
  editable,
}: {
  body: Body<"schedule">;
  cardId: string;
  options: ScheduleOptions;
  onOptions: (options: ScheduleOptions) => void;
  /** Null when the fields may be changed now, else why not. */
  editable: string | null;
}) {
  const platform = PLATFORM_LABEL[body.where.platform];
  const tiktok = body.mode === "publish" && body.where.platform === "tiktok" ? body.tiktok : null;
  const aiLabel = body.mode === "publish" && AI_LABEL_PLATFORMS.has(body.where.platform);
  const set = (patch: Partial<ScheduleOptions>) => onOptions({ ...options, ...patch });
  const off = (account: boolean) => (account ? "Turned off for this account in TikTok." : (editable ?? undefined));

  return (
    <>
      <p className="v2-card-strong">{body.what}</p>
      {body.preview.videoUrl ? (
        <div className="v2-card-player is-tall">
          <video src={body.preview.videoUrl} controls preload="metadata" playsInline />
        </div>
      ) : null}
      {body.preview.title || body.preview.text ? (
        <div className="v2-card-draft">
          {body.preview.title ? <b>{body.preview.title}</b> : null}
          {body.preview.title && body.preview.text ? <br /> : null}
          {body.preview.text}
        </div>
      ) : null}
      <dl className="v2-card-facts">
        <div>
          <dt>Where</dt>
          <dd className="v2-card-account">
            {body.mode === "publish" ? (
              <>
                {body.avatarUrl ? <img src={body.avatarUrl} alt="" width={20} height={20} /> : null}
                <span>
                  {platform} · {body.where.handle}
                </span>
              </>
            ) : (
              <span>{platform} · no account connected</span>
            )}
          </dd>
        </div>
        <div>
          <dt>When (your time, {body.timezone})</dt>
          <dd className="v2-num">{formatWhen(body.at, body.timezone)}</dd>
        </div>
      </dl>

      {tiktok ? (
        <fieldset className="v2-card-options">
          <legend>TikTok</legend>
          <label className="v2-field" htmlFor={`${cardId}-privacy`}>
            Who can see it
            <select
              id={`${cardId}-privacy`}
              className="v2-input is-compact"
              value={options.privacy ?? ""}
              disabled={!!editable}
              title={editable ?? undefined}
              onChange={(event) => set({ privacy: event.target.value || undefined })}
            >
              <option value="">Choose who can see it</option>
              {tiktok.privacyLevels.map((level) => (
                <option key={level} value={level}>
                  {PRIVACY_LABEL[level] ?? level}
                </option>
              ))}
            </select>
          </label>
          <div className="v2-card-toggles">
            <Toggle checked={!tiktok.commentDisabled && !!options.allow_comment} disabled={tiktok.commentDisabled || !!editable} title={off(tiktok.commentDisabled)} onChange={(on) => set({ allow_comment: on })}>
              Comments
            </Toggle>
            <Toggle checked={!tiktok.duetDisabled && !!options.allow_duet} disabled={tiktok.duetDisabled || !!editable} title={off(tiktok.duetDisabled)} onChange={(on) => set({ allow_duet: on })}>
              Duet
            </Toggle>
            <Toggle checked={!tiktok.stitchDisabled && !!options.allow_stitch} disabled={tiktok.stitchDisabled || !!editable} title={off(tiktok.stitchDisabled)} onChange={(on) => set({ allow_stitch: on })}>
              Stitch
            </Toggle>
          </div>
          <div className="v2-card-option">
            <Toggle checked={!!options.brand_organic} disabled={!!editable} title={editable ?? undefined} onChange={(on) => set({ brand_organic: on })}>
              Your brand
            </Toggle>
            <span className="v2-field-hint">Turn it on when the post promotes your own product or business. TikTok labels it “Promotional content”.</span>
          </div>
          <div className="v2-card-option">
            <Toggle checked={!!options.brand_content} disabled={!!editable} title={editable ?? undefined} onChange={(on) => set({ brand_content: on })}>
              Branded content
            </Toggle>
            <span className="v2-field-hint">Turn it on when someone paid you or gave you something for it. TikTok labels it “Paid partnership”.</span>
          </div>
        </fieldset>
      ) : null}
      {aiLabel ? (
        <div className="v2-card-option">
          <Toggle checked={!!options.ai_label} disabled={!!editable} title={editable ?? undefined} onChange={(on) => set({ ai_label: on })}>
            AI-generated label
          </Toggle>
          <span className="v2-field-hint">Turn it on when the picture was made with AI. {platform} shows the label on the post.</span>
        </div>
      ) : null}

      <div className="v2-card-meta">
        {body.why ? <span>Why this time: {body.why}</span> : null}
        {body.mode === "publish" ? (
          <span>You approve when it posts: it goes out on your {platform} account at this time, as shown here.</span>
        ) : (
          <span>
            {body.state === "no_account" ? "No account connected: copy and open. Post it from your account, then tell us here." : "No account connected: at this time a card gives you the post to copy and open."}{" "}
            <Link href="/app/settings#settings-connected-accounts">Connect {platform}</Link> to have it posted.
          </span>
        )}
        {tiktok ? (
          <span>
            By posting, you agree to TikTok’s{" "}
            <a href={TIKTOK_MUSIC_TERMS} target="_blank" rel="noopener noreferrer">
              Music Usage Confirmation
            </a>
            .
          </span>
        ) : null}
      </div>
    </>
  );
}

/** What the founder kept doing, per edit mode (`cmo_draft_outcomes.edit_mode`). */
const EDIT_SEEN: Record<string, string> = {
  TOO_SALESY: "You toned down the selling",
  WRONG_VOICE: "You rewrote drafts in your own words",
  INVENTED_CLAIM: "You removed a claim that was not true",
  TOO_LONG: "You cut drafts shorter",
  HOOK_REWRITTEN: "You rewrote the first line",
  CTA_REMOVED: "You cut the closing ask",
  FULL_REWRITE: "You rewrote most of the draft",
};

export function CorrectionBody({
  body,
  editing,
  draft,
  onDraft,
}: {
  body: Body<"correction">;
  editing: boolean;
  draft: string;
  onDraft: (text: string) => void;
}) {
  return (
    <>
      {editing ? (
        <label className="v2-field">
          <span>The rule, in your words (3 to 200 characters)</span>
          <input className="v2-input" value={draft} minLength={3} maxLength={200} onChange={(event) => onDraft(event.target.value)} />
        </label>
      ) : (
        <p className="v2-card-rule">“{body.rule}”</p>
      )}
      {body.editMode && EDIT_SEEN[body.editMode] ? (
        <p className="v2-card-meta">
          {EDIT_SEEN[body.editMode]} in {body.times} {body.times === 1 ? "post" : "posts"} these two weeks.
        </p>
      ) : null}
      {body.examples.length > 0 ? (
        <ul className="v2-card-edits" aria-label="Your edits">
          {body.examples.map((edit, index) => (
            <li key={index}>
              <span className="v2-card-edit-label">Draft</span>
              <s className="v2-muted">{edit.before}</s>
              <span className="v2-card-edit-label">You wrote</span>
              <span>{edit.after}</span>
            </li>
          ))}
        </ul>
      ) : null}
    </>
  );
}
