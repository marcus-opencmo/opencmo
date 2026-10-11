/**
 * Guide cho agent (spec agent-editor §4, AE4): thứ DS đưa qua `docs/skills` +
 * `reference/`, ở đây viết mới cho document của OpenCMO. Tool `read_guide` trả
 * nguyên văn; không nằm trong system prompt để prompt ngắn và cache ổn định.
 *
 * Tiếng Anh vì model đọc. Guide `document` sinh từ chính schema zod của
 * `@opencmo/clip-doc` — tên prop không thể lệch với thứ validate chấp nhận.
 */

import {
  ANIMATION_TYPES,
  BLEND_MODES,
  CAPTION_PRESETS,
  EFFECT_TYPES,
  NAMED_EASINGS,
  NODE_SHAPES,
  TRACK_PROPERTIES,
  TRANSITION_TYPES,
} from "@opencmo/clip-doc";
import { FONTS } from "@opencmo/editor-core";

/** Prop editor ghi cho chính nó — agent không cần biết. */
const HIDDEN = new Set(["selected", "expanded", "clipHeight", "timeline", "playhead", "marks", "kind", "syncTo"]);

function documentGuide(): string {
  const kinds = Object.entries(NODE_SHAPES)
    .map(([kind, shape]) => `- ${kind}: ${Object.keys(shape.shape).filter((key) => !HIDDEN.has(key)).join(", ")}`)
    .join("\n");
  return `# Project document reference

The clip is a tree: stage > scene(s) > elements. Each element has a stable "id" (read them with get_document). Later children draw on top of earlier ones.

## Coordinates and time
- Units are pixels of the scene (a vertical clip is 1080 wide x 1920 tall). x/y is the TOP-LEFT of the element in its parent's space; width/height its size. rotation is degrees; scale/scaleX/scaleY multiply around the element's center; offsetX/offsetY shift after layout.
- Times are SECONDS. start/end place an element on its parent's timeline. For video/audio, sourceIn/sourceOut pick the part of the file that plays. An element without end lasts as long as its media (or 16s for shapes/text without end — always give text an end).
- Keyframe times (set_keyframe) are in the element's OWN seconds: 0 is the moment the element starts.
- A "sequence" plays its children one after another; a "group" moves children together.

## Element kinds and their properties
${kinds}

## Sub-parts (add_part key -> part fields)
- paints: {type: "solid", color} | {type: "linearGradient"|"radialGradient", rotation?, stops: [{offset 0..1, color}]} | {type: "image"|"video", src, objectFit?: cover|contain|fill}
- strokes: {color, width?, join?: miter|round|bevel, opacity?}
- shadows: {color, blur?, offsetX?, offsetY?, opacity?}
- effects: {type, value} with type one of ${EFFECT_TYPES.join(", ")} (blur in px; brightness/contrast/saturate 0-1 only lower; color grading: exposure in stops -2..2 (0.3 = a bit brighter), vibrance -1..1 (more or less color), temperature -1 cool..1 warm, tint -1 green..1 magenta, vignette 0..1; small values look natural, e.g. exposure 0.3, temperature 0.15). Curves, wheels, hue curves, chroma key, glow, grain and vignette shape take a params object — set them with apply_color (read_guide "color"), not by hand
- animations: {type, phase?: "in"|"out", duration?, delay?} with type one of ${ANIMATION_TYPES.join(", ")}. appearWord/appearChar/scramble/typewriter/wordSlide/highlightPop are for text (and captions). typewriter types the text with a caret; wordSlide slides the words up one after another; highlightPop pops each word in turn in a highlight color ({perWord: seconds per word, default 0.2; color}); without duration they last words × perWord. "in" plays from the element's start, "out" ends at its end.
- ranges (text only): {start, end?, color?, fontWeight?, ...} character indexes into the text, for highlighting words.
- masks: rect nodes; the element shows only inside them.

## Values
- Colors: hex like #FFD400 (8 digits for alpha).
- Animatable properties (set_keyframe): ${TRACK_PROPERTIES.join(", ")}.
- Easings: ${NAMED_EASINGS.join(", ")}, cubicBezier(x1, y1, x2, y2), spring(stiffness, damping), steps(n).
- Transitions (set_props {transition: {type, duration}} on the LEFT clip of a sequence): ${TRANSITION_TYPES.join(", ")}.
- Blend modes: ${BLEND_MODES.join(", ")}.
- Caption presets: ${CAPTION_PRESETS.join(", ")}. Captions also take colors (up to 3 hex), verticalAlign top|center|bottom, offsetY, and fontScale (0.25–3, 1 = preset size) to make the text bigger or smaller. Captions have no width or scale: resize them with fontScale only. Lines wider than the frame wrap automatically.
- Fonts: ${FONTS.join(", ")}. fontWeight 100-900; textCase original|upper|lower; textAlign left|center|right. textAlign only works when the text has BOTH width and height; without them the box shrinks to the text and it starts at x. To center text on a card, give the text the card's x, y, width and height.
- Text style (set_props on text): background {color, paddingX?, paddingY?, radius?, outlineColor?, outlineWidth?, perLine?} draws a box behind the text (perLine: one box per line); decoration ["underline"|"overline"|"strike"]; fill "footage" makes the text a window onto the layers below (the rest of the frame takes the text color) and "inverted" draws it with a difference blend; tiltX/tiltY (-89..89 degrees) lean the text in fake perspective. Flip any element with a negative scaleX/scaleY.
- Elements have no perspective or rotateY: fake a card flip with scaleX keyframes and depth with shadows. For real 3D (objects, depth, a camera move) write a 3D animation (read_guide "3d"); generate_media is only for concrete real-world footage.
- volume is dB (0 = as recorded, -60 near silent); muted: true silences.
`;
}

const GUIDES = {
  workflow: `# How to edit a clip

1. Understand the request. If it is ambiguous or would remove a lot of the clip, ask_user once. Otherwise decide.
2. Look before you touch: get_project_state, then get_transcript for anything about words or pacing, list_library for media, capture a contact sheet (count 6-8) to see what the viewer sees.
3. For anything with more than two steps, write the plan with update_plan and keep it current.
4. Work in this order, because later steps depend on earlier ones:
   a. Story and pacing: cut words, filler and pauses (remove_words, remove_ranges). Cutting changes every later time, so cut FIRST.
   b. Frame: set_frame if the shape changes.
   c. Layers: B-roll (insert_asset), titles and hooks (add_text / insert_node), shapes.
      insert_asset puts B-roll and audio on a shared row ("B-roll 1", "Audio 1") when the time is free. To tidy layers of the same kind onto one row, move_to_row (clips of another kind are refused).
   d. Motion: keyframes (zoom-ins, pans), animations, transitions.
   e. Captions last: style and colors (set_caption_style), then fix misheard words.
5. Verify: run check and fix every error; then capture frames at the moments you changed (and one before/after) and look at them. Is the speaker in frame? Is every text readable, inside the frame, not covering faces or the captions? Does B-roll start and end where the words say?
6. Finish with one to three sentences about what changed. Never claim something you did not check.

Times after cuts: get_transcript and find_silences use SOURCE seconds; everything on the timeline (add_text, insert_asset, capture, keyframes) uses CLIP seconds after cuts. get_project_state shows the kept duration; the captions line up with the clip timeline.`,

  pacing: `# Pacing: filler, pauses, dead air

- Short-form viewers leave in the first seconds. The first sentence should start within 0.3s of the clip start.
- find_filler_words gives candidates: um, uh, repeated words. Remove only true fillers; "like" and "so" are often meaningful — read the line.
- find_silences lists pauses between words with a suggested cut that leaves a natural 0.2s gap. Remove pauses longer than about 0.6s in talking-head clips; keep pauses that are dramatic (after a question, before a punchline).
- media_waveform finds silences the transcript cannot see (breaths, room noise, music). For music with a steady beat it also returns bpm and beats (source seconds): cut and time visuals on beats; the timeline snaps to them too.
- Do not cut more than about a fifth of the clip without asking.
- After cutting, the clip is shorter: re-read get_project_state before placing anything in time.`,

  hooks: `# Hooks and titles

- A hook is a short title on screen during the first 2-3 seconds that makes someone stay: a promise, a number, a question. 3-8 words. Use the speaker's own strongest phrase when possible.
- Place it in the upper third (y about 0.15-0.25 with add_text) so it does not cover the face or the captions (captions sit low by default).
- Make it readable on a phone: fontSize 70-100 on a 1080-wide frame, weight 800, white or a brand color, with a stroke (add_part strokes {color: "#000000", width: 8}) or a shadow for contrast over video.
- Give it motion: an "in" animation (fade, slideUp, grow, appearWord) of 0.3-0.5s, and an "out" fade before it ends.
- Always capture a frame at 1s to confirm it reads well.`,

  captions: `# Captions

- Presets: classic (one word highlighted at a time, clean), spotlight (bold, colored active word), stark (white boxed), cascade, whisper, paper, guinea. For talking heads on TikTok/Reels, spotlight or classic read best.
- set_caption_style {preset, colors, color?, font?, weight?}: applies to EVERY caption layer of the clip (video and voiceover captions share one style). colors are up to 3 hex values; the preset decides what each color does (usually highlight). color = the main text color, font = one of the editor fonts, weight 100-900; null resets to the preset, leaving a field out keeps it.
- Captions for OTHER media (B-roll, an uploaded talk, a song): add_captions {element_id} transcribes what that element plays (1 credit/min, user approves). translate_captions {element_id, language} adds a translated copy as a new layer (1 credit/min).
- highlight: "block" (box behind the spoken word) or "pop" (the spoken word grows and turns yellow) with set_props on the captions element; censor: true masks swear words on screen (the transcript keeps them).
- Fix misheard words with edit_words; split long lines with split_line and join short ones with merge_lines.
- Keep captions off faces: they sit at the bottom by default; move them with set_props on the captions element (verticalAlign, offsetY).
- Titles must not overlap the captions: check reports caption-overlap.
- A captions layer on the timeline is not proof the captions show on the video. Before telling the user the clip has captions, run check: captions-empty means the layer shows no words (its transcript could not be loaded, or its sourceIn/sourceOut miss every word), captions-covered means another layer is drawn over them. Tell the user exactly that; never say captions are on screen when check reports either.`,

  script: `# From the script to visuals

<clip_context> holds the clip's script in CLIP seconds. Work from it, not from guesses about the topic.

1. Read the whole script once. Say to yourself in one sentence what the clip argues; every visual must serve that.
2. Mark the beats a picture makes faster: a list of steps, a before/after or A vs B, a number, a trend, a cause and effect, a metaphor ("it compounds", "a snowball"). Skip lines that are just the speaker's opinion or a joke: the face does that best.
3. For each beat pick ONE tool (see the system prompt): drawn visuals for anything abstract or numeric; a 3D animation for "3D", a hero moment or a physical metaphor; generate_media only for a concrete scene and only when the user wants AI media.
4. Labels, numbers and steps come from the words of the script, shortened to 1-4 words. Never add a statistic the speaker did not say.
5. Timing: pass quote with the exact words (a few are enough); leave start/end out and the tool times it to the line. Give start/end only to stretch or shorten it.
6. Leave the first line (the hook) on the face. At most one visual on screen; 2-6 seconds each; at least one second of face between visuals.
7. Write the beats to update_plan before you add them: "[12.4s] 'better hooks' → diagram: hook, value, call to action".

AI images and video (generate_media): fill the brief from the script. quote = the line it illustrates; idea = what the viewer should understand; subject/action/setting = a concrete scene that shows that idea without any words in the picture. Pick one style and keep it for every shot in the clip.`,

  broll: `# B-roll

- B-roll covers the speaker with footage that shows what they talk about. Place it where the words mention the thing: insert_asset {path, quote} with the words from <clip_context> starts it on those words (1.5-4 s); give start/end in clip seconds only to adjust.
- 1.5-4 seconds per shot. Never cover the first sentence (the viewer needs the face to trust the speaker) or the last line.
- insert_asset {path, start, end, fit: "cover"} fills the frame. Use media_grab first to see what the file shows and pick sourceIn if the good part is later in the file (set_props {sourceIn}).
- Mute B-roll sound unless it matters (volume -60 or muted).
- A dissolve or a quick scale keyframe (1.0 -> 1.08) makes cuts feel smoother.
- Capture a frame in the middle of each B-roll shot to confirm.

## AI B-roll (when the user asks to generate B-roll and generate_media is available)

1. Read <clip_context>. Pick 3-5 lines that name something concrete a picture can show (a place, an object, an action). Skip the hook, the last line and opinions. Write them to update_plan: "[12.4s] 'my first store' → a small shop front at dawn".
2. Stills first: call generate_media kind "image" for EVERY shot in the same step (one call per shot, all in one message), so the user approves them on one card with the total price. Same style for every shot; aspect_ratio of the clip frame. length 2-3, so each still already works as a short cutaway.
3. When they are approved, list_library until the images are no longer "still generating", capture a frame on each, then ask_user which ones to animate (options: "Animate all", "Keep as stills", or each shot by name). Animation costs much more than a still: say so in the question.
4. Animate the chosen ones: generate_media kind "video" with start_image = that still's library path, the same brief and quote, the shortest duration, length 1.5-4 and muted true — again all in one message, one card. Then delete the still it replaces (delete_element) so the two do not stack.
5. Capture a frame in the middle of each shot; nothing covers the first or last line.

Background music or a sound effect (generate_media kind "audio"): only when the user asks. Music is instrumental only; describe mood, genre and tempo, never an artist or a song. For a bed under the whole clip use the clip length as duration (up to the model's limit), start 0, then set_props volume -18 on it so the speech stays clear.

Same product or character in every shot: when the user has an image of it in the library (an upload or a finished AI image), pass it as references to every image call on a model that lists reference images, and name it in the brief ("the mug from image 1"). Only images the user owns or made: never a real person's face or someone else's logo.

## AI transition (a generated move that bridges a cut)

Use it when the user asks for a smooth/creative transition at a hard cut (a jump cut, or between two B-roll shots), and only with a video model that takes a first AND a last frame.
1. Find the cut at clip second T (capture around it to be sure).
2. save_frame at T - 0.05 (name "before-cut") and at T + 0.05 ("after-cut").
3. generate_media kind "video": start_image = the "before" path, end_image = the "after" path, the shortest duration, start = T - 0.6, length 1.2, fit true (the whole move plays inside 1.2 s and lands on the second picture), muted true. Brief: quote = the words spoken at T, idea "one continuous camera move from the first picture into the second", subject = what both pictures show.
4. After it is placed, capture at T - 0.5, T and T + 0.5: the move covers the cut and ends on the next shot.`,

  jlcut: `# J-cut and L-cut

A straight cut changes picture and sound on the same frame; at a jump between two takes that can feel abrupt. Shift the sound instead:
- L-cut (set_audio_roll seconds > 0): the end of a sentence keeps playing over the start of the next shot. Use it when a thought finishes after the visual change, or to carry a laugh/pause over a cut.
- J-cut (seconds < 0): the next sentence starts under the end of the previous shot, then the picture follows. Use it to lead into a new point or a reaction.
- 0.3-0.8 s is natural; more than 1.5 s sounds like a mistake. Use it on a few key cuts, not every cut.
- get_project_state lists cut_points with the roll each already has. Capture a frame on each side of the cut and listen (media_waveform) to check the overlap does not land in the middle of a word.`,

  color: `# Color grading

Use apply_color (one call can set many adjustments on many elements) and check with inspect_color, which measures the frame as exported.
- Order of work, like a colorist: fix exposure and white balance first (inspect_color: black point near 0.02-0.06, white point 0.9-0.98, average RGB close together on neutral scenes), then contrast/curves, then the look (wheels, saturation, hue curves), then texture (sharpen, grain, glow, vignette).
- Correction: exposure ±0.1-0.5 stops; temperature/tint ±0.05-0.2 against a cast; highlights −0.2..−0.5 to recover a bright sky or window; shadows +0.2..+0.4 to open a dark face.
- Looks: warm cinematic = gain [0.06, 0.02, -0.04], lift [-0.02, 0, 0.03] (teal shadows, warm highlights), contrast 0.2, saturation −0.1, grain 0.15, vignette {amount: 0.3}. Clean commercial = shadows 0.15, vibrance 0.2, clarity 0.15, sharpen 0.2. Vintage = blacks 0.15 (faded), saturation −0.25, temperature 0.15, grain 0.35.
- Hue curves pick colors by hue (0 red, 0.08 orange, 0.16 yellow, 0.33 green, 0.5 cyan, 0.66 blue, 0.83 magenta): e.g. sat [[0.33, -0.6]] mutes greens; keep skin (≈0.05-0.1) untouched.
- Chroma key: color = the screen's color (pick it from a capture), range 0.3-0.5, spill 0.5; put the replacement background element BELOW the keyed video.
- A LUT: when the library has a .cube file (list_library, type LUT) and the user wants that look, apply_color lut {path, strength 0.6-1}; adjust exposure and white balance before it, not after.
- Grade every shot of the clip the same unless the user asks otherwise: pass all video element ids at once. Keep skin natural — check a capture of a face after any wheels or hue change.`,

  motion: `# Motion: zoom, pan, animation

- Punch-in on emphasis: on the video element, set_keyframe scale 1 at the start of the phrase and 1.12-1.2 a few frames later (easing snappy or easeOut); set it back at the next sentence. Keyframe times are the ELEMENT's own seconds.
- Slow push: scale 1 -> 1.08 over 3-5s, easing linear or easeInOut.
- Pan: keyframe x. For the main video in a fill frame, x is already keyframed to follow the speaker; do not break that track — prefer scale.
- Text: animations {type: "appearWord"} reveal word by word; "grow"/"slideUp" for titles; always add an "out" phase for titles that end mid-clip.
- Easings: snappy for punches, gentle/easeInOut for drifts, bouncy for playful titles.`,

  reframe: `# Frame and reframe

- set_frame {width, height, mode}: 1080x1920 (9:16, TikTok/Reels/Shorts), 1080x1350 (4:5 feed), 1080x1080 (1:1), 1920x1080 (16:9).
- mode fill crops the source and follows the speaker's face; fit shows the whole source with bars.
- After changing the frame, capture 3-4 frames across the clip: the face must stay inside the frame, and titles/captions may need moving.
- The video's x keyframes ARE the face tracking: the scene mark "reframe" holds where the face is over time, and a pair of keyframes one frame apart is a scene change (a hard cut, not a bug). Do not delete or flatten them; check reports subject-offscreen when the speaker leaves the frame.`,

  layout: `# Layout: split frame, visual-only, and multi-source layouts

- clean_audio {amount, element_id?}: removes steady background noise (hum, fan, room hiss) from the voice when the video is exported; 0.6 suits most voice recordings, omit element_id to clean the clip's own video (all cut pieces). The editor preview still plays the original sound, so tell the user it applies on export.
- set_layout {mode, start, end, ratio} lays the speaker and visuals out together. split-bottom: speaker in the bottom band, a dark panel on top for visuals; split-top: the reverse; visual-only: the panel covers the whole frame while the voice keeps playing (a cutaway); pip: the panel covers the frame and the speaker sits in a rounded square in a corner (anchor top-left/top-right/bottom-left/bottom-right, default bottom-right; ratio = the square's share of the frame width, 0.2-0.5, default 0.36) — use top-right when captions sit at the bottom; side-by-side: the speaker in one column and the panel in the other (anchor left/right, ratio = the speaker column's share of the width, default 0.5; best in 1:1 and 16:9 frames); full: back to the speaker full frame (clears that range). For splits, ratio = the speaker's share of the height (0.5 default, 0.6 keeps the face bigger). Visuals you add inside a layout range land in the free area by themselves.
- Use a split while the speaker explains something with steps, a comparison or numbers (3-15 s): the diagram, chart, icons or animation go in the panel. Use a short visual-only (2-4 s) for one striking number or image. Keep at least half of the clip full frame: the face is what holds attention.
- Add the layout FIRST, then the visuals for that range: visuals without an explicit region or at land in the panel on their own.
- The layout wraps the clip video in "Speaker" (a group, or a masked rect once pip/side-by-side is used) and adds a rect "Layout panel" (plus "Layout backdrop" for pip): do not edit or delete them by hand; call set_layout again. It survives text cuts and set_frame.
- check reports covers-speaker when a visual sits on the speaker's band.
- Several sources at once (B-roll, photos, the clip's own video) go in apply_layout, not set_layout: layouts full, side_by_side, top_bottom, pip_top_left/top_right/bottom_left/bottom_right (main = the full frame, inset = the small corner box on top), grid_2x2/3x3/4x4, main_sidebar (70/30), three_up (3 columns), three_stack (3 rows). Every slot needs an element (list_library + insert_asset first for new media); the elements must play at the same time. fit fill crops to cover the slot (anchor picks the kept part, e.g. top for a face), fit shows all of it. The clip's own video can take one slot: it keeps its face tracking and the slot holds while the other elements play. On a vertical clip prefer three_stack, top_bottom or a pip; three_up columns are thin.`,

  visuals: `# Explainer visuals

Use a visual when the speaker explains something a picture makes faster: steps, a loop, a comparison, a number, a trend, a formula. One visual at a time; 2-6 seconds each; never more than one idea on screen.

- Icons: find_icons {query} then add_icon {name, at, size, motion}. Match the word being said (money → dollar-sign or wallet, growth → trending-up, time → clock, idea → lightbulb). Motion adds life: spin for loops/refresh, bounce for a person, pulse for a heart or a target, fly for anything travelling (an arrow from a bow-arrow to a target, with orient true). Keep 1-3 icons on screen at once.
- Animations: find_lotties {query} then add_lottie {animation, at, size} for motion that icons cannot do — a stick person who walks, runs, waves, points, jumps or cheers; effects (confetti, check-draw, lightbulb-on for an idea, rocket-launch for a launch, target-hit for a goal, clock-tick for time pressure, heart-beat, sparkle); animated emoji (emoji/fire, emoji/joy, emoji/thinking, emoji/exploding-head…) for a feeling or reaction on the line that carries it. One at a time, sized 0.25-0.4 (emoji 0.2-0.3), away from the speaker's face; flip: true to face the other way. Emoji are playful: skip them on serious topics.
- Point at things: add_shape arrow/circle/underline/highlight/check/cross. They draw on like a hand sketch. Coordinates are 0-1 of the frame.
- Steps or a process: add_diagram layout "column" on vertical video (3-5 short labels, 1-4 words each), "row" for 2-3 steps, "cycle" for a loop, "tree" for one idea splitting into parts, "compare" for A vs B with 2-3 bullet items each.
- Numbers: add_chart "stat" for one big number (value + short label), "bar" to compare 2-6 values, "line" for growth over time, "donut"/"pie" for shares of a whole.
- Formulas and curves: add_graph (y = f(x)), e.g. "2^x" for compounding, "x^2" for acceleration.
- Timing: pass quote with the words from <clip_context>; the visual starts on the first word and lasts to the end of that line (2-6 s). Give start/end (clip seconds) only to stretch it to the end of the idea. Diagrams build node by node; their total build takes about 60% of their time on screen.
- Placement: the default region is the top third of a vertical frame, clear of the face and the captions. If the face is high in the frame, move the region lower (region {x, y, width, height} in 0-1) or move captions. Capture a frame in the middle of the visual and at its end: labels readable, nothing covering the face.
- Change a visual later with update_visual {id, changes} (labels, data, layout, colors, region); do not delete and re-add.
- stagger animates a list of elements one after another.
- Custom shapes: insert_node a path (SVG d) with strokes, and keyframe trimEnd 0 → 1 to draw it on; keyframe "d" between two paths to morph one shape into another.`,

  brand: `# Brand kit

When <clip_context> has "brand", the clip is on the user's brand kit:
- Drawn visuals (charts, diagrams, icons, shapes, graphs) and 3D Studio scenes take the brand colors and heading font automatically. Do not pass colors unless the user asks for a different one.
- Text you add (add_text, insert_node): use the brand heading_font for titles and the brand colors for highlights.
- Captions already use the brand style; do not change caption style unless asked.
- You cannot create or change brand kits. If the user wants their brand applied or edited, tell them: menu › Apply brand kit in the editor, or the Brand kit page in the app.`,

  "3d": `# 3D animations (preview_3d → add_3d_scene)

You write three.js code for a short 3D animation that makes the speaker's point land faster than words. It renders on our GPUs as a video on the clip (credits after the user approves). Use it for ONE or two strong moments per clip, never as decoration.

## 1. Brief first (write it in update_plan or your reply)
- quote: the exact words from <clip_context> it plays over.
- idea: what the viewer must understand, in one sentence.
- metaphor: ONE concrete physical picture of that idea — "a staircase whose steps get taller", "a calendar shedding pages until a wall", "a tower of paper rising". Physical objects and motion beat text. A plain chart only when the speaker gives numbers.
- beats: 2-4 timed steps (seconds from the animation's start) that follow the words.
- text: at most 3 short labels (1-3 words) taken from the speaker's words. Numbers only if the speaker says them.

## 2. The code
The BODY of function (THREE, stage, kit) { … } that ends with return (t) => { … } (t = seconds, 0 to duration). Build everything once, then only move/scale/show things inside the update. Pure function of t: no Math.random (use stage.random() while building), no Date, timers, fetch or DOM — they are not available.

Already there: a dark studio (gradient background, key + rim lights, soft shadows, reflections, a glossy floor at y = 0, bloom on emissive materials, floating dust).
- stage.root: add everything here. Give important objects a name ("calendar", "wall") — the layout report uses it.
- kit.frame({ yaw, pitch, padding, push }) — CALL IT EVERY FRAME. It frames the whole scene (its final state) automatically; you only choose the angle (yaw/pitch in degrees; 10-25 / 8-20 look good) and a slow push-in (0 → 1). Animate yaw a few degrees over time for life. Do not place the camera yourself.
- kit.label(text, { size, at: object or THREE.Vector3, lift, glow, font: 'display' | 'body' }) — 3D text that faces the camera and sits on top of its object. Use it for every word on screen.
- Data pieces (numbers are always right):
  - kit.bars(values, { labels, highlight, showValues }) → { group, grow(p) } — p 0→1 grows the bars one by one.
  - kit.counter(value, { prefix, suffix, decimals, size }) → { mesh, set(p) } — counts up as p goes 0→1.
  - kit.product('phone'|'laptop'|'coin'|'gift'|'trophy'|'rocket'|'lightbulb'|'globe'|'box'|'bottle') → { object, animate(t) }.
- Timing: kit.phase(t, start, length) → 0..1; kit.stagger(t, index, { start, step, length }); easings kit.easeOutBack (pop), kit.easeOutCubic, kit.easeInOutCubic, kit.easeOutExpo; kit.clamp01.
- Materials: kit.glossy(color, { metalness, roughness, emissive }) (emissive 1.5-3 glows), kit.metal(color, roughness).
- Colors: stage.palette.colors (6), stage.palette.text, stage.accent (a THREE.Color) — they match the background and the brand kit. Make the key element the accent with a little glow; use 2-3 colors.
- Shapes: BoxGeometry, CylinderGeometry, CapsuleGeometry, TorusGeometry, SphereGeometry, ExtrudeGeometry; set mesh.castShadow = true. Keep the subject 3-5 units wide, standing on the floor, centred near x = 0.
- Look: one clear subject; build up with easeOutBack, staggered 0.1-0.25 s; hold the final state still for the last ~0.6 s. Under 100k triangles and 300 meshes (InstancedMesh for many copies). No new geometries inside the update except labels.

## 3. Preview and fix — required
preview_3d { code, duration, aspect_ratio } returns 4 frames and a layout report. Look at the frames AND read the report:
- an error (compile / build / frame + message) → fix the code;
- "… is cut off" / "outside the frame" → move or shrink that object, or rely on kit.frame (did you call it every frame?);
- "nearly empty" → the scene is too small or off camera;
- check that the metaphor reads at a glance on a phone and the text is legible.
Fix and preview again — up to 3 rounds — until there are no errors and no layout issues.

## 4. Add it
add_3d_scene { title, code (exactly what you last previewed), quote, theme? }. Duration comes from the quote (3-10 s); use the same duration in preview_3d. The video always takes the shape of the area it fills, so preview in that shape: full screen = clip_context.frame (a 16:9 clip is landscape); the panel of a split = 1:1 or 4:5.
After it renders (about half a minute) capture a frame in its middle to confirm it sits well on the clip.`,

  voiceover: `# Voiceover (add_voiceover, when available)

A new AI voice on the clip. It costs credits (the user approves the price) and arrives in a few seconds to a minute. Only when the user asks for a voiceover, narration, a new script or to "repurpose" the clip.

- mode "replace" (repurpose the whole clip): the new voice replaces the speaker. The original speech is muted and its captions hidden; new captions follow the new voice word by word. Workflow:
  1. get_transcript and read <clip_context>: what is the clip actually about?
  2. Write a NEW script in your own words from the angle the user wants (commentary, summary, a lesson, a reaction). Do not copy the speaker's sentences. Fit the clip: about 3 words per second of clip (a 30 s clip ≈ 85-90 words). Short sentences read better.
  3. add_voiceover mode "replace" with the script and a voice.
  4. Add visuals that follow the NEW script (add_chart, add_diagram, a 3D animation with add_3d_scene, library media, generate_media when the user wants AI B-roll). The new captions have the new words; plan beats with update_plan by script position.
- mode "overlay" (a short line over the clip): start (clip seconds) or quote (it starts after those words); the original audio drops by duck_db (default -18 dB) while it speaks. Captions off by default.
- Voices: pick one that fits the tone; say which one you picked.
- The voice appears as a layer named "Voiceover: …"; deleting it restores the original audio and captions.
- Do not claim that a new voice or new visuals make it fine to use someone else's video. If the user asks about rights, say that permission from the owner is still needed.`,

  blank: `# Project without a script (blank "New edit", AI-only video)

Nothing is spoken, so there are no quotes to anchor to: every piece of media is placed by time.

1. Plan the video first with update_plan, one beat per line in seconds: "[0-3s] hook: a laptop glowing in a dark hotel room", "[3-7s] the dashboard fills with bookings". Keep each shot 2-5 seconds.
2. work_area in <clip_context> is how long the video plays. When the plan is longer, set_workarea {start: 0, end: <plan length>} BEFORE adding media, or the shots past the end will not play.
3. Stills first: generate_media kind "image" for every shot in ONE message (one card, one total price), each with idea, subject, action, setting, style, camera, mood, start = the beat's first second and length = the beat's seconds. No quote. One style and the frame's aspect ratio for every shot.
4. After approval, list_library until they are ready, capture a frame on each, then ask_user which shots to animate (animation costs much more). Animate with generate_media kind "video": start_image = that still, the same brief, the same start, length = the beat, muted true. Delete the still each video replaces.
5. Words: add_voiceover with mode "overlay" and start 0 (about 3 words per second of video), or add_text titles timed to the beats.
6. Music: generate_media kind "audio" (instrumental, mood, genre, tempo), start 0, duration = the video length up to the model's limit, then set_props volume -18 when there is a voice.
7. Capture a frame in the middle of every beat: nothing empty, nothing off-screen, text readable.`,

  document: "",
} as const;

export type GuideName = keyof typeof GUIDES;
export const GUIDE_NAMES = Object.keys(GUIDES) as [GuideName, ...GuideName[]];

let documentText: string | null = null;

export function readGuide(name: GuideName): string {
  if (name === "document") return (documentText ??= documentGuide());
  return GUIDES[name];
}
