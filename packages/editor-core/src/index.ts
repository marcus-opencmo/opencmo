/**
 * Lõi sửa project của OpenCMO trên document JSON (`@opencmo/clip-doc`): không
 * DOM, không runtime — chạy được trong editor lẫn trên server. Thứ chỉ cần toán
 * transcript thì import `@opencmo/editor-core/transcript`.
 */

export * from './transcript';
export * from './captions';
export * from './reframe';
export * from './summary';
export { subtitleCues, toSrt, toVtt, type Cue } from './subtitles';
export { detectBeats, type BeatGrid } from './beats';
export { DELTA_LIMIT, diffDocuments, emptyDelta, type DocumentDelta } from './delta';
export { fold, searchSpoken, type SpokenHit } from './search';
export * from './ops';
export { belowText, isRow, LANE_NAME, laneOf, type Lane } from './tracks';
export * from './brand';
export { MASTER_SRC, stamp, byId, walk, activeView, timelineLabel, timelinesOf, type Entity } from './doc';
export { checkDocument, type CheckIssue, type CheckMedia, type CheckReport } from './check';
export { findSilences, type Silence } from './silences';
export { BUILTIN_LOTTIES, findLotties, LOTTIE_PACK, type LottieEntry } from './visuals/lottie';
export { EMOJI_PACK, type EmojiEntry } from './visuals/emoji';
export { LAYOUT_MODES, panelRegionAt, readLayout, speakerBandAt, type LayoutMode, type LayoutRange } from './layout';
export { anchorPoint, LAYOUT_ANCHOR_NAMES, LAYOUT_LABEL, layoutSlots, layoutsFor, slotBox, VIDEO_LAYOUTS, type LayoutSlot, type VideoLayout } from './layouts';
export { clipScript, clipTranscript, clipWords, findQuote, formatScript, quoteTiming, type QuoteHit, type ScriptLine } from './script';
export { quoteRange } from './ops/visuals';
