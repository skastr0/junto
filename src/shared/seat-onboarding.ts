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
import { RESOURCE_KINDS, SEAT_KINDS, type ResourceKind } from "./region-reach";
import { SINCE_SECTIONS, type Since, type SinceRef, type SinceSectionKey } from "./seat-since";

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
      "Work the tasks assigned to you. A task is #42; finish is ruled, and a refusal names what is missing.",
    rows: [
      { port: "tasks.list", intent: "list queue", command: (t) => `junto task list --node ${t}` },
      { port: "tasks.list", intent: "my tasks", command: () => "junto task list --assignee me" },
      { port: "tasks.list", intent: "read a task and its layers", command: () => "junto task show #<n>" },
      {
        port: "tasks.list",
        intent: "wait for task state",
        command: (t) => `junto task wait <taskId> --target ${t} --until completed --timeout 30s`,
        detail: "configured Command Center only; also supports input-required or rejected",
      },
      { port: "tasks.create", intent: "author a task", command: () => `junto task create "<title>" --body "..."` },
      { port: "tasks.claim", intent: "start or hand off", command: () => "junto task start #<n>, junto task assign #<n> @<seat>" },
      { port: "tasks.list", intent: "rules + readiness", command: (t) => `junto task rules '{"target":"${t}","task":"<taskId>"}'` },
      {
        port: "tasks.update",
        intent: "run this move's checks",
        command: (t) => `junto task check '{"target":"${t}","task":"<taskId>"}'`,
        detail: 'add `"next":"<board>"` when the board has more than one Next',
      },
      {
        port: "tasks.update",
        intent: "progress, finish, ask for input",
        command: () => "junto task comment|finish|pause|resume #<n>",
        detail: "reviewers stamp with junto task stamp #<n> approve|changes",
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
      "`junto msg list` with no target reads your own inbox. Mail is typed into the recipient's input within seconds: never retry it, and do not acknowledge an acknowledgement.",
    rows: [
      { port: "msg.list", intent: "read target thread", command: (t) => `junto msg list '{"target":"${t}"}'` },
      {
        port: "msg.send",
        intent: "send mail",
        command: (t) => `junto msg send '{"target":"${t}","text":"..."}'`,
        detail: "it lands in their input whole, under a `mail from <you>` header with the reply command; mail sent together arrives as one turn",
      },
      { port: "msg.send", intent: "reply", command: (t) => `junto msg reply '{"target":"${t}","text":"...","inReplyTo":"<msgId>"}'` },
      {
        port: "msg.prompt",
        intent: "prompt",
        command: (t) => `junto msg send --prompt '{"target":"${t}","text":"..."}'`,
        detail: "the full text lands in their input at once as steering, as its own turn, idle or mid-turn. A running turn uses that harness's follow-up contract",
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
    note: "Artifacts never block: create and edit intermediate and final outputs freely. An edit names the version it read with --base.",
    rows: [
      { port: "artifact.publish", intent: "what is here", command: () => "junto artifact list" },
      {
        port: "artifact.publish",
        intent: "ship output",
        command: (t) => `junto artifact create "<title>" --type document --node ${t} --markdown "..."`,
        detail: "--task <taskId> links it to a task; link, pad, sheet and file are the other types",
      },
      { port: "artifact.publish", intent: "read, then edit", command: () => "junto artifact show <id>, junto artifact edit <id> --base <n> --markdown \"...\"" },
    ],
  },
  browser: {
    label: "browser",
    docsKind: "page",
    note: "The grant is live: a page edge works in this session as soon as it appears.",
    rows: [
      { port: "browser.automate", intent: "list granted pages", command: () => "junto browser pages" },
      { port: "browser.automate", intent: "open a granted page", command: () => "junto browser open <node-ref>" },
      { port: "browser.automate", intent: "navigate", command: () => "junto browser goto <sessionId> <url> [--tab <tab>]" },
      { port: "browser.automate", intent: "inspect", command: () => "junto browser eval <sessionId> <code> [--tab <tab>]" },
      { port: "browser.automate", intent: "capture", command: () => "junto browser shot <sessionId> [--tab <tab>]" },
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
 * The commands each connection and each resource in reach allows, compiled
 * from held ports. One target gets its own id written into the commands;
 * several share one set with a `<target>` placeholder so the output does not
 * grow with the edge count. A resource both wired and in reach counts once.
 */
export const compileConnectionInstructions = (
  targets: readonly ConnectedTarget[] | undefined,
  reach: readonly ConnectedTarget[] = [],
): ReadonlyArray<ConnectionInstructions> => {
  const wired = new Set((targets ?? []).map((target) => target.id));
  return commandGroupsFor([...(targets ?? []), ...reach.filter((target) => !wired.has(target.id))]).map((group) => {
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
};

// ── Reach ──────────────────────────────────────────────────────────────────

/**
 * Where each resource kind's items are listed: a row of its command family,
 * by intent. A kind with no list row yet points at its reference instead.
 */
const REACH_LISTING: Readonly<Record<ResourceKind, { readonly family: CommandFamily; readonly intent?: string }>> = {
  task: { family: "tasks", intent: "list queue" },
  artifacts: { family: "artifacts", intent: "what is here" },
};

/** One resource kind in a seat's reach, as `junto onboard` returns it. */
export type ReachSection = {
  readonly kind: ResourceKind;
  readonly count: number;
  /** The resource node ids, sorted. */
  readonly targets: ReadonlyArray<string>;
  /** The command that lists this kind's items. `<target>` stands for any id in `targets`. */
  readonly list: string;
};

/** Resources in reach grouped by kind, in `RESOURCE_KINDS` order; empty kinds left out. */
export const compileReach = (
  resources: ReadonlyArray<{ readonly id: string; readonly kind: ResourceKind }>,
): ReadonlyArray<ReachSection> =>
  RESOURCE_KINDS.flatMap((kind) => {
    const targets = resources.filter((resource) => resource.kind === kind).map((resource) => resource.id).sort();
    if (targets.length === 0) return [];
    const listing = REACH_LISTING[kind];
    const spec = COMMAND_FAMILIES[listing.family];
    const row = spec.rows.find((candidate) => candidate.intent === listing.intent && productPortEnabled(candidate.port));
    const id = targets.length === 1 ? targets[0]! : TARGET_PLACEHOLDER;
    return [{ kind, count: targets.length, targets, list: row ? row.command(id) : `junto docs node ${spec.docsKind}` }];
  });

// ── Co-members ─────────────────────────────────────────────────────────────

/** Seats sharing a region with this one, by name, under the innermost region they share. */
export type CoMemberGroup = { readonly region: string; readonly seats: ReadonlyArray<string> };

/** Seat co-members grouped by shared region, both sorted by name; other nodes left out. */
export const coMembersByRegion = (
  members: ReadonlyArray<{ readonly kind?: string; readonly name: string; readonly shared_region: { readonly name: string } }>,
): ReadonlyArray<CoMemberGroup> => {
  const byRegion = new Map<string, string[]>();
  for (const member of members) {
    if (!(SEAT_KINDS as ReadonlyArray<string | undefined>).includes(member.kind)) continue;
    const seats = byRegion.get(member.shared_region.name) ?? [];
    seats.push(member.name);
    byRegion.set(member.shared_region.name, seats);
  }
  return [...byRegion]
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([region, seats]) => ({ region, seats: seats.sort((a, b) => a.localeCompare(b)) }));
};

/** The seat tools onboard lists: those its guidance does not already teach. */
export const toolsBeyondGuidance = <T extends { readonly command: string }>(
  tools: ReadonlyArray<T>,
  guidance: ReadonlyArray<string>,
): ReadonlyArray<T> => tools.filter((tool) => !guidance.some((line) => line.includes(`\`${tool.command}`)));

// ── Since your last session ────────────────────────────────────────────────

/** The id a since line points at, said after its sentence. */
const sinceRefWords = (ref: SinceRef): string => {
  switch (ref.kind) {
    case "mail":
      return `[mail ${ref.messageId}]`;
    case "signal":
      return `[signal ${ref.signalId}]`;
    default:
      return ref satisfies never;
  }
};

/** Section keys as onboard and `junto since` print them. */
const SINCE_KEYS = {
  owedReplies: "owed_replies",
  awaitingReplies: "awaiting_replies",
  openSignals: "open_signals",
  answersSince: "answers_since",
} as const satisfies Readonly<Record<SinceSectionKey, string>>;

/** One printed section: a sentence and an id per line, and how to list the rest. */
export type SinceSectionView = {
  readonly lines: ReadonlyArray<string>;
  readonly more?: number;
  readonly list?: string;
};

/** Since your last session as onboard and `junto since` print it. */
export type SinceView = {
  readonly as_of: string;
  readonly unread: number;
} & { readonly [K in SinceSectionKey as (typeof SINCE_KEYS)[K]]?: SinceSectionView };

/**
 * Print a since projection: the time it is as of, the unread count, and each
 * section that has anything, as `"<sentence> [mail <id>]"` lines. A section
 * with nothing in it is left out.
 */
export const renderSince = (since: Since): SinceView => {
  const sections: { -readonly [K in keyof SinceView]?: SinceView[K] } = {};
  for (const key of SINCE_SECTIONS) {
    const section = since[key];
    if (section.lines.length === 0 && section.more === 0) continue;
    sections[SINCE_KEYS[key]] = {
      lines: section.lines.map((line) => `${line.text} ${sinceRefWords(line.ref)}`),
      ...(section.more > 0 ? { more: section.more, list: section.command } : {}),
    };
  }
  return { as_of: new Date(since.asOf).toISOString(), unread: since.unread, ...sections };
};

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
  "You are a seat on a Junto canvas, a workspace the operator draws. Your region is your reach: the resources under `reach` are there for you to use, and edges join you to the seats under `connected`. Run only the commands under `commands`. Mail a seat by its name or its node id.",
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
