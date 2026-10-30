/**
 * What a machine shows when it reaches no authority (plan 0.11/06, F5).
 *
 * The driver's read is the only source of consensus facts. `AuthorityRead`
 * mirrors the core's `status()` plus the driver's local apply time and the
 * waiting table; it is the contract between remote-work's driver, the window
 * and `junto authority status`. This module turns that read and the machine
 * list into the one view every surface uses, and it owns the words. Pure: no
 * clock, no store, no Effect runtime. A caller that needs a time formats
 * `lastCommitAt` or `since` and passes the formatter in.
 */
import { Schema } from "effect";
import { InstallationId } from "./installation-id";

// ---------------------------------------------------------------------------
// The read, from the consensus driver
// ---------------------------------------------------------------------------

export const AuthorityRole = Schema.Literals(["follower", "pre-candidate", "candidate", "leader"]);
export type AuthorityRole = typeof AuthorityRole.Type;

/** The operator's ordered list. `old` is set while a list edit is joint; `sole` after `alone`. */
export const AuthorityMemberList = Schema.Struct({
  list: Schema.Array(InstallationId),
  old: Schema.optionalKey(Schema.Array(InstallationId)),
  sole: Schema.optionalKey(InstallationId),
});
export type AuthorityMemberList = typeof AuthorityMemberList.Type;

const Count = Schema.Number.pipe(Schema.check(Schema.isInt()), Schema.check(Schema.isGreaterThanOrEqualTo(0)));
/** An epoch-millisecond instant: when a change was applied, or when a machine slept. */
const When = Schema.Number.pipe(Schema.check(Schema.isGreaterThanOrEqualTo(0)));

/** Entries a fork kept for the operator: never queued, applied or discarded by hand. */
export const AuthorityWaiting = Schema.Struct({
  total: Count,
  commands: Count,
  structure: Count,
});
export type AuthorityWaiting = typeof AuthorityWaiting.Type;

/**
 * One canvas as the driver reads it after applying a `ready()`.
 *
 * - `members` is the committed list; `pendingList` is the latest list entry
 *   while it is not committed (a joint edit, or `alone` not yet applied).
 * - `canCommit` is the core's own: a fresh authority that is not handing
 *   over. `fresh` is true at once when this machine is a quorum alone.
 * - `authorityReachable` says this machine can still reach the authority: on
 *   the leader when `canCommit`, on a follower when the leader was heard
 *   within the election timeout.
 * - `lastCommitAt` is this machine's local apply time, epoch milliseconds,
 *   written in the apply's transaction.
 */
export const AuthorityRead = Schema.Struct({
  canvas: Schema.String,
  self: InstallationId,
  role: AuthorityRole,
  term: Schema.Int,
  leader: Schema.NullOr(InstallationId),
  commit: Schema.Int,
  lastIndex: Schema.Int,
  members: AuthorityMemberList,
  pendingList: Schema.optionalKey(AuthorityMemberList),
  fresh: Schema.Boolean,
  canCommit: Schema.Boolean,
  lastCommitAt: Schema.NullOr(When),
  waitingForOperator: AuthorityWaiting,
  authorityReachable: Schema.Boolean,
});
export type AuthorityRead = typeof AuthorityRead.Type;

// ---------------------------------------------------------------------------
// The machine list, as the window and the status command already read it
// ---------------------------------------------------------------------------

/** How a listed machine stands from here. `here` is this machine. */
export const AuthorityReach = Schema.Literals(["here", "reachable", "asleep", "unreachable", "not-linked"]);
export type AuthorityReach = typeof AuthorityReach.Type;

export const AuthorityMachineFacts = Schema.Struct({
  installationId: InstallationId,
  /** The machine's real short name. */
  name: Schema.String,
  /** What the operator calls it, falling back to the name in the adapter. */
  label: Schema.String,
  reach: AuthorityReach,
  /** When it went to sleep, epoch milliseconds; null when unknown or not asleep. */
  since: Schema.NullOr(When),
});
export type AuthorityMachineFacts = typeof AuthorityMachineFacts.Type;

export const AuthorityMachineView = Schema.Struct({
  ...AuthorityMachineFacts.fields,
  isAuthority: Schema.Boolean,
});
export type AuthorityMachineView = typeof AuthorityMachineView.Type;

export const AuthorityPending = Schema.Struct({
  list: Schema.Array(AuthorityMachineView),
  old: Schema.optionalKey(Schema.Array(AuthorityMachineView)),
  sole: Schema.optionalKey(AuthorityMachineView),
});
export type AuthorityPending = typeof AuthorityPending.Type;

export type AuthorityView = {
  readonly canvas: string;
  readonly self: AuthorityMachineView;
  readonly term: number;
  readonly role: AuthorityRole;
  readonly authority: AuthorityMachineView | null;
  readonly authorityReachable: boolean;
  readonly canCommit: boolean;
  readonly fresh: boolean;
  readonly list: ReadonlyArray<AuthorityMachineView>;
  readonly pending: AuthorityPending | null;
  /** The newest change this machine holds, shown only while no authority is reachable. */
  readonly staleSince: number | null;
  readonly waiting: AuthorityWaiting;
};

const unknownMachine = (installationId: InstallationId, isAuthority: boolean): AuthorityMachineView => ({
  installationId,
  name: installationId,
  label: installationId,
  reach: "not-linked",
  since: null,
  isAuthority,
});

/**
 * The one view. The driver's read supplies the consensus facts; the machine
 * list supplies the names, labels and reach. A listed machine the list does
 * not know keeps its installation id and reads as not linked, never dropped.
 */
export const authorityViewOf = (
  read: AuthorityRead,
  machines: ReadonlyArray<AuthorityMachineFacts>,
): AuthorityView => {
  const byId = new Map(machines.map((machine) => [machine.installationId, machine]));
  const machineOf = (installationId: InstallationId): AuthorityMachineView => {
    const facts = byId.get(installationId);
    const isAuthority = read.leader === installationId;
    return facts === undefined
      ? unknownMachine(installationId, isAuthority)
      : { ...facts, isAuthority };
  };
  const pending = read.pendingList === undefined
    ? null
    : {
        list: read.pendingList.list.map(machineOf),
        ...(read.pendingList.old === undefined ? {} : { old: read.pendingList.old.map(machineOf) }),
        ...(read.pendingList.sole === undefined ? {} : { sole: machineOf(read.pendingList.sole) }),
      };
  return {
    canvas: read.canvas,
    self: machineOf(read.self),
    term: read.term,
    role: read.role,
    authority: read.leader === null ? null : machineOf(read.leader),
    authorityReachable: read.authorityReachable,
    canCommit: read.canCommit,
    fresh: read.fresh,
    list: read.members.list.map(machineOf),
    pending,
    staleSince: read.authorityReachable ? null : read.lastCommitAt,
    waiting: read.waitingForOperator,
  };
};

// ---------------------------------------------------------------------------
// Words
// ---------------------------------------------------------------------------

/** How a machine reads in a sentence: "Mac mini asleep since 01:12". */
export const authorityMachineLine = (
  machine: AuthorityMachineView,
  when: (at: number) => string,
): string => {
  switch (machine.reach) {
    case "here":
      return "this machine";
    case "reachable":
      return `${machine.label} reachable`;
    case "asleep":
      return machine.since === null ? `${machine.label} asleep` : `${machine.label} asleep since ${when(machine.since)}`;
    case "unreachable":
      return `${machine.label} unreachable`;
    case "not-linked":
      return `${machine.label} not linked`;
  }
};

/** The listed machines in the operator's order, each with its state. */
const machineStates = (
  view: AuthorityView,
  when: (at: number) => string,
): string => view.list.map((machine) => noAuthorityLine(machine, when)).join(", ");

/**
 * A reachable machine in a no-authority state is still not taking changes:
 * `authorityMachineLine` keeps the neutral state words the status prints.
 */
const noAuthorityLine = (
  machine: AuthorityMachineView,
  when: (at: number) => string,
): string =>
  machine.reach === "reachable"
    ? `${machine.label} reachable but not taking changes`
    : authorityMachineLine(machine, when);

/** The banner chips' joined sentence: the list's accessible name, and the live text. */
export const authorityMachineSentence = (
  view: AuthorityView,
  when: (at: number) => string,
): string => machineStates(view, when);

/**
 * One chip's state words. A chip names its machine already, so this machine
 * reads `not taking changes` rather than the sentence's `this machine`; while
 * an authority is reachable the ruling machine takes changes and every other
 * reachable one stands by.
 */
export const authorityChipWords = (
  view: AuthorityView,
  machine: AuthorityMachineView,
  when: (at: number) => string,
): string => {
  if (!view.authorityReachable) {
    return machine.reach === "here" ? "not taking changes" : noAuthorityLine(machine, when);
  }
  if (machine.isAuthority) return "takes changes";
  if (machine.reach === "reachable" || machine.reach === "here") return "stands by";
  return authorityMachineLine(machine, when);
};

const asSentence = (text: string): string => (text === "" ? text : `${text[0]!.toUpperCase()}${text.slice(1)}`);

/** How many machines a reason names before it stops; the list stays readable. */
const MAX_NAMED_MACHINES = 6;

const namedStates = (
  view: AuthorityView,
  when: (at: number) => string,
): string => {
  const lines = view.list.map((machine) => noAuthorityLine(machine, when));
  if (lines.length <= MAX_NAMED_MACHINES) return lines.join(", ");
  const rest = lines.length - MAX_NAMED_MACHINES;
  return `${lines.slice(0, MAX_NAMED_MACHINES).join(", ")} and ${rest} more`;
};

/**
 * Why a write waits, when it cannot be ruled now. Undefined while an
 * authority is reachable: that write is queued for the authority and the
 * usual wait applies.
 */
export const authorityWaitReason = (
  view: AuthorityView,
  when: (at: number) => string,
): string | undefined => {
  if (view.authorityReachable) return undefined;
  const states = namedStates(view, when);
  const because = states === "" ? "" : ` ${asSentence(states)}.`;
  return `No machine can take changes for ${view.canvas} right now. This write waits and is applied when one is back.${because}`;
};

/**
 * The compact reason a queued write carries while no machine can rule it:
 * "no authority: MacBook asleep since 01:12, Mac mini unreachable". It rides
 * the write's own queued message, so it names machines without repeating the
 * sentence the banner shows. Undefined while an authority is reachable: that
 * write waits on the authority, not on a machine coming back.
 */
export const authorityQueueReason = (
  view: AuthorityView,
  when: (at: number) => string,
): string | undefined => {
  if (view.authorityReachable) return undefined;
  const states = namedStates(view, when);
  return states === "" ? "no authority" : `no authority: ${states}`;
};

export type AuthorityBanner = {
  readonly kind: "read-only" | "waiting";
  readonly title: string;
  readonly lines: ReadonlyArray<string>;
};

/** The page-wide line for cancelled work, or the kept-change line after a fork. */
export const authorityWaitingLine = (waiting: AuthorityWaiting): string | undefined => {
  if (waiting.total === 0) return undefined;
  if (waiting.total === 1) {
    return "1 change made while another machine held authority is kept. It waits for you to apply or discard it.";
  }
  return `${waiting.total} changes made while another machine held authority are kept. They wait for you to apply or discard them.`;
};

/**
 * The banner over the canvas. `read-only` when no authority can be reached;
 * `waiting` when an authority is back but a fork left changes for the
 * operator. Undefined when there is nothing to say.
 */
export const authorityBannerOf = (
  view: AuthorityView,
  when: (at: number) => string,
): AuthorityBanner | undefined => {
  const waiting = authorityWaitingLine(view.waiting);
  if (!view.authorityReachable) {
    const lines: string[] = [];
    const states = machineStates(view, when);
    if (states !== "") lines.push(asSentence(states));
    if (view.staleSince !== null) {
      lines.push(`Reads are as of ${when(view.staleSince)}, the last change this machine heard.`);
    }
    lines.push("This window is read-only. Work from seats keeps being recorded and is applied when a machine is back.");
    if (waiting !== undefined) lines.push(waiting);
    return { kind: "read-only", title: "No machine can take changes for this canvas", lines };
  }
  if (waiting === undefined) return undefined;
  return { kind: "waiting", title: "Changes made while another machine held authority", lines: [waiting] };
};

export type AuthorityAloneWarningInput = {
  readonly canvas: string;
  /** This machine, as the operator reads it. */
  readonly self: string;
  /** The other machine of the committed pair, or null when the list does not name one. */
  readonly other: string | null;
  /** An uncommitted joint list entry is dropped by the fork. */
  readonly pending: boolean;
};

/**
 * What `junto authority alone` says before it does anything. The operator is
 * the only caller, and this is the one path to divergence; every sentence
 * says what is kept and what wins on contact.
 */
export const authorityAloneWarning = (input: AuthorityAloneWarningInput): string => {
  const other = input.other ?? "the other machine";
  const pending = input.pending
    ? " A list change that had not been applied is dropped; it never took effect."
    : "";
  return `Making ${input.self} the only machine that takes changes for ${input.canvas}. If ${other} was still taking changes too, both machines have kept their own since they stopped hearing each other, and both sets are kept. When they meet, the later one wins. Seat and automation writes from the other side go back to their queues as commands. Changes made in a window are kept and wait for you to apply or discard them, marked 'ruled while another machine held authority'.${pending} Nothing that was applied is deleted. Wake ${other} and let it hand over if you can; use alone only when it is gone.`;
};

// ---------------------------------------------------------------------------
// `junto authority status`
// ---------------------------------------------------------------------------

export const AuthorityStatusArgs = Schema.Struct({ canvas: Schema.optionalKey(Schema.String) });
export type AuthorityStatusArgs = typeof AuthorityStatusArgs.Type;

export const AuthorityCanvasStatus = Schema.Struct({
  canvas: Schema.String,
  term: Schema.Int,
  role: AuthorityRole,
  authority: Schema.NullOr(AuthorityMachineView),
  authorityReachable: Schema.Boolean,
  canCommit: Schema.Boolean,
  fresh: Schema.Boolean,
  list: Schema.Array(AuthorityMachineView),
  pending: Schema.NullOr(AuthorityPending),
  staleSince: Schema.NullOr(When),
  waiting: AuthorityWaiting,
});
export type AuthorityCanvasStatus = typeof AuthorityCanvasStatus.Type;

/**
 * What the window reads for every canvas it holds (0.11/06 F5): the driver's
 * reads and this machine's machine names, from which the one view is built.
 * Null in a build with the authority off.
 */
export const AuthorityWindowData = Schema.Struct({
  self: AuthorityMachineFacts,
  machines: Schema.Array(AuthorityMachineFacts),
  canvases: Schema.Array(AuthorityRead),
});
export type AuthorityWindowData = typeof AuthorityWindowData.Type;

export const AuthorityStatusData = Schema.Struct({
  self: AuthorityMachineFacts,
  machines: Schema.Array(AuthorityMachineFacts),
  canvases: Schema.Array(AuthorityCanvasStatus),
});
export type AuthorityStatusData = typeof AuthorityStatusData.Type;

/** The status command's data, from the same views the window shows. */
export const authorityStatusOf = (input: {
  readonly self: AuthorityMachineFacts;
  readonly machines: ReadonlyArray<AuthorityMachineFacts>;
  readonly canvases: ReadonlyArray<AuthorityRead>;
}): AuthorityStatusData => ({
  self: input.self,
  machines: input.machines,
  canvases: input.canvases.map((read): AuthorityCanvasStatus => {
    const view = authorityViewOf(read, input.machines);
    return {
      canvas: view.canvas,
      term: view.term,
      role: view.role,
      authority: view.authority,
      authorityReachable: view.authorityReachable,
      canCommit: view.canCommit,
      fresh: view.fresh,
      list: view.list,
      pending: view.pending,
      staleSince: view.staleSince,
      waiting: view.waiting,
    };
  }),
});

// ---------------------------------------------------------------------------
// `junto authority alone`
// ---------------------------------------------------------------------------

export const AuthorityAloneArgs = Schema.Struct({ canvas: Schema.String });
export type AuthorityAloneArgs = typeof AuthorityAloneArgs.Type;

/** What the driver's `alone` answers, with the warning the command printed. */
export const AuthorityAloneData = Schema.Struct({
  canvas: Schema.String,
  term: Schema.Int,
  authority: InstallationId,
  warning: Schema.String,
});
export type AuthorityAloneData = typeof AuthorityAloneData.Type;

/** The committed pair `alone` may break: exactly two machines on the committed list. */
export const authorityPairOf = (view: AuthorityView): { readonly other: AuthorityMachineView | null } => {
  if (view.list.length !== 2) return { other: null };
  return { other: view.list.find((machine) => machine.installationId !== view.self.installationId) ?? null };
};

// ---------------------------------------------------------------------------
// `junto authority list`
// ---------------------------------------------------------------------------

/**
 * The operator's ordered list of machines for a canvas, by machine name: the
 * first is the one that rules while it is reachable. The edit is a joint
 * entry, so it commits only once a quorum of the old list and the new one
 * holds it; until then the old list still rules.
 */
export const AuthorityListArgs = Schema.Struct({
  canvas: Schema.String,
  order: Schema.Array(Schema.String).pipe(
    Schema.check(Schema.isMinLength(1)),
    Schema.check(Schema.isMaxLength(32)),
    Schema.check(Schema.makeFilter((names: ReadonlyArray<string>) =>
      new Set(names).size === names.length ? undefined : "a machine appears twice in the list",
    )),
  ),
});
export type AuthorityListArgs = typeof AuthorityListArgs.Type;

/** What `junto authority list` answers: what was named, and what rules now. */
export const AuthorityListData = Schema.Struct({
  canvas: Schema.String,
  /** The machines named, in the operator's order, as this machine resolves them. */
  named: Schema.Array(AuthorityMachineFacts),
  /** The list as committed, in its order; this one rules until the joint entry commits. */
  committed: Schema.Array(AuthorityMachineView),
  /** True while the joint entry has not committed: the old list still rules. */
  pending: Schema.Boolean,
  /** Why the new list is not in force yet, when it is not. */
  waiting: Schema.optionalKey(Schema.String),
});
export type AuthorityListData = typeof AuthorityListData.Type;

/** The one sentence a pending list edit says, so every surface says the same. */
export const AUTHORITY_LIST_WAITING =
  "The new list waits for a quorum of the old list and the new one, so both machines must hold it before it rules.";

/** The list command's data, from the view after the edit was proposed. */
export const authorityListOf = (input: {
  readonly view: AuthorityView;
  readonly named: ReadonlyArray<AuthorityMachineFacts>;
}): AuthorityListData => ({
  canvas: input.view.canvas,
  named: input.named,
  committed: input.view.list,
  pending: input.view.pending !== null,
  ...(input.view.pending === null ? {} : { waiting: AUTHORITY_LIST_WAITING }),
});
