/**
 * Twenty fixed founders for the brain's plan eval (P6 B4, `brain.md` §10). Each is a product shape solo
 * founders really build, at a stated stage, with this week's goal. Hand-written: no numbers beyond the ones
 * in the documents (pricing), no customers, quotes or results the stage could not have.
 *
 * Changing a profile changes the eval: add new ones at the end so older rows stay comparable.
 */

import type { BrainEvalProfile, BrainStage } from "../studio-types";

const STAGE_TEXT: Record<BrainStage, string> = {
  pre_launch: "Pre-launch: building, a waitlist page, no users yet",
  launched_no_users: "Launched this month, no paying users yet",
  first_users: "A handful of early users, looking for the next ones",
  growing: "Paying customers and a steady trickle of signups",
};

type Short = {
  name: string;
  stage: BrainStage;
  goal: string;
  product: string;
  oneLiner: string;
  pricing: string;
  icp: string;
  avoid: string[];
  pillar: string;
  ideas: string[];
  /** Mentions video in the strategy (a plan may hold one video item). */
  video?: string;
  /** Names another platform the plan may use. */
  platforms?: string;
  brief?: string;
};

const profile = (p: Short): BrainEvalProfile => ({
  name: p.name,
  stage: p.stage,
  goal: p.goal,
  ...(p.brief ? { brief: p.brief } : {}),
  docs: {
    product: { name: p.product, one_liner: p.oneLiner, pricing: p.pricing },
    strategy: { icp: p.icp, avoid: p.avoid, stage: STAGE_TEXT[p.stage], ...(p.platforms ? { channels: p.platforms } : {}) },
    content_strategy: { pillars: [{ name: p.pillar, ideas: p.ideas }], ...(p.video ? { short_video: p.video } : {}) },
  },
});

export const BRAIN_PROFILES: BrainEvalProfile[] = [
  profile({ name: "invoice-chaser", stage: "first_users", goal: "Get 3 freelancers to try the reminder flow", product: "Paylane", oneLiner: "Invoicing that chases late payments.", pricing: "$12/month", icp: "Freelancers who invoice a few clients a month", avoid: ["revolutionary"], pillar: "Getting paid", ideas: ["The polite reminder that gets invoices paid", "What to write when a client goes quiet"], video: "Screen recordings of the reminder flow." }),
  profile({ name: "uptime-dev", stage: "launched_no_users", goal: "Get the first 5 signups from developers", product: "Pingwise", oneLiner: "Uptime checks that tell you which deploy broke the site.", pricing: "Free for 5 monitors, $9/month after", icp: "Solo developers running small SaaS apps", avoid: ["seamless"], pillar: "Shipping safely", ideas: ["The check to run after every deploy", "Rolling back without panic"] }),
  profile({ name: "salon-booking", stage: "growing", goal: "Reach more salon owners on LinkedIn", product: "Slotty", oneLiner: "Booking pages for hair salons with deposits built in.", pricing: "$19/month per salon", icp: "Owners of small salons", avoid: ["disrupt"], pillar: "Fewer no-shows", ideas: ["Why deposits cut no-shows", "The reminder text clients answer"], platforms: "X and LinkedIn" }),
  profile({ name: "waitlist-notes", stage: "pre_launch", goal: "Grow the waitlist before launch", product: "Margin", oneLiner: "A notes app that turns meeting notes into a task list.", pricing: "Free during the beta", icp: "Managers drowning in meeting notes", avoid: ["game-changer"], pillar: "Meetings that end in action", ideas: ["Why meeting notes die in a folder", "Turning one meeting into three tasks"] }),
  profile({ name: "recipe-costing", stage: "first_users", goal: "Show how costing a dish works, with a demo video", product: "Platecost", oneLiner: "Recipe costing for small restaurants.", pricing: "$15/month", icp: "Chefs who own a small restaurant", avoid: ["unleash"], pillar: "Know your margins", ideas: ["Costing one dish in a few minutes", "The ingredient that eats your margin"], video: "A short demo of costing a dish.", brief: "Make one demo video this week" }),
  profile({ name: "dog-walk", stage: "launched_no_users", goal: "Get the first dog walkers to list their service", product: "Pawpal", oneLiner: "Booking and payments for independent dog walkers.", pricing: "5% per booking", icp: "Independent dog walkers in cities", avoid: ["synergy"], pillar: "Running a walking business", ideas: ["Pricing a group walk", "Handling a last-minute cancellation"] }),
  profile({ name: "tutor-schedule", stage: "growing", goal: "Bring back tutors who stopped using the app", product: "Lessonly", oneLiner: "Scheduling and reminders for private tutors.", pricing: "$8/month", icp: "Private tutors with a full week", avoid: ["revolutionary"], pillar: "A calmer teaching week", ideas: ["The reschedule rule that keeps students", "Planning a week of lessons on Sunday"], platforms: "X and Threads" }),
  profile({ name: "podcast-clips", stage: "first_users", goal: "Get podcasters to cut their first clip", product: "Clipcast", oneLiner: "Turns your own podcast episodes into short clips.", pricing: "$20/month", icp: "Indie podcasters", avoid: ["viral"], pillar: "Getting heard", ideas: ["Picking the minute worth clipping", "Captions people read on mute"], video: "Clips cut from my own episodes." }),
  profile({ name: "shift-notes", stage: "pre_launch", goal: "Find 10 nurses for the beta", product: "Shiftnote", oneLiner: "Handover notes for nurses at shift change.", pricing: "Free beta", icp: "Ward nurses handing over between shifts", avoid: ["disrupt"], pillar: "Better handovers", ideas: ["What a good handover covers", "The handover that goes wrong"] }),
  profile({ name: "bookkeeping-etsy", stage: "growing", goal: "Explain tax season prep to Etsy sellers", product: "Tallybook", oneLiner: "Bookkeeping for Etsy sellers.", pricing: "$10/month", icp: "Etsy sellers with a shop that pays some bills", avoid: ["effortless"], pillar: "Clean books", ideas: ["Sorting fees from sales", "The receipts to keep for tax season"] }),
  profile({ name: "habit-ios", stage: "launched_no_users", goal: "Get the first reviews on the App Store", product: "Streakly", oneLiner: "A habit tracker that forgives a missed day.", pricing: "Free with a $3/month plus plan", icp: "People who quit habit apps after one bad week", avoid: ["life-changing"], pillar: "Habits that survive a bad week", ideas: ["Why a missed day should not reset a streak", "Starting smaller than feels useful"] }),
  profile({ name: "cold-email", stage: "first_users", goal: "Get agency owners to book a call", product: "Replybase", oneLiner: "Writes the follow-up when a cold email gets no answer.", pricing: "$29/month", icp: "Owners of small marketing agencies", avoid: ["guaranteed"], pillar: "Follow-ups that get answers", ideas: ["The second email most people never send", "Ending a thread politely"], platforms: "X and LinkedIn" }),
  profile({ name: "plant-care", stage: "pre_launch", goal: "Collect the first 50 waitlist signups", product: "Leafwise", oneLiner: "Watering reminders based on your plants and your window.", pricing: "Free at launch", icp: "Apartment plant owners", avoid: ["magic"], pillar: "Plants that live", ideas: ["Why most houseplants die of too much water", "Reading the light at your window"] }),
  profile({ name: "contract-review", stage: "growing", goal: "Publish a launch video for the new clause checker", product: "Clausy", oneLiner: "Flags risky clauses in freelance contracts.", pricing: "$14/month", icp: "Freelance designers and developers", avoid: ["lawyer-grade"], pillar: "Contracts without surprises", ideas: ["The payment clause to read twice", "Scope creep starts in the contract"], video: "A launch video for the clause checker.", brief: "Launch week: one video for the clause checker" }),
  profile({ name: "gym-classes", stage: "first_users", goal: "Fill the Tuesday class for one studio", product: "Classly", oneLiner: "Class booking and waitlists for small gyms.", pricing: "$39/month per studio", icp: "Owners of boutique fitness studios", avoid: ["crush it"], pillar: "Full classes", ideas: ["Why waitlists fill late cancellations", "The reminder that cuts no-shows"] }),
  profile({ name: "open-source-cli", stage: "launched_no_users", goal: "Get the first GitHub stars and issues", product: "Shipdocs", oneLiner: "A CLI that writes changelogs from your commits.", pricing: "Free and open source, paid hosting later", icp: "Maintainers of small open-source projects", avoid: ["10x"], pillar: "Releases people read", ideas: ["A changelog your users can skim", "Commit messages that write the notes for you"] }),
  profile({ name: "wedding-photos", stage: "growing", goal: "Reach wedding photographers before the season", product: "Proofly", oneLiner: "Client galleries where couples pick their favourites.", pricing: "$18/month", icp: "Independent wedding photographers", avoid: ["stunning"], pillar: "Smoother deliveries", ideas: ["Getting couples to pick in a week", "The gallery email couples open"], platforms: "X and Threads", video: "Short walkthroughs of a client gallery." }),
  profile({ name: "language-flash", stage: "pre_launch", goal: "Test which pitch gets waitlist signups", product: "Wordly", oneLiner: "Flashcards made from the shows you watch.", pricing: "Free at launch", icp: "Adults learning Spanish from TV", avoid: ["fluent fast"], pillar: "Learning from what you watch", ideas: ["Why words from a show stick", "Five minutes a day after an episode"] }),
  profile({ name: "home-inspect", stage: "first_users", goal: "Win two more inspectors in one city", product: "Inspecta", oneLiner: "Inspection reports written on a phone on site.", pricing: "$25/month", icp: "Independent home inspectors", avoid: ["cutting-edge"], pillar: "Reports done on site", ideas: ["Finishing the report before you drive home", "Photos that explain a defect"] }),
  profile({ name: "newsletter-tool", stage: "launched_no_users", goal: "Get writers to import their list", product: "Inkwell", oneLiner: "A newsletter tool that writes your welcome sequence with you.", pricing: "Free to 500 subscribers", icp: "Writers starting a paid newsletter", avoid: ["explode"], pillar: "Welcoming new readers", ideas: ["What the first email should say", "A welcome sequence in three emails"] }),
];
