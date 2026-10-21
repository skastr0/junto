/**
 * The visual language of 0.10's resources, as data: which mark a mention chip
 * wears per kind, how a task state and a review stamp read, and how a pending
 * (queued, not yet ruled) item is told apart. Components in `components/ui`
 * draw from these tables and nothing else, so a new kind or state fails tsc
 * here before it can ship undrawn.
 *
 * Law behind the tables: words stay neutral (ink, ink-2, dim); a hue lives on
 * the mark (glyph, dot, edge). Crimson is for blockers only: a stamp that
 * asks for changes is the one place a task state surface wears it, and no task
 * state does. Shape differs from state to state, never colour alone.
 */

/** The four things a mention can name (03, `MentionRef`). */
export const RESOURCE_KINDS = ["seat", "task", "artifact", "page"] as const;
export type ResourceKind = (typeof RESOURCE_KINDS)[number];

/** The five artifact types (05). A link is the base every other type adds to. */
export const ARTIFACT_TYPES = ["link", "document", "pad", "sheet", "file"] as const;
export type ArtifactType = (typeof ARTIFACT_TYPES)[number];

/** A mark hue. Each is a theme token, so a mode change moves it with the ground. */
export const MARK_TONES = ["amber", "cyan", "green", "violet", "indigo", "steel", "crimson", "dim", "faint"] as const;
export type MarkTone = (typeof MARK_TONES)[number];

export const markColor = (tone: MarkTone): string => `var(--color-${tone})`;

export type ResourceGlyph = "seat" | "task" | "artifact" | "page";

export type ResourceKindVisual = {
  readonly tone: MarkTone;
  /** Spoken and tooltip name of the kind. */
  readonly noun: string;
  /** The key that picks the glyph. Components own the icon import. */
  readonly glyph: ResourceGlyph;
};

/**
 * Seats keep the house amber. Task and artifact take different hues on
 * purpose: they sit side by side in one row of chips, and NodeKindMark's two
 * greens would read as one kind there.
 */
export const RESOURCE_KIND_VISUAL: Readonly<Record<ResourceKind, ResourceKindVisual>> = {
  seat: { tone: "amber", noun: "Seat", glyph: "seat" },
  task: { tone: "green", noun: "Task", glyph: "task" },
  artifact: { tone: "violet", noun: "Artifact", glyph: "artifact" },
  page: { tone: "indigo", noun: "Page", glyph: "page" },
};

export const ARTIFACT_TYPE_NOUN: Readonly<Record<ArtifactType, string>> = {
  link: "Link",
  document: "Document",
  pad: "Pad",
  sheet: "Sheet",
  file: "File",
};

/** Task states of 0.10 (04). `submitted` became `backlog`; failed, rejected and auth-required are gone. */
export const TASK_STATES = [
  "backlog",
  "assigned",
  "working",
  "input-required",
  "in-review",
  "done",
  "canceled",
  "archived",
] as const;
export type TaskStateV10 = (typeof TASK_STATES)[number];

export type TaskStateGlyph =
  | "dashed-circle"
  | "circle"
  | "lamp"
  | "pause"
  | "stamp"
  | "check"
  | "slash"
  | "box";

export type TaskStateVisual = {
  readonly label: string;
  readonly tone: MarkTone;
  readonly glyph: TaskStateGlyph;
  /** Work is moving: the mark pulses the slow house glow. */
  readonly live: boolean;
  /** Nothing more will happen: the row sits back (dim title, struck for canceled). */
  readonly settled: boolean;
};

export const TASK_STATE_VISUAL: Readonly<Record<TaskStateV10, TaskStateVisual>> = {
  backlog: { label: "Backlog", tone: "faint", glyph: "dashed-circle", live: false, settled: false },
  assigned: { label: "Assigned", tone: "steel", glyph: "circle", live: false, settled: false },
  working: { label: "Working", tone: "amber", glyph: "lamp", live: true, settled: false },
  "input-required": { label: "Needs input", tone: "cyan", glyph: "pause", live: false, settled: false },
  "in-review": { label: "In review", tone: "violet", glyph: "stamp", live: false, settled: false },
  done: { label: "Done", tone: "green", glyph: "check", live: false, settled: true },
  canceled: { label: "Canceled", tone: "dim", glyph: "slash", live: false, settled: true },
  archived: { label: "Archived", tone: "faint", glyph: "box", live: false, settled: true },
};

/** Open states: the ones that hold a seat (04, invariant 2). Reviews do not count, but in-review holds the assignee. */
export const isOpenTaskState = (state: TaskStateV10): boolean =>
  state === "assigned" || state === "working" || state === "input-required" || state === "in-review";

/** One slot of a stamp tally, in the order they are drawn. */
export const STAMP_SLOTS = ["approved", "changes", "pending", "waiting", "stale"] as const;
export type StampSlot = (typeof STAMP_SLOTS)[number];

export type StampSlotVisual = {
  readonly tone: MarkTone;
  readonly noun: string;
  /** Drawn as a dashed edge: not ruled yet (02, pending state), or no longer counting. */
  readonly dashed: boolean;
  /** Filled solid. Only a ruled approval or a ruled request for changes is. */
  readonly filled: boolean;
};

export const STAMP_SLOT_VISUAL: Readonly<Record<StampSlot, StampSlotVisual>> = {
  approved: { tone: "green", noun: "approved", dashed: false, filled: true },
  changes: { tone: "crimson", noun: "asked for changes", dashed: false, filled: true },
  pending: { tone: "green", noun: "approval queued", dashed: true, filled: false },
  waiting: { tone: "dim", noun: "waiting", dashed: false, filled: false },
  stale: { tone: "faint", noun: "from an earlier round, not counted", dashed: true, filled: false },
};

/** The stand-in for a stamp (04): the fields the tally reads, no more. */
export type StampView = {
  readonly verdict: "approve" | "changes";
  readonly epoch: number;
  /** The writing machine holds it but the editing machine has not ruled it (02). */
  readonly pending?: boolean;
};

export type StampTally = {
  readonly required: number;
  readonly slots: ReadonlyArray<StampSlot>;
  /** Ruled approvals at the current epoch. */
  readonly approved: number;
  /** Queued approvals at the current epoch. */
  readonly pending: number;
  readonly changes: number;
  readonly stale: number;
  /** Ruled approvals alone meet the policy. Queued ones never do (02: never `done` locally). */
  readonly met: boolean;
};

/**
 * What the review stamps of a task look like right now. Approvals count at
 * the current epoch only; a stamp from an earlier epoch is drawn but never
 * counted. `required` of zero is no review: an empty tally that is met.
 */
export const stampTally = (required: number, stamps: ReadonlyArray<StampView>, epoch: number): StampTally => {
  const current = stamps.filter((stamp) => stamp.epoch === epoch);
  const approved = current.filter((stamp) => stamp.verdict === "approve" && stamp.pending !== true).length;
  const pending = current.filter((stamp) => stamp.verdict === "approve" && stamp.pending === true).length;
  const changes = current.filter((stamp) => stamp.verdict === "changes").length;
  const stale = stamps.length - current.length;
  const counted = approved + pending;
  const waiting = Math.max(0, required - counted);
  const slots: StampSlot[] = [
    ...Array<StampSlot>(approved).fill("approved"),
    ...Array<StampSlot>(pending).fill("pending"),
    ...Array<StampSlot>(changes).fill("changes"),
    ...Array<StampSlot>(waiting).fill("waiting"),
    ...Array<StampSlot>(stale).fill("stale"),
  ];
  return { required, slots, approved, pending, changes, stale, met: approved >= required };
};

/** "2 of 3 approved", or "2 of 2 approvals pending" while queued ones would meet it (02). */
export const stampSummary = (tally: StampTally): string => {
  if (tally.required === 0) return "No review required";
  const counted = tally.approved + tally.pending;
  if (tally.pending > 0) return `${Math.min(counted, tally.required)} of ${tally.required} approvals pending`;
  const base = `${tally.approved} of ${tally.required} approved`;
  return tally.changes > 0 ? `${base}, changes asked` : base;
};
