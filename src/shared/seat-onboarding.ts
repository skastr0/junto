/**
 * What `junto onboard` teaches a seat: a few lines of guidance, and the
 * commands each connection allows.
 *
 * Nothing reaches a harness before its session starts. `junto onboard` is the
 * one loader: it returns the seat's facts and this module's guidance, short
 * enough to read in one pass. Everything reference-like stays behind
 * `junto docs`, `junto schema show` and `junto examples show`.
 *
 * Commands are COMPILED from the seat's edge reality: each target's held ports
 * select its rows, operator masks included. A seat is never taught a target
 * command without the corresponding held port. `junto docs` renders the same
 * rows as its per-kind contract tables, so the two cannot drift.
 *
 * Pure module, no Node imports (renderer-safe).
 */

import { productPortEnabled, TASKS_ENABLED } from "./features";
import type { Port } from "./physics/schema";

/** A connected node and the ports the seat holds on it. */
export type ConnectedTarget = {
  readonly id: string;
  readonly kind?: string;
  readonly summary?: string;
  /** Canonical held grants. Missing or empty grants teach no commands. */
  readonly ports?: readonly Port[];
};

/** Command families; membership comes from held ports, not target kind. */
export type CommandFamily =
  | "tasks"
  | "msg"
  | "reviews"
  | "artifacts"
  | "board"
  | "pad"
  | "sheet"
  | "browser";

/** One command a held port allows, written against a target id. */
export type CommandRow = {
  readonly port: Port;
  readonly intent: string;
  readonly command: (target: string) => string;
  /** Reference detail for the docs table. Onboard leaves it out. */
  readonly detail?: string;
};

type FamilySpec = {
  /** The name a seat reads: "messages", not the internal "msg". */
  readonly label: string;
  /** The node kind whose `junto docs node <kind>` page holds the reference. */
  readonly docsKind: string;
  /** One line a seat needs before its first command in this family. */
  readonly note: string;
  readonly rows: ReadonlyArray<CommandRow>;
};

const TASK_LINKAGE = TASKS_ENABLED ? `,"task":{"target":"<tasksId>","id":"<taskId>"}` : "";

export const COMMAND_FAMILIES: Readonly<Record<CommandFamily, FamilySpec>> = {
  tasks: {
    label: "tasks",
    docsKind: "task",
    note:
      "Claim only unclaimed tasks. `completed` is refused without evidence and an answer to every rule; the rejection names what is missing.",
    rows: [
      { port: "tasks.list", intent: "list queue", command: (t) => `junto tasks list '{"target":"${t}"}'` },
      { port: "tasks.list", intent: "read task + review subject", command: (t) => `junto tasks show '{"target":"${t}","task":"<taskId>"}'` },
      {
        port: "tasks.list",
        intent: "wait for task state",
        command: (t) => `junto tasks wait <taskId> --target ${t} --until completed --timeout 30s`,
        detail: "configured Command Center only; also supports input-required or rejected",
      },
      { port: "tasks.create", intent: "author a task", command: (t) => `junto tasks create '{"target":"${t}","brief":"...","metadata":{"title":"...","details":"..."}}'` },
      { port: "tasks.claim", intent: "claim", command: (t) => `junto tasks claim '{"target":"${t}","task":"<taskId>"}'` },
      { port: "tasks.list", intent: "rules + readiness", command: (t) => `junto tasks rules '{"target":"${t}","task":"<taskId>"}'` },
      {
        port: "tasks.update",
        intent: "run this move's checks",
        command: (t) => `junto tasks check '{"target":"${t}","task":"<taskId>"}'`,
        detail: 'add `"next":"<board>"` when the board has more than one Next',
      },
      {
        port: "tasks.update",
        intent: "progress / settle / block task",
        command: (t) => `junto tasks update '{"target":"${t}","task":"<taskId>","state":"<state>"}'`,
        detail: "states: working, completed, failed, canceled, input-required",
      },
      {
        port: "tasks.list",
        intent: "task content",
        command: () => "junto content path|stat|materialize",
        detail: "ContentRefs attached to your tasks",
      },
    ],
  },
  msg: {
    label: "messages",
    docsKind: "agent",
    note:
      "`junto msg list` with no target reads your own inbox. Mail is typed into the recipient's input at once: never retry it, and do not acknowledge an acknowledgement.",
    rows: [
      { port: "msg.list", intent: "read target thread", command: (t) => `junto msg list '{"target":"${t}"}'` },
      {
        port: "msg.send",
        intent: "send mail",
        command: (t) => `junto msg send '{"target":"${t}","text":"..."}'`,
        detail: "a short `mail from <you>` line lands in their input at once, pointing at `junto msg read`",
      },
      { port: "msg.send", intent: "reply", command: (t) => `junto msg reply '{"target":"${t}","text":"...","inReplyTo":"<msgId>"}'` },
      {
        port: "msg.prompt",
        intent: "prompt",
        command: (t) => `junto msg send --prompt '{"target":"${t}","text":"..."}'`,
        detail: "the full text lands in their input at once, idle or mid-turn; their harness queues or steers it",
      },
      {
        port: "seat.wait",
        intent: "wait",
        command: (t) => `junto seat wait ${t} --until idle --timeout 30s`,
        detail: "also supports attention, working, or gone",
      },
      {
        port: "terminal.read",
        intent: "observe",
        command: (t) => `junto seat read ${t} --lines 40`,
        detail: "settled grid, with state, reason, confidence and generation; output activity alone is not readiness",
      },
    ],
  },
  reviews: {
    label: "reviews",
    docsKind: "agent",
    note:
      "Use the review receipt's board, task id, epoch and subjectHash exactly. A blocking verdict needs concrete findings.",
    rows: [
      {
        port: "verdict.post",
        intent: "post a verdict",
        command: () =>
          `junto verdict post '{"target":"<task-board>","subject":{"kind":"task","taskId":"<taskId>","epoch":0,"subjectHash":"<subjectHash>"},"kind":"green","findings":[]}'`,
      },
    ],
  },
  artifacts: {
    label: "artifacts",
    docsKind: "artifacts",
    note: "Artifacts never block: publish intermediate and final outputs freely.",
    rows: [
      {
        port: "artifact.publish",
        intent: "ship output",
        command: (t) => `junto artifact publish '{"target":"${t}","name":"<name>","parts":[{"kind":"text","text":"..."}]${TASK_LINKAGE}}'`,
      },
    ],
  },
  board: {
    label: "board",
    docsKind: "board",
    note: "Optional shared context, never a decision inbox. `read` is enough to clear attention.",
    rows: [
      { port: "board.list", intent: "list", command: (t) => `junto board list '{"target":"${t}"}'` },
      { port: "board.create_topic", intent: "create topic", command: (t) => `junto board topic '{"target":"${t}","title":"...","body":"..."}'` },
      { port: "board.post", intent: "post", command: (t) => `junto board post '{"target":"${t}","topicId":"<topicId>","text":"..."}'` },
      { port: "board.mark_read", intent: "mark read", command: (t) => `junto board read '{"target":"${t}","topicId":"<topicId>"}'` },
    ],
  },
  pad: {
    label: "pad",
    docsKind: "pad",
    note: "A patch may upsert shapes, edges and pin posts. Ink and images are refused, and agents never write the canvas.",
    rows: [
      { port: "pad.read", intent: "read page", command: (t) => `junto pad read '{"target":"${t}"}'` },
      { port: "pad.read", intent: "text IR", command: (t) => `junto pad digest '{"target":"${t}"}'` },
      { port: "pad.read", intent: "picture", command: (t) => `junto pad svg '{"target":"${t}"}'` },
      { port: "pad.read", intent: "focused item", command: (t) => `junto pad get '{"target":"${t}","id":"<id>"}'` },
      { port: "pad.read", intent: "look-here crop", command: (t) => `junto pad look-here '{"target":"${t}","pinId":"<pinId>"}'` },
      { port: "pad.read", intent: "pins tagging you", command: (t) => `junto pad tagged '{"target":"${t}"}'` },
      {
        port: "pad.patch",
        intent: "patch shapes",
        command: (t) =>
          `junto pad patch '{"target":"${t}","patches":[{"op":"upsert","layer":"shape","shape":{"id":"box-1","type":"box","x":0,"y":0,"w":80,"h":40,"z":0}}]}'`,
      },
    ],
  },
  sheet: {
    label: "sheet",
    docsKind: "sheet",
    note: "Read only. If a number in it is wrong, say so; do not fix it.",
    rows: [
      { port: "sheet.read", intent: "read the grid", command: (t) => `junto sheet read '{"target":"${t}"}'` },
    ],
  },
  browser: {
    label: "browser",
    docsKind: "page",
    note: "The grant is live: a page edge works in this session as soon as it appears.",
    rows: [
      { port: "browser.automate", intent: "list granted pages", command: () => "junto browser pages --json" },
      { port: "browser.automate", intent: "open a granted page", command: () => "junto browser open <node-ref> --json" },
      { port: "browser.automate", intent: "navigate", command: () => "junto browser goto" },
      { port: "browser.automate", intent: "inspect", command: () => "junto browser eval" },
      { port: "browser.automate", intent: "capture", command: () => "junto browser shot" },
    ],
  },
};

const FAMILIES = Object.keys(COMMAND_FAMILIES) as CommandFamily[];

/**
 * The rows a target holds in a family. A port whose product surface this
 * build left out teaches nothing, even when an old edge still carries it.
 */
const heldRows = (family: CommandFamily, target: ConnectedTarget): ReadonlyArray<CommandRow> =>
  COMMAND_FAMILIES[family].rows.filter(
    (row) => productPortEnabled(row.port) && target.ports?.includes(row.port) === true,
  );

/** Targets grouped by family, then by the exact rows they hold in it. */
export type CommandGroup = {
  readonly family: CommandFamily;
  readonly targets: ReadonlyArray<ConnectedTarget>;
  readonly rows: ReadonlyArray<CommandRow>;
};

/**
 * Group connected targets by the command families their held ports permit.
 * Targets share a group only when they hold the same rows: a wait-only peer
 * never borrows the commands of a peer that may also be mailed.
 */
export const commandGroupsFor = (
  targets: readonly ConnectedTarget[] | undefined,
): ReadonlyArray<CommandGroup> => {
  const out: CommandGroup[] = [];
  for (const family of FAMILIES) {
    const byRows = new Map<string, { targets: ConnectedTarget[]; rows: ReadonlyArray<CommandRow> }>();
    for (const target of targets ?? []) {
      const rows = heldRows(family, target);
      if (rows.length === 0) continue;
      const key = rows.map((row) => `${row.port}:${row.intent}`).join("|");
      const group = byRows.get(key);
      if (group) group.targets.push(target);
      else byRows.set(key, { targets: [target], rows });
    }
    for (const group of byRows.values()) out.push({ family, ...group });
  }
  return out;
};

/** Placeholder a shared command carries when it serves several targets. */
const TARGET_PLACEHOLDER = "<target>";

/** One connection group's instructions, as `junto onboard` returns them. */
export type ConnectionInstructions = {
  readonly family: string;
  /** The connected node ids these commands apply to. */
  readonly targets: ReadonlyArray<string>;
  /** Intent to command. `<target>` stands for any id in `targets`. */
  readonly commands: Readonly<Record<string, string>>;
  readonly note: string;
  /** Where the reference for this family lives. */
  readonly more: string;
};

/**
 * The commands each connection allows, compiled from held ports. One target
 * gets its own id written into the commands; several share one set with a
 * `<target>` placeholder so the output does not grow with the edge count.
 */
export const compileConnectionInstructions = (
  targets: readonly ConnectedTarget[] | undefined,
): ReadonlyArray<ConnectionInstructions> =>
  commandGroupsFor(targets).map((group) => {
    const spec = COMMAND_FAMILIES[group.family];
    const id = group.targets.length === 1 ? group.targets[0]!.id : TARGET_PLACEHOLDER;
    return {
      family: spec.label,
      targets: group.targets.map((target) => target.id),
      commands: Object.fromEntries(group.rows.map((row) => [row.intent, row.command(id)])),
      note: spec.note,
      more: `junto docs node ${spec.docsKind}`,
    };
  });

// ── Guidance ───────────────────────────────────────────────────────────────

const WORK_SOURCE_LINE = TASKS_ENABLED
  ? "Work comes from the operator, from mail addressed to this seat, and from the task boards you are connected to. Do not invent work; when nothing is addressed to you, wait."
  : "Work comes from the operator and from mail addressed to this seat. Do not invent work; when nothing is addressed to you, wait.";

/**
 * The guidance `junto onboard` leads with. A few lines, on purpose: what a
 * seat is, where work comes from, and how to report. Everything else is one
 * `junto docs` away.
 */
export const ONBOARD_GUIDANCE: ReadonlyArray<string> = [
  "You are a seat on a Junto canvas, a workspace the operator draws. Edges are your permissions: you may act only on the nodes under `connected`, with the commands under `instructions`.",
  WORK_SOURCE_LINE,
  "Report through `junto feedback \"...\"` (ready for review), `junto blocked \"...\"` (cannot continue; stop and wait) and `junto escalate \"...\"` (needs attention; keep working). The operator reads that feed, not your terminal.",
  "When findings are ready but work remains, post `junto feedback` and keep working.",
  "Errors are ground truth: read `type` and `next_step`, and retry only when `retryable` is true.",
  "End a session with `junto offboard \"<notes>\"`, run last: the moment it returns your seat has moved on to a fresh session, and this one receives nothing more. Reference for everything else: `junto docs`, `junto schema show <command>`, `junto examples show <command>`.",
];

/** Present only when the operator wrote a soul or standing instructions. */
export const SEAT_GUIDANCE_LINE =
  "`seat.soul` and `seat.instructions` are the operator's words for this seat: who you are here, and your standing instructions. Follow them. If one conflicts with an error or a missing grant, say so with `junto escalate`.";

/** Guidance for one seat: the base lines, plus the seat line when it applies. */
export const onboardGuidanceFor = (seat: {
  readonly soul?: string;
  readonly instructions?: string;
} | undefined): ReadonlyArray<string> =>
  seat?.soul?.trim() || seat?.instructions?.trim()
    ? [...ONBOARD_GUIDANCE, SEAT_GUIDANCE_LINE]
    : ONBOARD_GUIDANCE;
