/**
 * The artifact resource domain (02, 05): `rule` and `apply` over the artifact
 * contract, for the ruler on the editing machine and the pending overlay on
 * the writing machine. Every artifact invariant lives in `ruleArtifactEdit`
 * and here; storage and transport are the caller's.
 *
 * Facts replicate inside a ruling row capped at 64 KiB (02), so a fact never
 * carries an unbounded body. Each version names its full body by content ref
 * (`bodyRef`; the bytes move on demand and history is one fetch, no replay).
 * The body itself, or the edit that made it, rides inline only while the
 * encoded fact stays under `ARTIFACT_FACT_INLINE_MAX_BYTES`. A machine that
 * folds a fact without either holds the body as not loaded (null) and loads
 * it by ref before it rules an edit on it.
 */
import { Result, Schema } from "effect";
import { ContentRef } from "./content";
import {
  Artifact,
  ArtifactBody,
  ArtifactEdit,
  type ArtifactEditError,
  type ArtifactOp,
  ArtifactVersion,
  decodeArtifactBody,
  FIRST_ARTIFACT_VERSION,
  ruleArtifactEdit,
} from "./artifact";
import type { NodeId } from "./physics/schema";
import {
  ResourceActor,
  type DomainVerdict,
  type Refusal,
  type ResourceCommand,
  type ResourceDomain,
} from "./resource-command";
import { ItemId } from "./work-ids";

/**
 * How many applied edits an entry keeps for rebasing. A patch written against
 * a base older than the log reaches is refused `stale` with the head, so main
 * loads at most this many edits per ruling (every buffer is bounded).
 */
export const ARTIFACT_REBASE_WINDOW = 64;

/** What may ride inline in one fact; the rest of the 64 KiB row is envelope. */
export const ARTIFACT_FACT_INLINE_MAX_BYTES = 48 * 1024;

/** One artifact as the ruler holds it: the head, its body, and its recent edits. */
export interface ArtifactEntry {
  readonly artifact: Artifact;
  /** The head's body; null when only its ref is known and the bytes are not loaded. */
  readonly body: ArtifactBody | null;
  /** The head's body by content ref. */
  readonly bodyRef: ContentRef;
  /** The last applied edits, oldest first; `edits[i]` made version `editsFrom + i`. */
  readonly edits: ReadonlyArray<ArtifactEdit>;
  /** The version the first kept edit made. With no edits kept, the head plus one. */
  readonly editsFrom: number;
}

export type ArtifactState = ReadonlyMap<ItemId, ArtifactEntry>;

export const emptyArtifactState = (): ArtifactState => new Map();

// ---------------------------------------------------------------------------
// Facts

export const ArtifactFact = Schema.Union([
  Schema.Struct({
    fact: Schema.Literal("artifact.created"),
    artifact: Artifact,
    bodyRef: ContentRef,
    /** Inline only while small. */
    body: Schema.optionalKey(ArtifactBody),
  }),
  Schema.Struct({
    fact: Schema.Literal("artifact.edited"),
    artifactId: ItemId,
    version: ArtifactVersion,
    /** The full body at this version. */
    bodyRef: ContentRef,
    /** The edit that made it, inline only while small. Without it a later edit cannot rebase across this one. */
    edit: Schema.optionalKey(ArtifactEdit),
    author: ResourceActor,
    at: Schema.Number,
  }),
  Schema.Struct({ fact: Schema.Literal("artifact.retitled"), artifactId: ItemId, title: Schema.String, at: Schema.Number }),
  Schema.Struct({ fact: Schema.Literal("artifact.archived"), artifactId: ItemId, archived: Schema.Boolean, at: Schema.Number }),
  Schema.Struct({ fact: Schema.Literal("artifact.tasks"), artifactId: ItemId, taskIds: Schema.Array(ItemId), at: Schema.Number }),
]);
export type ArtifactFact = typeof ArtifactFact.Type;

// ---------------------------------------------------------------------------
// Refusals

const READ_HEAD = "Read the head with junto artifact show, then edit against it";

/** An edit refusal in the ruler's closed reasons. */
export const artifactRefusal = (error: ArtifactEditError): Refusal => {
  const expected = error.expected === undefined ? {} : { expected: error.expected };
  switch (error.code) {
    case "stale":
      return { reason: "stale", message: error.message, ...expected, next_step: READ_HEAD };
    case "rebase_conflict":
      return { reason: "rebase_conflict", message: error.message, ...expected, next_step: READ_HEAD };
    case "type_mismatch":
    case "future_base":
    case "missing":
    case "duplicate_id":
    case "capacity":
    case "invalid":
      return { reason: "invalid_input", message: error.message, ...expected };
  }
};

const refuse = (refusal: Refusal): DomainVerdict<ArtifactFact> => ({ kind: "refuse", refusal });

const apply = (fact: ArtifactFact): DomainVerdict<ArtifactFact> => ({ kind: "apply", facts: [fact] });

const encodedBytes = (value: unknown): number => new TextEncoder().encode(JSON.stringify(value)).byteLength;

/** Keep `key` on the fact only while the whole fact stays under the inline cap. */
const inlineIfSmall = <F extends ArtifactFact, K extends keyof F>(fact: F, key: K): F => {
  if (encodedBytes(fact) <= ARTIFACT_FACT_INLINE_MAX_BYTES) return fact;
  const { [key]: _dropped, ...rest } = fact;
  return rest as F;
};

/**
 * How a body becomes its content ref: a digest of its canonical bytes. Main
 * stores those bytes under the ref when the fact is written; the overlay
 * only names them.
 */
export type ArtifactBodyRef = (body: ArtifactBody) => ContentRef;

// ---------------------------------------------------------------------------
// Rule

/**
 * The domain. `now` stamps facts; the ruler passes the editing machine's
 * clock, the overlay its own. `bodyRef` names a body by content.
 */
export const artifactDomain = (deps: {
  readonly now: () => number;
  readonly bodyRef: ArtifactBodyRef;
}): ResourceDomain<ArtifactState, ArtifactOp, ArtifactFact> => ({
  kind: "artifact",
  rule: (state, command) => ruleArtifactCommand(state, command, deps.now(), deps.bodyRef),
  apply: applyArtifactFact,
  // No later ruling lifts a create's refusal: its body is its own, and no
  // ruling removes an artifact that exists. Nor a target of the wrong shape.
  // An edit's refusal reads the head, which later rulings move; archived is
  // left by restore.
  definite: (refusal, { target, op }) =>
    refusal.reason === "invalid_input" && (target.kind !== "artifact" || target.itemId === undefined || op.op === "create"),
});

export const ruleArtifactCommand = (
  state: ArtifactState,
  command: ResourceCommand<ArtifactOp>,
  at: number,
  bodyRef: ArtifactBodyRef,
): DomainVerdict<ArtifactFact> => {
  const { target, op } = command;
  if (target.kind !== "artifact") {
    return refuse({ reason: "invalid_input", message: `an artifact command targets an artifact, not a ${target.kind}` });
  }
  const artifactId = target.itemId;
  if (artifactId === undefined) {
    return refuse({ reason: "invalid_input", message: "an artifact command names its artifact as target.itemId" });
  }
  const entry = state.get(artifactId);

  if (op.op === "create") {
    if (entry !== undefined) {
      return refuse({ reason: "invalid_input", message: `artifact ${artifactId} already exists` });
    }
    const body = decodeArtifactBody(op.body);
    if (Result.isFailure(body)) return refuse({ reason: "invalid_input", message: String(body.failure) });
    return apply(inlineIfSmall({
      fact: "artifact.created",
      bodyRef: bodyRef(body.success),
      artifact: {
        artifactId,
        nodeId: target.nodeId,
        type: body.success.type,
        title: op.title,
        version: FIRST_ARTIFACT_VERSION,
        createdBy: command.actor,
        updatedAt: at,
        archived: false,
        taskIds: op.taskIds ?? [],
      },
      body: body.success,
    } as const, "body"));
  }

  if (entry === undefined || entry.artifact.nodeId !== target.nodeId) {
    return refuse({ reason: "unknown_target", message: `no artifact ${artifactId} on ${target.nodeId}` });
  }

  if (entry.artifact.archived && op.op !== "restore" && op.op !== "archive") {
    return refuse({
      reason: "invalid_transition",
      message: `artifact ${artifactId} is archived`,
      next_step: "Restore it first with junto artifact restore",
    });
  }

  switch (op.op) {
    case "edit": {
      if (entry.body === null) {
        return refuse({
          reason: "not_available",
          message: `the body of artifact ${artifactId} is not loaded`,
          next_step: "Load the head's body by its bodyRef, then rule again",
        });
      }
      // Edits after the base made versions base+1..head. A base the log no
      // longer reaches gets a short list, which the edit ruler refuses stale.
      const since = entry.edits.slice(Math.max(0, op.edit.baseVersion + 1 - entry.editsFrom));
      const ruled = ruleArtifactEdit({ version: entry.artifact.version, body: entry.body }, op.edit, since);
      if (Result.isFailure(ruled)) return refuse(artifactRefusal(ruled.failure));
      return apply(inlineIfSmall({
        fact: "artifact.edited",
        artifactId,
        version: ruled.success.version,
        bodyRef: bodyRef(ruled.success.body),
        edit: op.edit,
        author: command.actor,
        at,
      } as const, "edit"));
    }
    case "retitle":
      return apply({ fact: "artifact.retitled", artifactId, title: op.title, at });
    case "archive":
      return entry.artifact.archived
        ? refuse({ reason: "invalid_transition", message: `artifact ${artifactId} is already archived` })
        : apply({ fact: "artifact.archived", artifactId, archived: true, at });
    case "restore":
      return entry.artifact.archived
        ? apply({ fact: "artifact.archived", artifactId, archived: false, at })
        : refuse({ reason: "invalid_transition", message: `artifact ${artifactId} is not archived` });
    case "tasks":
      return apply({ fact: "artifact.tasks", artifactId, taskIds: op.taskIds, at });
  }
};

// ---------------------------------------------------------------------------
// Apply

/** A log stand-in for an edit not carried inline; only its kind is ever read. */
const BARRIER: ArtifactBody = { type: "document", markdown: "" };

/**
 * The body after an applied edit, folded without the bytes travelling: a
 * replace carries its body, a patch re-applies to the known body (it was
 * ruled, so it applies). Anything else leaves the body to load by ref.
 */
export const bodyAfter = (body: ArtifactBody | null, edit: ArtifactEdit | undefined): ArtifactBody | null => {
  if (edit === undefined) return null;
  if (edit.kind === "replace") return edit.body;
  if (body === null) return null;
  const next = ruleArtifactEdit({ version: FIRST_ARTIFACT_VERSION, body }, { ...edit, baseVersion: FIRST_ARTIFACT_VERSION });
  return Result.isSuccess(next) ? next.success.body : null;
};

const withEntry = (
  state: ArtifactState,
  artifactId: ItemId,
  change: (entry: ArtifactEntry) => ArtifactEntry,
): ArtifactState => {
  const entry = state.get(artifactId);
  if (entry === undefined) return state;
  return new Map(state).set(artifactId, change(entry));
};

/** Fold one ruled fact into state. A fact for an unknown artifact changes nothing. */
export const applyArtifactFact = (state: ArtifactState, fact: ArtifactFact): ArtifactState => {
  switch (fact.fact) {
    case "artifact.created":
      return new Map(state).set(fact.artifact.artifactId, {
        artifact: fact.artifact,
        body: fact.body ?? null,
        bodyRef: fact.bodyRef,
        edits: [],
        editsFrom: fact.artifact.version + 1,
      });
    case "artifact.edited":
      return withEntry(state, fact.artifactId, (entry) => {
        // Without the edit inline, nothing may rebase across this version:
        // the log keeps a whole-body replace in its place.
        const edit: ArtifactEdit = fact.edit ?? { kind: "replace", baseVersion: entry.artifact.version, body: BARRIER };
        const edits = [...entry.edits, edit];
        const drop = Math.max(0, edits.length - ARTIFACT_REBASE_WINDOW);
        return {
          artifact: { ...entry.artifact, version: fact.version, updatedAt: fact.at },
          body: bodyAfter(entry.body, fact.edit),
          bodyRef: fact.bodyRef,
          edits: drop === 0 ? edits : edits.slice(drop),
          editsFrom: fact.version + 1 - (edits.length - drop),
        };
      });
    case "artifact.retitled":
      return withEntry(state, fact.artifactId, (entry) => ({
        ...entry,
        artifact: { ...entry.artifact, title: fact.title, updatedAt: fact.at },
      }));
    case "artifact.archived":
      return withEntry(state, fact.artifactId, (entry) => ({
        ...entry,
        artifact: { ...entry.artifact, archived: fact.archived, updatedAt: fact.at },
      }));
    case "artifact.tasks":
      return withEntry(state, fact.artifactId, (entry) => ({
        ...entry,
        artifact: { ...entry.artifact, taskIds: fact.taskIds, updatedAt: fact.at },
      }));
  }
};

/** The artifacts on one node, newest change first. */
export const artifactsOnNode = (state: ArtifactState, nodeId: NodeId): ReadonlyArray<ArtifactEntry> =>
  [...state.values()]
    .filter((entry) => entry.artifact.nodeId === nodeId)
    .sort((a, b) => b.artifact.updatedAt - a.artifact.updatedAt);
