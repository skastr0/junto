import { Schema } from "effect";
import { ulid } from "ulid";
import { ActorSeatId } from "./actor-seat";
import { InstallationId } from "./installation-id";
import { NodeId } from "./physics/schema";
import type { WorkErrorBody, WorkErrorType } from "./work-control";
import { ItemId, OpId } from "./work-ids";

/**
 * A resource write as a command, and the editing machine's ruling on it
 * (docs/plans/0.10/02-universal-resources.md). Every write to a task,
 * artifact, thread or automation goes through `ResourceCommand`. The machine
 * that edits the canvas is the only one that rules; every other machine
 * writes the command as its own row and reads its result as pending until the
 * ruling arrives. The same pure `rule` serves the editing machine and the
 * pending overlay, so a local check and a ruling never disagree on the rule,
 * only on the state they see.
 *
 * Pure: no I/O, no clock beyond minting ids. Domains (04 tasks, 05 artifacts,
 * 03 threads, 07 automations) supply a `ResourceDomain`; this module owns the
 * envelope, idempotence, the `after` cascade and the overlay.
 */

/** Ids are cli's (`work-ids.ts`): one `OpId` and one `ItemId` across the CLI, main and the phone. */
export { ItemId, OpId } from "./work-ids";
export const mintOpId = (): OpId => OpId.make(ulid());
export const mintItemId = (): ItemId => ItemId.make(ulid());

export const ResourceKind = Schema.Literals(["task", "artifact", "thread", "automation"]);
export type ResourceKind = typeof ResourceKind.Type;

/** What a command acts on: the resource node, and the item inside it when there is one. */
export const ResourceRef = Schema.Struct({ kind: ResourceKind, nodeId: NodeId, itemId: Schema.optionalKey(ItemId) });
export type ResourceRef = typeof ResourceRef.Type;

/**
 * Who a command is from. A seat's command is written by the machine the seat
 * is on; the operator's and an automation's only by the editing machine
 * (`writtenOn`). A command from anywhere else is not refused: it closes the
 * link, as a forged mail author does.
 */
export const ResourceActor = Schema.Union([
  /** The same author mail carries, so a command row is judged on the placement history mail is (`authorOf`, work-exchange.ts). */
  Schema.Struct({ kind: Schema.Literal("seat"), seatId: ActorSeatId, nodeId: NodeId }),
  Schema.Struct({ kind: Schema.Literal("operator") }),
  Schema.Struct({ kind: Schema.Literal("automation"), nodeId: NodeId, automationId: ItemId }),
]);
export type ResourceActor = typeof ResourceActor.Type;

export type CommandWriter = "seat-machine" | "editing-machine";
export const writtenOn = (actor: ResourceActor): CommandWriter => {
  switch (actor.kind) {
    case "seat":
      return "seat-machine";
    case "operator":
    case "automation":
      return "editing-machine";
  }
};

/** The editing machine's fact seq the writer had applied when it wrote the command. Recorded so a refusal can say what changed since; never a refusal by itself. */
export const RulingBasis = Schema.Struct({ editor: InstallationId, seq: Schema.String.pipe(Schema.check(Schema.isPattern(/^[0-9]+$/))) });
export type RulingBasis = typeof RulingBasis.Type;

const commandFields = {
  opId: OpId,
  canvasName: Schema.String.pipe(Schema.check(Schema.isMinLength(1)), Schema.check(Schema.isMaxLength(128))),
  actor: ResourceActor,
  target: ResourceRef,
  /** null when the writer had applied no ruling of this canvas yet. */
  basis: Schema.NullOr(RulingBasis),
  /** Earlier commands of the same writer this one builds on; refused with them (`depends_on_refused`). */
  after: Schema.Array(OpId),
};

/** The command envelope over one domain's closed op union. */
export const resourceCommandSchema = <Op extends Schema.Top>(op: Op) => Schema.Struct({ ...commandFields, op });

export type ResourceCommand<Op> = {
  readonly opId: OpId;
  readonly canvasName: string;
  readonly actor: ResourceActor;
  readonly target: ResourceRef;
  readonly basis: RulingBasis | null;
  readonly after: ReadonlyArray<OpId>;
  readonly op: Op;
};

/**
 * Rulings are keyed by the writer installation the command arrived from and
 * its opId, never by the opId alone: two machines can mint the same ULID, and
 * one must never read or poison the other's ruling. `/` cannot occur in an
 * installation id, so the key is unambiguous.
 */
export type CommandKey = string & { readonly CommandKey: unique symbol };
export const commandKey = (writer: InstallationId, opId: OpId): CommandKey => `${writer}/${opId}` as CommandKey;

/**
 * Why a command is refused. Closed: a domain that needs another reason mails
 * remote-lead. `REFUSAL` maps each to the CLI error family, so a new reason
 * without a mapping fails tsc.
 */
export const RefusalReason = Schema.Literals([
  "not_in_reach",
  "not_permitted",
  "unknown_target",
  "invalid_input",
  "invalid_transition",
  "already_held",
  "reviewer_is_author",
  "stale",
  "rebase_conflict",
  "depends_on_refused",
  "not_available",
  "queue_full",
]);
export type RefusalReason = typeof RefusalReason.Type;

/** `stale` and `rebase_conflict` are both `Stale`; `details.reason` tells them apart (02 Contracts). */
export const REFUSAL: { readonly [R in RefusalReason]: { readonly type: WorkErrorType; readonly retryable: boolean } } = {
  not_in_reach: { type: "ScopeError", retryable: false },
  /** In reach, but a rule above reach withholds it, such as automation writes being the operator's or an overseer's. */
  not_permitted: { type: "ScopeError", retryable: false },
  unknown_target: { type: "UnknownTarget", retryable: false },
  invalid_input: { type: "InputError", retryable: false },
  invalid_transition: { type: "InvalidTransition", retryable: false },
  already_held: { type: "ClaimConflict", retryable: false },
  reviewer_is_author: { type: "ReviewerIsAuthor", retryable: false },
  stale: { type: "Stale", retryable: true },
  rebase_conflict: { type: "Stale", retryable: true },
  depends_on_refused: { type: "InvalidTransition", retryable: false },
  not_available: { type: "InputError", retryable: false },
  queue_full: { type: "RuntimeDown", retryable: true },
};

export type Refusal = {
  readonly reason: RefusalReason;
  readonly message: string;
  readonly expected?: unknown;
  readonly next_step?: string;
};

export const refusalError = (refusal: Refusal, root?: OpId): WorkErrorBody => {
  const { type, retryable } = REFUSAL[refusal.reason];
  return {
    type,
    message: refusal.message,
    details: {
      reason: refusal.reason,
      retryable,
      ...(refusal.expected === undefined ? {} : { expected: refusal.expected }),
      ...(refusal.next_step === undefined ? {} : { next_step: refusal.next_step }),
      ...(root === undefined ? {} : { from: root }),
    },
  };
};

/** A domain's answer to one command against one state. */
export type DomainVerdict<Fact> =
  | { readonly kind: "apply"; readonly facts: readonly [Fact, ...Fact[]] }
  | { readonly kind: "refuse"; readonly refusal: Refusal };

/**
 * What a resource domain supplies. `rule` is the only place its invariants
 * live; it runs on the editing machine to rule and on the writing machine to
 * check and to build the overlay. `apply` folds a ruled fact into state.
 * Reach (01) is checked here, before `rule`, through the context, unless
 * `reachExempt` says something else admits the command: a task's assignee
 * keeps moving its own open task after it leaves the task's region (01 rule 6).
 */
export type ResourceDomain<State, Op, Fact> = {
  readonly kind: ResourceKind;
  readonly rule: (state: State, command: ResourceCommand<Op>) => DomainVerdict<Fact>;
  readonly apply: (state: State, fact: Fact) => State;
  readonly reachExempt?: (state: State, command: ResourceCommand<Op>) => boolean;
};

export type RulingContext = {
  /** Region reach (01) for this actor and target at this ruling. Operator and automation actors are checked too: an automation reaches its region and below. */
  readonly inReach: (actor: ResourceActor, target: ResourceRef) => boolean;
};

export type ResourceRuling<Fact> =
  | { readonly kind: "applied"; readonly opId: OpId; readonly facts: readonly [Fact, ...Fact[]] }
  | { readonly kind: "refused"; readonly opId: OpId; readonly error: WorkErrorBody; readonly root: OpId };

/** The ruler's state for one canvas: resource state and every ruling so far. Immutable; each ruling returns a new one. */
export type Ruled<State, Fact> = {
  readonly state: State;
  readonly rulings: ReadonlyMap<CommandKey, ResourceRuling<Fact>>;
};

export const emptyRuled = <State, Fact>(state: State): Ruled<State, Fact> => ({ state, rulings: new Map() });

/**
 * Rule one command. Idempotent: a key already ruled returns the first ruling
 * and changes nothing. A command whose `after` reaches a refused command of
 * the same writer is refused `depends_on_refused` naming the root. Otherwise
 * reach, then the domain. Callers rule one command at a time per canvas; the
 * order they call in is the order (first ruled wins).
 */
export const rule = <State, Op, Fact>(
  domain: ResourceDomain<State, Op, Fact>,
  ruled: Ruled<State, Fact>,
  writer: InstallationId,
  command: ResourceCommand<Op>,
  context: RulingContext,
): { readonly ruled: Ruled<State, Fact>; readonly ruling: ResourceRuling<Fact> } => {
  const key = commandKey(writer, command.opId);
  const prior = ruled.rulings.get(key);
  if (prior !== undefined) return { ruled, ruling: prior };
  const record = (ruling: ResourceRuling<Fact>, state: State) => ({
    ruled: { state, rulings: new Map(ruled.rulings).set(key, ruling) },
    ruling,
  });
  for (const earlier of command.after) {
    const dependency = ruled.rulings.get(commandKey(writer, earlier));
    if (dependency?.kind === "refused") {
      const refusal: Refusal = {
        reason: "depends_on_refused",
        message: `This builds on ${earlier}, which was refused`,
        next_step: `Read the refusal of ${dependency.root} with junto op show ${dependency.root}`,
      };
      return record({ kind: "refused", opId: command.opId, error: refusalError(refusal, dependency.root), root: dependency.root }, ruled.state);
    }
  }
  const admitted = context.inReach(command.actor, command.target) || domain.reachExempt?.(ruled.state, command) === true;
  const verdict: DomainVerdict<Fact> = admitted
    ? domain.rule(ruled.state, command)
    : { kind: "refuse", refusal: { reason: "not_in_reach", message: "The resource is not in this actor's reach" } };
  if (verdict.kind === "refuse") {
    return record({ kind: "refused", opId: command.opId, error: refusalError(verdict.refusal), root: command.opId }, ruled.state);
  }
  return record({ kind: "applied", opId: command.opId, facts: verdict.facts }, verdict.facts.reduce(domain.apply, ruled.state));
};

/** The earlier pending commands a new command builds on: those of this writer that touch the same item, or the same node when it names no item. */
export const afterOf = <Op>(pending: ReadonlyArray<ResourceCommand<Op>>, target: ResourceRef): ReadonlyArray<OpId> =>
  pending
    .filter(({ target: earlier }) =>
      earlier.kind === target.kind && earlier.nodeId === target.nodeId && (target.itemId === undefined || earlier.itemId === undefined || earlier.itemId === target.itemId))
    .map(({ opId }) => opId);

/**
 * Why a writer cannot preview a command yet: the ruled state it would apply to
 * is behind a ruling whose body this machine has not pulled (an artifact edit
 * rides by content reference). The editing machine rules it on real state.
 */
export type OverlayWait = "base_not_pulled";

/**
 * One of the writer's unruled commands as the overlay reads it. `pending`:
 * applies on the ruled state as it stands now. `at_risk` with a refusal: would
 * be refused now; the ruling decides. `at_risk` waiting: its base is not
 * complete here, so no preview is computed; `root` is the command whose base
 * it waits on, itself or one its `after` chain reaches.
 */
export type PendingEntry =
  | { readonly opId: OpId; readonly status: "pending"; readonly refusal?: never; readonly waiting?: never }
  | { readonly opId: OpId; readonly status: "at_risk"; readonly refusal: Refusal; readonly waiting?: never }
  | { readonly opId: OpId; readonly status: "at_risk"; readonly waiting: OverlayWait; readonly root: OpId; readonly refusal?: never };

/**
 * What the overlay asks besides reach: whether the ruled state a command's
 * target sits in is complete on this machine. Left out, every base is.
 */
export type OverlayContext = RulingContext & {
  readonly baseComplete?: (target: ResourceRef) => boolean;
};

/**
 * What the writing machine reads: last ruled state plus its own commands that
 * have no ruling yet, in seq order, through the same `rule`. Computed at read
 * time; never a row, never state. A command the ruled state would now refuse
 * stays listed as `at_risk` and is left out of the state, as are the commands
 * that build on it. A command whose base is not complete here is listed
 * `at_risk` waiting, with no preview on the stale state, and so is every
 * command whose `after` chain reaches it.
 */
export const overlay = <State, Op, Fact>(
  domain: ResourceDomain<State, Op, Fact>,
  ruled: Ruled<State, Fact>,
  writer: InstallationId,
  queued: ReadonlyArray<ResourceCommand<Op>>,
  context: OverlayContext,
): { readonly state: State; readonly pending: ReadonlyArray<PendingEntry> } => {
  let view: Ruled<State, Fact> = ruled;
  const pending: PendingEntry[] = [];
  const waiting = new Map<OpId, OpId>();
  for (const command of queued) {
    if (ruled.rulings.has(commandKey(writer, command.opId))) continue;
    const behind = command.after.find((earlier) => waiting.has(earlier));
    const root = behind !== undefined ? waiting.get(behind)! : context.baseComplete?.(command.target) === false ? command.opId : undefined;
    if (root !== undefined) {
      waiting.set(command.opId, root);
      pending.push({ opId: command.opId, status: "at_risk", waiting: "base_not_pulled", root });
      continue;
    }
    const next = rule(domain, view, writer, command, context);
    view = next.ruled;
    if (next.ruling.kind === "applied") {
      pending.push({ opId: command.opId, status: "pending" });
    } else {
      const reason = next.ruling.error.details?.reason;
      pending.push({
        opId: command.opId,
        status: "at_risk",
        refusal: { reason: Schema.is(RefusalReason)(reason) ? reason : "invalid_transition", message: next.ruling.error.message },
      });
    }
  }
  return { state: view.state, pending };
};

/** What a write returns to its caller. `queued` is a success: the command is durable and will be ruled. */
export type SubmitOutcome<Fact> =
  | { readonly kind: "applied"; readonly opId: OpId; readonly facts: readonly [Fact, ...Fact[]] }
  | { readonly kind: "refused"; readonly opId: OpId; readonly error: WorkErrorBody }
  | { readonly kind: "queued"; readonly opId: OpId };

/** How long a write waits for its ruling while a link to the editing machine is open (02). With no link it does not wait. */
export const RULING_WAIT_MS = 2_000;
/** One command row, at most; larger text and every body travel as content refs (02, Bounded). */
export const COMMAND_ROW_MAX_BYTES = 64 * 1024;
/** Unruled command rows one machine may hold for one canvas (02, Bounded). Past either, a write is refused `queue_full`. */
export const QUEUE_MAX_ROWS = 50_000;
export const QUEUE_MAX_BYTES = 256 * 1024 * 1024;
