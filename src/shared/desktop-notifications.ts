import type { NotificationSettings } from "./settings";

/**
 * Desktop notifications: what reaches the operator while Junto is not the
 * window they are looking at.
 *
 * The renderer reports every open need on the canvas as a subject (a stable
 * key per need); main owns whether the window is in front, and this policy
 * turns the difference between reports into native notifications. Pure: no
 * Electron, no timers. Main calls `observe` on each report, `setAway` on
 * focus changes, and `flush` when `nextFlushAt` comes due.
 *
 * Laws:
 * - Nothing posts while the window is in front; what the operator could see
 *   when they left is already seen.
 * - A need rises once. Only a key first seen while away can post.
 * - A need that resolves before it settles never posts.
 * - One notification per seat per absence; a more urgent need on the same
 *   seat replaces it, a less urgent one does not.
 * - A burst across many seats is one summary, and past a per-absence cap
 *   every further need folds into a summary.
 * - Finished seats wait longer and arrive together, quieter.
 */

export const NOTIFY_CATEGORIES = ["blocked", "failed", "needsYou", "done"] as const;
export type NotifyCategory = (typeof NOTIFY_CATEGORIES)[number];

/** One open need on the canvas, as the renderer reports it. */
export type NotifySubject = {
  /** Stable per need: a feed item id, `done:<node>:<at>`, `failed:<node>:<epoch>`. */
  readonly key: string;
  readonly category: NotifyCategory;
  readonly canvasName: string;
  readonly nodeId: string;
  readonly seatName: string;
  /** One line, the way the feed says it. */
  readonly text: string;
};

export type NotifyReport = {
  readonly canvasName: string;
  readonly subjects: ReadonlyArray<NotifySubject>;
  /** Needs-you count for the Dock badge: the ⌘I feed's own count. */
  readonly badge: number;
  readonly prefs: NotificationSettings;
};

/** Where a click lands: one seat's focus view, or the feed. */
export type NotifyTarget =
  | { readonly kind: "seat"; readonly canvasName: string; readonly nodeId: string }
  | { readonly kind: "feed"; readonly canvasName: string };

/** The sound cue that goes with a post; the banner itself is silent. */
export type NotifyCue = "blocked" | "needs-you" | "done" | "failed" | "summary";

export type NotifyPost = {
  /** Replaces the delivered notification with this tag, if one is showing. */
  readonly tag: string;
  readonly title: string;
  readonly subtitle?: string;
  readonly body: string;
  readonly target: NotifyTarget;
  readonly cue: NotifyCue;
  /** Bounce the Dock once: a blocked seat, with the setting on. */
  readonly bounce: boolean;
  /** The subject keys this post speaks for, so it can close when they resolve. */
  readonly keys: ReadonlyArray<string>;
};

type Pending = { readonly subject: NotifySubject; readonly at: number };

export type NotifyState = {
  readonly away: boolean;
  /** Keys the operator has had their chance at: present while in front, or already handled. */
  readonly seen: ReadonlySet<string>;
  readonly pending: ReadonlyMap<string, Pending>;
  /** Seat tag -> rank of the need already posted this absence. */
  readonly postedRank: ReadonlyMap<string, number>;
  /** Posts made this absence, for the cap. */
  readonly posted: number;
};

/** An urgent need settles this long before it posts, so a flicker never does. */
export const URGENT_SETTLE_MS = 1_500;
/** Finished seats gather this long, then arrive as one. */
export const DONE_SETTLE_MS = 10_000;
/** More seats than this in one flush become a summary. */
export const SUMMARY_OVER = 3;
/** Past this many posts in one absence, everything new is a summary. */
export const POSTS_PER_ABSENCE = 6;
const TEXT_MAX = 140;

const RANK: Readonly<Record<NotifyCategory, number>> = {
  blocked: 4,
  failed: 3,
  needsYou: 2,
  done: 1,
};

const SUBTITLE: Readonly<Record<NotifyCategory, string>> = {
  blocked: "Blocked",
  failed: "Stopped",
  needsYou: "Needs you",
  done: "Finished",
};

const CUE: Readonly<Record<NotifyCategory, NotifyCue>> = {
  blocked: "blocked",
  failed: "failed",
  needsYou: "needs-you",
  done: "done",
};

export const emptyNotifyState = (): NotifyState => ({
  away: false,
  seen: new Set(),
  pending: new Map(),
  postedRank: new Map(),
  posted: 0,
});

export const seatTag = (subject: Pick<NotifySubject, "canvasName" | "nodeId">): string =>
  `seat:${subject.canvasName}:${subject.nodeId}`;

const categoryOn = (prefs: NotificationSettings, category: NotifyCategory): boolean =>
  prefs.enabled && prefs[category];

/** One line, trimmed to fit a banner. */
export const oneLine = (text: string): string => {
  const flat = text.replace(/\s+/g, " ").trim();
  return flat.length <= TEXT_MAX ? flat : `${flat.slice(0, TEXT_MAX - 1).trimEnd()}…`;
};

/** "Maple, Pip and Clove", "Maple, Pip, Clove and 2 more". */
export const nameList = (names: ReadonlyArray<string>, shown = 3): string => {
  const unique = [...new Set(names)];
  if (unique.length <= 1) return unique[0] ?? "";
  if (unique.length <= shown) return `${unique.slice(0, -1).join(", ")} and ${unique.at(-1)}`;
  return `${unique.slice(0, shown).join(", ")} and ${unique.length - shown} more`;
};

/** The Dock badge for a report: the feed's count, or nothing when the badge is off. */
export const badgeCount = (report: Pick<NotifyReport, "badge" | "prefs">): number =>
  report.prefs.badge ? Math.max(0, Math.floor(report.badge)) : 0;

/**
 * Take a report. Returns the next state and the keys that resolved, so main
 * can close any delivered notification that speaks only for them.
 */
export const observe = (
  state: NotifyState,
  subjects: ReadonlyArray<NotifySubject>,
  now: number,
): { readonly state: NotifyState; readonly resolved: ReadonlyArray<string> } => {
  const live = new Map(subjects.map((subject) => [subject.key, subject] as const));
  const resolved = [...state.seen, ...state.pending.keys()].filter((key) => !live.has(key));
  if (!state.away) {
    return { state: { ...state, seen: new Set(live.keys()), pending: new Map() }, resolved };
  }
  const pending = new Map<string, Pending>();
  for (const [key, entry] of state.pending) {
    const subject = live.get(key);
    if (subject) pending.set(key, { subject, at: entry.at });
  }
  for (const [key, subject] of live) {
    if (state.seen.has(key) || pending.has(key)) continue;
    pending.set(key, { subject, at: now });
  }
  const seen = new Set([...state.seen].filter((key) => live.has(key)));
  return { state: { ...state, seen, pending }, resolved };
};

/**
 * The window left the front (away) or came back. Coming back makes every
 * pending need seen and opens a fresh absence.
 */
export const setAway = (state: NotifyState, away: boolean): NotifyState => {
  if (away === state.away) return state;
  if (away) return { ...state, away: true, postedRank: new Map(), posted: 0 };
  return {
    away: false,
    seen: new Set([...state.seen, ...state.pending.keys()]),
    pending: new Map(),
    postedRank: new Map(),
    posted: 0,
  };
};

const settleMs = (category: NotifyCategory): number =>
  category === "done" ? DONE_SETTLE_MS : URGENT_SETTLE_MS;

/** When `flush` next has work, or null when nothing is pending. */
export const nextFlushAt = (state: NotifyState): number | null => {
  let next: number | null = null;
  for (const { subject, at } of state.pending.values()) {
    const due = at + settleMs(subject.category);
    if (next === null || due < next) next = due;
  }
  return next;
};

/**
 * Post what has settled. Urgent needs flush together once the oldest has
 * settled (a burst arrives as one flush); finished seats likewise, on their
 * own longer clock.
 */
export const flush = (
  state: NotifyState,
  now: number,
  prefs: NotificationSettings,
): { readonly state: NotifyState; readonly posts: ReadonlyArray<NotifyPost> } => {
  if (!state.away || state.pending.size === 0) return { state, posts: [] };
  const entries = [...state.pending.values()];
  const urgent = entries.filter((entry) => entry.subject.category !== "done");
  const done = entries.filter((entry) => entry.subject.category === "done");
  const due = (group: ReadonlyArray<Pending>): boolean =>
    group.some((entry) => entry.at + settleMs(entry.subject.category) <= now);
  const taking = [...(due(urgent) ? urgent : []), ...(due(done) ? done : [])];
  if (taking.length === 0) return { state, posts: [] };

  const seen = new Set(state.seen);
  const pending = new Map(state.pending);
  for (const entry of taking) {
    seen.add(entry.subject.key);
    pending.delete(entry.subject.key);
  }

  // Most urgent need per seat, among categories the operator wants, that
  // outranks what this seat already posted this absence.
  const bySeat = new Map<string, NotifySubject>();
  for (const { subject } of taking) {
    if (!categoryOn(prefs, subject.category)) continue;
    const tag = seatTag(subject);
    if ((state.postedRank.get(tag) ?? 0) >= RANK[subject.category]) continue;
    const held = bySeat.get(tag);
    if (!held || RANK[subject.category] > RANK[held.category]) bySeat.set(tag, subject);
  }

  const chosen = [...bySeat.values()].sort(
    (a, b) => RANK[b.category] - RANK[a.category] || a.seatName.localeCompare(b.seatName),
  );
  const keysFor = (subject: NotifySubject): ReadonlyArray<string> =>
    taking.filter((entry) => seatTag(entry.subject) === seatTag(subject)).map((entry) => entry.subject.key);

  const posts: NotifyPost[] = [];
  const postedRank = new Map(state.postedRank);
  const needs = chosen.filter((subject) => subject.category !== "done");
  const finished = chosen.filter((subject) => subject.category === "done");
  const room = Math.max(0, POSTS_PER_ABSENCE - state.posted);

  if (needs.length > 0) {
    if (needs.length > SUMMARY_OVER || needs.length > room) {
      posts.push(needsSummary(needs, prefs, needs.flatMap(keysFor)));
    } else {
      for (const subject of needs) posts.push(seatPost(subject, prefs, keysFor(subject)));
    }
    for (const subject of needs) postedRank.set(seatTag(subject), RANK[subject.category]);
  }
  if (finished.length > 0) {
    posts.push(
      finished.length === 1 && posts.length < room
        ? seatPost(finished[0]!, prefs, keysFor(finished[0]!))
        : doneSummary(finished, finished.flatMap(keysFor)),
    );
    for (const subject of finished) postedRank.set(seatTag(subject), RANK.done);
  }

  return {
    state: { ...state, seen, pending, postedRank, posted: state.posted + posts.length },
    posts,
  };
};

const seatPost = (
  subject: NotifySubject,
  prefs: NotificationSettings,
  keys: ReadonlyArray<string>,
): NotifyPost => ({
  tag: seatTag(subject),
  title: subject.seatName,
  subtitle: SUBTITLE[subject.category],
  body: oneLine(subject.text),
  target: { kind: "seat", canvasName: subject.canvasName, nodeId: subject.nodeId },
  cue: CUE[subject.category],
  bounce: subject.category === "blocked" && prefs.bounce,
  keys,
});

const needsSummary = (
  subjects: ReadonlyArray<NotifySubject>,
  prefs: NotificationSettings,
  keys: ReadonlyArray<string>,
): NotifyPost => {
  const blocked = subjects.filter((subject) => subject.category === "blocked").length;
  const canvasName = subjects[0]!.canvasName;
  return {
    tag: `summary:needs:${canvasName}`,
    title: `${subjects.length} agents need you`,
    ...(blocked > 0 ? { subtitle: blocked === 1 ? "1 blocked" : `${blocked} blocked` } : {}),
    body: nameList(subjects.map((subject) => subject.seatName)),
    target: { kind: "feed", canvasName },
    cue: "summary",
    bounce: blocked > 0 && prefs.bounce,
    keys,
  };
};

const doneSummary = (subjects: ReadonlyArray<NotifySubject>, keys: ReadonlyArray<string>): NotifyPost => {
  const canvasName = subjects[0]!.canvasName;
  return {
    tag: `summary:done:${canvasName}`,
    title: subjects.length === 1 ? `${subjects[0]!.seatName} finished` : `${subjects.length} agents finished`,
    body: subjects.length === 1 ? oneLine(subjects[0]!.text) : nameList(subjects.map((subject) => subject.seatName)),
    target: { kind: "feed", canvasName },
    cue: "done",
    bounce: false,
    keys,
  };
};
