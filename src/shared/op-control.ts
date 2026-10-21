/**
 * `junto op show` and `junto op list` (plan 02, "Refusal and rollback"): what
 * became of a resource write, read by its opId. A write is queued until the
 * editing machine rules it, then applied or refused for good; a repeated
 * opId reads the first ruling.
 */
import { Result, Schema } from "effect";
import { refusalErrorOf, type RulingResult } from "./command-row";
import type { ItemId, OverlayWait, PendingEntry, Refusal, ResourceRef } from "./resource-command";
import { WorkErrorBody } from "./work-control";
import { OpId } from "./work-ids";

const strict = { parseOptions: { onExcessProperty: "error" as const } };

export const OP_LIST_MAX = 200;

export const OpShowArgs = Schema.Struct({ opId: OpId }).annotate(strict);
export type OpShowArgs = typeof OpShowArgs.Type;

export const OpListState = Schema.Literals(["queued", "refused"]);
export type OpListState = typeof OpListState.Type;

export const OpListArgs = Schema.Struct({
  state: Schema.optionalKey(OpListState),
  /** Only writes older than this opId: the last one a page listed, to read the next page. */
  before: Schema.optionalKey(OpId),
  limit: Schema.optionalKey(Schema.Int.pipe(Schema.check(Schema.isBetween({ minimum: 1, maximum: OP_LIST_MAX })))),
}).annotate(strict);
export type OpListArgs = typeof OpListArgs.Type;

/**
 * One write as `op show` prints it. `made` is the domain's record of what an
 * applied write made (a task's id, an artifact's id and version); `root` is
 * the opId whose refusal refused this one, itself when it was refused on its
 * own merits.
 */
/**
 * What the writing machine reads of a queued write over its last ruled state
 * (read-your-writes, 02): `pending` applies as things stand; `at_risk` with a
 * refusal would be refused now; `at_risk` waiting has no preview, its base is
 * not pulled here. Computed at read time, local only, never a row. Absent for
 * a write whose domain has no overlay reader in this build.
 */
export type OpOverlay = PendingEntry extends infer Entry ? (Entry extends PendingEntry ? Omit<Entry, "opId"> : never) : never;

/**
 * How `task list|show` and `artifact list|show` mark an item that one of
 * this machine's queued writes touches (read-your-writes, 02): `pending`, and
 * `atRisk` with the first of those writes, in queue order, that the overlay
 * reads at risk: refused as things stand, or waiting on a base not pulled
 * here. Absent on an item no queued write touches.
 */
export type PendingMark = {
  readonly pending: true;
  readonly atRisk?:
    | { readonly opId: OpId; readonly refusal: Refusal }
    | { readonly opId: OpId; readonly waiting: OverlayWait; readonly root: OpId };
};

/** The mark of each item of `kind` this machine's queued `commands` touch, from their `overlays`. */
export const pendingMarks = (
  commands: ReadonlyArray<{ readonly opId: OpId; readonly target: ResourceRef }>,
  overlays: ReadonlyMap<OpId, OpOverlay>,
  kind: ResourceRef["kind"],
): ReadonlyMap<ItemId, PendingMark> => {
  const marks = new Map<ItemId, PendingMark>();
  for (const { opId, target } of commands) {
    if (target.kind !== kind || target.itemId === undefined) continue;
    const held = marks.get(target.itemId);
    if (held?.atRisk !== undefined) continue;
    const overlay = overlays.get(opId);
    const atRisk = overlay?.status !== "at_risk"
      ? undefined
      : overlay.waiting !== undefined
        ? { opId, waiting: overlay.waiting, root: overlay.root }
        : { opId, refusal: overlay.refusal };
    marks.set(target.itemId, atRisk === undefined ? { pending: true } : { pending: true, atRisk });
  }
  return marks;
};

/**
 * The marks list and show read, or undefined when this machine's queue could
 * not be read: they then answer `pendingUnknown: true` rather than fail, or
 * read a pending item as having no write queued.
 */
export type PendingMarks = ReadonlyMap<ItemId, PendingMark> | undefined;

/** What a list or show result says when its marks are unknown (`PendingMarks`). */
export type PendingUnknown = { readonly pendingUnknown?: true };

export const pendingUnknownOf = (marks: PendingMarks): PendingUnknown => (marks === undefined ? { pendingUnknown: true } : {});

/** `item` with its mark, when one of `marks` names `itemId`. */
export const withPendingMark = <T extends object>(item: T, itemId: ItemId, marks: PendingMarks): T & Partial<PendingMark> => {
  const mark = marks?.get(itemId);
  return mark === undefined ? item : { ...item, ...mark };
};

export type OpView =
  | { readonly state: "queued"; readonly opId: OpId; readonly overlay?: OpOverlay }
  | { readonly state: "applied"; readonly opId: OpId; readonly made: Readonly<Record<string, unknown>> }
  | { readonly state: "refused"; readonly opId: OpId; readonly error: WorkErrorBody; readonly root: OpId };

export type OpState = OpView["state"];

export type OpListResult = {
  readonly ops: ReadonlyArray<OpView>;
  /** True when more matched than `limit`. */
  readonly more: boolean;
};

/** A row of `resource_rulings`, as every domain writes it. */
export type StoredRulingRow = { readonly kind: string; readonly rulingJson: string };

const StoredApplied = Schema.StructWithRest(Schema.Struct({ kind: Schema.Literal("applied") }), [
  Schema.Record(Schema.String, Schema.Unknown),
]);
const StoredRefused = Schema.Struct({ kind: Schema.Literal("refused"), error: WorkErrorBody, root: OpId });

/**
 * The view of one write from its ruling, or from its queued row when it has
 * none yet. Undefined when neither exists here. A ruling that does not decode
 * fails: it is this machine's own record, so a bad one is a defect to report,
 * never a state to guess.
 */
export const opViewOf = (
  opId: OpId,
  ruling: StoredRulingRow | undefined,
  queued: boolean,
): Result.Result<OpView | undefined, string> => {
  if (ruling === undefined) return Result.succeed(queued ? { state: "queued", opId } : undefined);
  let parsed: unknown;
  try {
    parsed = JSON.parse(ruling.rulingJson);
  } catch {
    return Result.fail(`the ruling of ${opId} is not JSON`);
  }
  if (ruling.kind === "applied") {
    const applied = Schema.decodeUnknownResult(StoredApplied)(parsed);
    if (Result.isFailure(applied)) return Result.fail(`the ruling of ${opId} does not read as applied`);
    const { kind: _kind, ...made } = applied.success;
    return Result.succeed({ state: "applied", opId, made });
  }
  const refused = Schema.decodeUnknownResult(StoredRefused)(parsed);
  if (ruling.kind !== "refused" || Result.isFailure(refused)) {
    return Result.fail(`the ruling of ${opId} does not read as applied or refused`);
  }
  return Result.succeed({ state: "refused", opId, error: refused.success.error, root: refused.success.root });
};

/**
 * The view of one write from a ruling row on the exchange: the editing
 * machine's ruling, received here. It names the resource kind an applied
 * write changed, and rebuilds a refusal's error from its closed fields.
 */
export const opViewOfRuling = (ruling: RulingResult): OpView => {
  switch (ruling.operation) {
    case "ruling.applied":
      return { state: "applied", opId: ruling.opId, made: { resource: ruling.kind } };
    case "ruling.refused":
      return { state: "refused", opId: ruling.opId, error: refusalErrorOf(ruling), root: ruling.root };
  }
};

/** No write with this opId was made here: unknown, never queued. */
export const unknownOpError = (opId: OpId): WorkErrorBody => ({
  type: "UnknownTarget",
  message: `no write of this seat has opId ${opId}`,
  details: { opId, retryable: false, next_step: "junto op list shows this seat's writes and their opIds" },
});
