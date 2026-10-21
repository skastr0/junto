/**
 * The artifact resource domain (02, 05): `rule` and `apply` over the artifact
 * contract, for the ruler on the editing machine and the pending overlay on
 * the writing machine. Every artifact invariant lives in `ruleArtifactEdit`
 * and here; storage and transport are the caller's.
 */
import { Result, Schema } from "effect";
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

/** One artifact as the ruler holds it: the head, its body, and its recent edits. */
export interface ArtifactEntry {
  readonly artifact: Artifact;
  readonly body: ArtifactBody;
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
  Schema.Struct({ fact: Schema.Literal("artifact.created"), artifact: Artifact, body: ArtifactBody }),
  Schema.Struct({
    fact: Schema.Literal("artifact.edited"),
    artifactId: ItemId,
    version: ArtifactVersion,
    edit: ArtifactEdit,
    /** The full body at this version, so history is one read, no replay. */
    body: ArtifactBody,
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

// ---------------------------------------------------------------------------
// Rule

/**
 * The domain. `now` stamps facts; the ruler passes the editing machine's
 * clock, the overlay its own.
 */
export const artifactDomain = (
  now: () => number,
): ResourceDomain<ArtifactState, ArtifactOp, ArtifactFact> => ({
  kind: "artifact",
  rule: (state, command) => ruleArtifactCommand(state, command, now()),
  apply: applyArtifactFact,
});

export const ruleArtifactCommand = (
  state: ArtifactState,
  command: ResourceCommand<ArtifactOp>,
  at: number,
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
    return apply({
      fact: "artifact.created",
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
    });
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
      // Edits after the base made versions base+1..head. A base the log no
      // longer reaches gets a short list, which the edit ruler refuses stale.
      const since = entry.edits.slice(Math.max(0, op.edit.baseVersion + 1 - entry.editsFrom));
      const ruled = ruleArtifactEdit({ version: entry.artifact.version, body: entry.body }, op.edit, since);
      if (Result.isFailure(ruled)) return refuse(artifactRefusal(ruled.failure));
      return apply({
        fact: "artifact.edited",
        artifactId,
        version: ruled.success.version,
        edit: op.edit,
        body: ruled.success.body,
        author: command.actor,
        at,
      });
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
        body: fact.body,
        edits: [],
        editsFrom: fact.artifact.version + 1,
      });
    case "artifact.edited":
      return withEntry(state, fact.artifactId, (entry) => {
        const edits = [...entry.edits, fact.edit];
        const drop = Math.max(0, edits.length - ARTIFACT_REBASE_WINDOW);
        return {
          artifact: { ...entry.artifact, version: fact.version, updatedAt: fact.at },
          body: fact.body,
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
