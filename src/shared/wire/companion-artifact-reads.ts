/**
 * The phone's artifact reads, as wire shapes (0.11.3, docs/artifacts-proposal.md
 * section 3): the args and results of the ops that list the canvas's Artifacts
 * nodes and their artifacts, read one, and name the Inbox. `companion-protocol.ts`
 * imports them and names the ops; the projections that build them live beside
 * the desktop's own reads (`companion-artifact-reads.ts` here, `artifact-reads.ts`
 * in the companion's main).
 *
 * The phone speaks the desktop's own model: the same ids, labels, colours and
 * artifact head, never a dialect.
 *
 * A wire module: its import closure is `effect` and its siblings alone.
 */

import { Schema } from "effect";
import { Artifact, ArtifactBody, ArtifactOp, ArtifactType, ArtifactVersion } from "./artifact";
import { ArtifactLabel, ArtifactLabelColour, ArtifactLabels } from "./artifact-labels";
import { ContentRef } from "./content-ref";
import { ItemId, NodeId, OpId } from "./ids";
import { FeedRegion } from "./operator-feed";
import { ResourceActor } from "./resource-actor";

const bounded = (min: number, max: number) =>
  Schema.String.pipe(Schema.check(Schema.isMinLength(min)), Schema.check(Schema.isMaxLength(max)));

/** A canvas name, as the companion protocol spells one. */
const CanvasName = bounded(1, 256);
/** How many artifacts a node holds: a count, never negative. */
const Count = Schema.Int.pipe(Schema.check(Schema.isGreaterThanOrEqualTo(0)));

// --- artifacts.nodes ----------------------------------------------------------

/** Artifacts nodes one `artifacts.nodes` carries at most; a canvas that holds more is cut here. */
export const COMPANION_ARTIFACT_NODES_MAX = 200;

export const CompanionArtifactsNodesArgs = Schema.Struct({ canvasName: CanvasName });

/**
 * One Artifacts node of the canvas: its title and region as the feed draws
 * them, how many of its artifacts are live (`live`) and how many archived
 * (`archived`), counted apart, and the colours its labels carry. A label with no
 * colour is absent.
 */
export const CompanionArtifactNode = Schema.Struct({
  nodeId: NodeId,
  title: bounded(1, 200),
  region: FeedRegion,
  live: Count,
  archived: Count,
  labelColours: Schema.Record(ArtifactLabel, ArtifactLabelColour),
});
export type CompanionArtifactNode = typeof CompanionArtifactNode.Type;

export const CompanionArtifactsNodesResult = Schema.Struct({
  nodes: Schema.Array(CompanionArtifactNode).pipe(Schema.check(Schema.isMaxLength(COMPANION_ARTIFACT_NODES_MAX))),
  /**
   * The Artifacts node this Mac's quick capture lands in (its own Inbox
   * setting, the one the desktop's Cmd+T reads), only while it is still one of
   * `nodes`. Absent: no Inbox is set here, or the set one is gone.
   */
  inboxNodeId: Schema.optionalKey(NodeId),
});
export type CompanionArtifactsNodesResult = typeof CompanionArtifactsNodesResult.Type;

// --- inbox.set ------------------------------------------------------------------

/** Name the Inbox: an Artifacts node of the canvas. The phone cannot make a node. */
export const CompanionInboxSetArgs = Schema.Struct({ canvasName: CanvasName, nodeId: NodeId });

export const CompanionInboxSetResult = Schema.Struct({ inboxNodeId: NodeId });
export type CompanionInboxSetResult = typeof CompanionInboxSetResult.Type;

// --- artifacts.list -------------------------------------------------------------

/** Artifacts one `artifacts.list` carries by default, and at most. */
export const COMPANION_ARTIFACTS_LIST_DEFAULT = 50;
export const COMPANION_ARTIFACTS_LIST_MAX = 200;
/** A row's snippet: the first characters of the artifact's text. */
export const COMPANION_ARTIFACT_SNIPPET_MAX = 200;
/** Encoded bytes one `artifacts.list` fits, below the frame bound; rows past it wait for `next`. */
export const COMPANION_ARTIFACTS_LIST_BUDGET_BYTES = 384 * 1024;
/** The longest typed search. */
export const COMPANION_ARTIFACTS_QUERY_MAX = 256;

/** A page cursor, opaque to the phone: it hands back what the Mac gave it. */
const Cursor = bounded(1, 256);

export const CompanionArtifactsListArgs = Schema.Struct({
  canvasName: CanvasName,
  /** One Artifacts node; absent, the whole canvas (browse and quick add). */
  nodeId: Schema.optionalKey(NodeId),
  type: Schema.optionalKey(ArtifactType),
  /** Every label must match, each by equality or by sitting under it (`a` matches `a/b`). */
  labels: Schema.optionalKey(Schema.Array(ArtifactLabel).pipe(Schema.check(Schema.isMaxLength(20)))),
  /** Archived artifacts instead of live ones; default live. */
  archived: Schema.optionalKey(Schema.Boolean),
  /**
   * The quick-capture search: the title first, then the type, the labels and a
   * document's words, ranked by the desktop's matcher. Absent, newest change first.
   */
  query: Schema.optionalKey(bounded(1, COMPANION_ARTIFACTS_QUERY_MAX)),
  limit: Schema.optionalKey(
    Schema.Int.pipe(Schema.check(Schema.isBetween({ minimum: 1, maximum: COMPANION_ARTIFACTS_LIST_MAX }))),
  ),
  /** The `next` of the page before; absent, the first page. */
  before: Schema.optionalKey(Cursor),
});

/** An artifact as listed: its head without the body, a snippet of the text and the pending mark. */
export const CompanionArtifactListItem = Schema.Struct({
  artifactId: ItemId,
  nodeId: NodeId,
  type: ArtifactType,
  title: bounded(1, 200),
  version: ArtifactVersion,
  updatedAt: Schema.Int,
  archived: Schema.Boolean,
  labels: ArtifactLabels,
  /** The first `COMPANION_ARTIFACT_SNIPPET_MAX` characters of the text; absent while the body is not here yet. */
  snippet: Schema.optionalKey(Schema.String.pipe(Schema.check(Schema.isMaxLength(COMPANION_ARTIFACT_SNIPPET_MAX)))),
  /** One of this Mac's queued writes touches it (it waits for the editing machine). */
  pending: Schema.optionalKey(Schema.Literal(true)),
});
export type CompanionArtifactListItem = typeof CompanionArtifactListItem.Type;

export const CompanionArtifactsListResult = Schema.Struct({
  artifacts: Schema.Array(CompanionArtifactListItem).pipe(Schema.check(Schema.isMaxLength(COMPANION_ARTIFACTS_LIST_MAX))),
  /** More matched than this page carries; `next` resumes after the last row sent. */
  more: Schema.Boolean,
  next: Schema.optionalKey(Cursor),
});
export type CompanionArtifactsListResult = typeof CompanionArtifactsListResult.Type;

// --- artifact.get ---------------------------------------------------------------

/**
 * Encoded bytes of a whole `artifact.get` result that may carry the body
 * inline: below the 512 KiB frame (`COMPANION_MAX_OUTBOUND_BYTES`) with room
 * for its envelope. A body is counted as it encodes: JSON escaping and UTF-8
 * make 512,000 characters of text pass the frame, so characters never decide.
 */
export const COMPANION_ARTIFACT_GET_BUDGET_BYTES = 480 * 1024;

export const CompanionArtifactGetArgs = Schema.Struct({
  canvasName: CanvasName,
  artifactId: ItemId,
  /** An older version's body; absent, the head. */
  version: Schema.optionalKey(ArtifactVersion),
});

export const CompanionArtifactGetResult = Schema.Struct({
  /** The head record, whichever version `version` names. */
  artifact: Artifact,
  /** The version whose body this is: the head, or the one asked for. */
  version: ArtifactVersion,
  /** That version's body by content ref: always present; `content.get` reads it. */
  bodyRef: ContentRef,
  /** The body itself, only when the whole result fits `COMPANION_ARTIFACT_GET_BUDGET_BYTES`; absent, read `bodyRef`. */
  body: Schema.optionalKey(ArtifactBody),
  /** The colours of the labels this artifact carries that its node has set. */
  labelColours: Schema.optionalKey(Schema.Record(ArtifactLabel, ArtifactLabelColour)),
  /** One of this Mac's queued writes touches it. */
  pending: Schema.optionalKey(Schema.Literal(true)),
});
export type CompanionArtifactGetResult = typeof CompanionArtifactGetResult.Type;

// --- artifact.history -----------------------------------------------------------

/** Versions one `artifact.history` carries by default, and at most. */
export const COMPANION_ARTIFACT_HISTORY_DEFAULT = 50;
export const COMPANION_ARTIFACT_HISTORY_MAX = 200;
/** Moves one result names at most: the newest. */
export const COMPANION_ARTIFACT_MOVES_MAX = 200;

export const CompanionArtifactHistoryArgs = Schema.Struct({
  canvasName: CanvasName,
  artifactId: ItemId,
  /** Only versions older than this one: the last version the page before listed. */
  before: Schema.optionalKey(ArtifactVersion),
  limit: Schema.optionalKey(
    Schema.Int.pipe(Schema.check(Schema.isBetween({ minimum: 1, maximum: COMPANION_ARTIFACT_HISTORY_MAX }))),
  ),
});

/**
 * What a version did: `create` is version 1, `replace` swapped the whole body,
 * `patch` changed part of it, `unrecorded` arrived without its edit (its body
 * is whole and no later edit rebases across it).
 */
export const CompanionArtifactChange = Schema.Literals(["create", "replace", "patch", "unrecorded"]);
export type CompanionArtifactChange = typeof CompanionArtifactChange.Type;

export const CompanionArtifactVersion = Schema.Struct({
  version: ArtifactVersion,
  author: ResourceActor,
  at: Schema.Int,
  change: CompanionArtifactChange,
});
export type CompanionArtifactVersion = typeof CompanionArtifactVersion.Type;

/** One move of an artifact between Artifacts nodes. */
export const CompanionArtifactMove = Schema.Struct({
  from: NodeId,
  to: NodeId,
  by: ResourceActor,
  at: Schema.Int,
});
export type CompanionArtifactMove = typeof CompanionArtifactMove.Type;

export const CompanionArtifactHistoryResult = Schema.Struct({
  /** Newest first. */
  versions: Schema.Array(CompanionArtifactVersion).pipe(Schema.check(Schema.isMaxLength(COMPANION_ARTIFACT_HISTORY_MAX))),
  /** Every move, oldest first, for the phone to interleave by `at` (the newest 200 of a longer run). */
  moves: Schema.Array(CompanionArtifactMove).pipe(Schema.check(Schema.isMaxLength(COMPANION_ARTIFACT_MOVES_MAX))),
  /** Older versions remain; ask again with `before` the last version listed. */
  more: Schema.Boolean,
});
export type CompanionArtifactHistoryResult = typeof CompanionArtifactHistoryResult.Type;

// --- artifact.pending -----------------------------------------------------------

/** Queued writes one `artifact.pending` carries at most, in queue order. */
export const COMPANION_ARTIFACT_PENDING_MAX = 200;

export const CompanionArtifactPendingArgs = Schema.Struct({ canvasName: CanvasName, nodeId: NodeId });

/**
 * One of this Mac's writes to the node's artifacts that the machine editing
 * the canvas has not ruled yet. `wouldRefuse` is the sentence the ruler would
 * answer with as things stand; `waiting` says its base is not on this Mac yet,
 * so there is no preview. Neither: it would apply.
 */
export const CompanionArtifactPendingWrite = Schema.Struct({
  opId: OpId,
  artifactId: ItemId,
  op: ArtifactOp,
  wouldRefuse: Schema.optionalKey(bounded(1, 500)),
  waiting: Schema.optionalKey(Schema.Literal(true)),
});
export type CompanionArtifactPendingWrite = typeof CompanionArtifactPendingWrite.Type;

export const CompanionArtifactPendingResult = Schema.Struct({
  writes: Schema.Array(CompanionArtifactPendingWrite).pipe(Schema.check(Schema.isMaxLength(COMPANION_ARTIFACT_PENDING_MAX))),
});
export type CompanionArtifactPendingResult = typeof CompanionArtifactPendingResult.Type;

// --- artifact.moveCheck ---------------------------------------------------------

/** Artifacts one `artifact.moveCheck` names at most, as one move does. */
export const COMPANION_ARTIFACT_MOVE_MAX = 100;

export const CompanionArtifactMoveCheckArgs = Schema.Struct({
  canvasName: CanvasName,
  artifactIds: Schema.Array(ItemId).pipe(
    Schema.check(Schema.isMinLength(1)),
    Schema.check(Schema.isMaxLength(COMPANION_ARTIFACT_MOVE_MAX)),
  ),
  /** The Artifacts node they would move to. */
  to: NodeId,
});

export const CompanionArtifactMoveCheckResult = Schema.Struct({
  /** The sentence the desktop shows when a move changes which seats reach these artifacts; absent when none does. */
  warning: Schema.optionalKey(bounded(1, 1_000)),
});
export type CompanionArtifactMoveCheckResult = typeof CompanionArtifactMoveCheckResult.Type;
