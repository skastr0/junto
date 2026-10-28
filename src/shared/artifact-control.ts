/**
 * `junto artifact` wire contract (plan 05, cli track L3): the input each verb
 * takes on the work socket and the result it returns. The CLI mints the
 * opId, and on a create the artifact id, so a retry with `--op-id` is the
 * same command; main builds the `ResourceCommand<ArtifactOp>` and rules it.
 *
 * A seat names the Artifacts node by id, name or `junto://` ref, and may
 * leave it out when one Artifacts node is in its reach. An artifact is named
 * by its id alone: ids are ULIDs, so main finds its node.
 *
 * Pure: effect only.
 */
import { Schema } from "effect";
import {
  ARTIFACT_MAX_TITLE_LENGTH,
  type Artifact,
  ArtifactType,
  ArtifactVersion,
  type ArtifactActor,
} from "./artifact";
import { ARTIFACT_LABELS_MAX, ArtifactLabelColour, type ArtifactLabelColours } from "./artifact-labels";
import { Anchor } from "./thread-subject";
import type { LinkedFromBody } from "./artifact-links";
import type { MentionedIn } from "./mention-ipc";
import type { PendingMark, PendingUnknown } from "./op-control";
import { ItemId, OpId } from "./work-ids";

export { ItemId, OpId };

const strict = { parseOptions: { onExcessProperty: "error" as const } };

/** The Artifacts node: its id, its name, or a `junto://` ref. */
export const ArtifactsNodeText = Schema.String.pipe(
  Schema.check(Schema.isMinLength(1), Schema.isMaxLength(4_096)),
).annotate({ description: "The Artifacts node: its id, its name, or a junto:// ref" });

const Title = Schema.String.pipe(
  Schema.check(Schema.isMinLength(1), Schema.isMaxLength(ARTIFACT_MAX_TITLE_LENGTH)),
);

/**
 * A body as the seat wrote it. `markdown` is a document's text, `url` a
 * link's address, `body` any type's body as JSON (its `type` may be left
 * out). Main checks it against the artifact's type, so a seat never has to
 * spell the type twice.
 */
export const BodyInput = Schema.Union([
  Schema.Struct({ markdown: Schema.String }),
  Schema.Struct({ url: Schema.String }),
  Schema.Struct({ body: Schema.Unknown }),
]);
export type BodyInput = typeof BodyInput.Type;

/** Patches as JSON; main decodes them for the artifact's type. */
export const PatchesInput = Schema.Array(Schema.Unknown).pipe(Schema.check(Schema.isMinLength(1)));

export const ARTIFACT_LIST_LIMIT_MAX = 200;

/**
 * Labels as a seat typed them (03): main folds each (trim, lowercase) with
 * `artifactLabelsOf` and refuses one that cannot be a label, naming the rule.
 */
const LabelsInput = Schema.Array(Schema.String).pipe(Schema.check(Schema.isMaxLength(ARTIFACT_LABELS_MAX)));
export const ARTIFACT_HISTORY_LIMIT_MAX = 200;

// ---------------------------------------------------------------------------
// Verb inputs (wire)

export const ArtifactListArgs = Schema.Struct({
  node: Schema.optionalKey(ArtifactsNodeText),
  type: Schema.optionalKey(ArtifactType),
  /** Archived artifacts are left out unless asked for. */
  archived: Schema.optionalKey(Schema.Boolean),
  limit: Schema.optionalKey(Schema.Int.check(Schema.isBetween({ minimum: 1, maximum: ARTIFACT_LIST_LIMIT_MAX }))),
  /** Only artifacts holding every one, each by equality or by a level under it (`artifactLabelsMatch`). */
  labels: Schema.optionalKey(LabelsInput),
}).annotate(strict);
export type ArtifactListArgs = typeof ArtifactListArgs.Type;

export const ArtifactShowArgs = Schema.Struct({
  artifact: ItemId,
  /** A past version; the head when left out. */
  version: Schema.optionalKey(ArtifactVersion),
}).annotate(strict);
export type ArtifactShowArgs = typeof ArtifactShowArgs.Type;

export const ArtifactHistoryArgs = Schema.Struct({
  artifact: ItemId,
  limit: Schema.optionalKey(Schema.Int.check(Schema.isBetween({ minimum: 1, maximum: ARTIFACT_HISTORY_LIMIT_MAX }))),
  /** Lists versions older than this one, for the next page. */
  before: Schema.optionalKey(ArtifactVersion),
}).annotate(strict);
export type ArtifactHistoryArgs = typeof ArtifactHistoryArgs.Type;

export const ArtifactCreateArgs = Schema.Struct({
  opId: OpId,
  artifactId: ItemId,
  node: Schema.optionalKey(ArtifactsNodeText),
  type: ArtifactType,
  title: Title,
  /** Documents, pads and sheets start empty when left out; links and files need one. */
  body: Schema.optionalKey(BodyInput),
  taskIds: Schema.optionalKey(Schema.Array(ItemId)),
  labels: Schema.optionalKey(LabelsInput),
}).annotate(strict);
export type ArtifactCreateArgs = typeof ArtifactCreateArgs.Type;

/** `body` replaces the whole body; `patches` patch a pad, sheet or document. */
export const ArtifactEditArgs = Schema.Struct({
  opId: OpId,
  artifact: ItemId,
  baseVersion: ArtifactVersion.annotate({
    description: "The version this edit was written against, from show; a stale one is refused with the head",
  }),
  body: Schema.optionalKey(BodyInput),
  patches: Schema.optionalKey(PatchesInput),
}).annotate(strict);
export type ArtifactEditArgs = typeof ArtifactEditArgs.Type;

export const ArtifactCommentArgs = Schema.Struct({
  opId: OpId,
  artifact: ItemId,
  text: Schema.String.pipe(Schema.check(Schema.isMinLength(1), Schema.isMaxLength(64_000))),
  /** Left out, the comment is on the whole artifact. */
  anchor: Schema.optionalKey(Anchor),
}).annotate(strict);
export type ArtifactCommentArgs = typeof ArtifactCommentArgs.Type;

/**
 * An artifact's labels: `set` names the whole set (empty clears it), or
 * `add` and `remove` change the head's set. Labels are not versioned body,
 * so no `baseVersion`: main reads the head's set, folds the next one and
 * sends it whole.
 */
export const ArtifactLabelArgs = Schema.Struct({
  opId: OpId,
  artifact: ItemId,
  set: Schema.optionalKey(LabelsInput),
  add: Schema.optionalKey(LabelsInput),
  remove: Schema.optionalKey(LabelsInput),
}).annotate(strict);
export type ArtifactLabelArgs = typeof ArtifactLabelArgs.Type;

/**
 * A label's colour in an Artifacts node: every artifact there that carries
 * the label draws in it. `colour: null` unsets it. The label need not be
 * carried yet, and nothing inherits across `/` levels.
 */
export const ArtifactColourArgs = Schema.Struct({
  opId: OpId,
  node: Schema.optionalKey(ArtifactsNodeText),
  label: Schema.String,
  colour: Schema.NullOr(ArtifactLabelColour),
}).annotate(strict);
export type ArtifactColourArgs = typeof ArtifactColourArgs.Type;

/** archive and restore name one artifact. */
export const ArtifactOneArgs = Schema.Struct({ opId: OpId, artifact: ItemId }).annotate(strict);
export type ArtifactOneArgs = typeof ArtifactOneArgs.Type;

// ---------------------------------------------------------------------------
// Ops

export const ARTIFACT_READ_OPS = ["artifact.list", "artifact.show", "artifact.history"] as const;
export const ARTIFACT_WRITE_OPS = [
  "artifact.create",
  "artifact.edit",
  "artifact.label",
  "artifact.colour",
  "artifact.comment",
  "artifact.archive",
  "artifact.restore",
] as const;
export const ARTIFACT_OPS = [...ARTIFACT_READ_OPS, ...ARTIFACT_WRITE_OPS] as const;
export type ArtifactReadOp = (typeof ARTIFACT_READ_OPS)[number];
export type ArtifactWriteOp = (typeof ARTIFACT_WRITE_OPS)[number];
export type ArtifactControlOp = (typeof ARTIFACT_OPS)[number];

/** The wire args of each op, so a dispatcher cannot pair an op with another's input. */
export const ARTIFACT_ARGS = {
  "artifact.list": ArtifactListArgs,
  "artifact.show": ArtifactShowArgs,
  "artifact.history": ArtifactHistoryArgs,
  "artifact.create": ArtifactCreateArgs,
  "artifact.edit": ArtifactEditArgs,
  "artifact.label": ArtifactLabelArgs,
  "artifact.colour": ArtifactColourArgs,
  "artifact.comment": ArtifactCommentArgs,
  "artifact.archive": ArtifactOneArgs,
  "artifact.restore": ArtifactOneArgs,
} as const satisfies { readonly [Op in ArtifactControlOp]: Schema.Top };

export const isArtifactOp = (op: string): op is ArtifactControlOp =>
  (ARTIFACT_OPS as ReadonlyArray<string>).includes(op);

export const isArtifactWriteOp = (op: string): op is ArtifactWriteOp =>
  (ARTIFACT_WRITE_OPS as ReadonlyArray<string>).includes(op);

// ---------------------------------------------------------------------------
// Results

/** A list row: the head without its body, and the colours of the labels it carries that have one. */
export type ArtifactListItem = Pick<
  Artifact,
  "artifactId" | "nodeId" | "type" | "title" | "version" | "updatedAt" | "archived" | "labels"
> & { readonly labelColours?: ArtifactLabelColours };

export type ArtifactListResult = PendingUnknown & {
  /** Each marked `pending` when one of this machine's queued writes touches it (`PendingMark`). */
  readonly artifacts: ReadonlyArray<ArtifactListItem & Partial<PendingMark>>;
  /** True when more matched than `limit`. */
  readonly more: boolean;
};

export type ArtifactShowResult = PendingUnknown & {
  /** Marked `pending` when one of this machine's queued writes touches it (`PendingMark`). */
  readonly artifact: Artifact & Partial<PendingMark>;
  /** The version shown: the head, or the one asked for. */
  readonly version: ArtifactVersion;
  /** The body as text: markdown, pad digest, sheet table, link or file line (`artifactText`). */
  readonly text: string;
  /** The body itself, for edits that address ids. */
  readonly body: unknown;
  /** What links here that this seat may read, newest first (plan 0.11, 02). */
  readonly linkedFrom: ArtifactLinkedFrom;
  /** The colours of the labels it carries that have one in its node (03); absent when none. */
  readonly labelColours?: ArtifactLabelColours;
};

/**
 * Where an artifact is linked from, each list newest first and at most
 * ARTIFACT_LINKED_FROM_MAX. `mail`: mail and comments that mention it,
 * only the ones the seat may read (its own mail, mail it sent, threads on
 * nodes in its reach). `more` when the newest ARTIFACT_LINKED_FROM_MAX cut it,
 * or when main's scan filled before it could tell: there may be more.
 */
export type ArtifactLinkedFrom = {
  /** Artifacts in the seat's reach whose head body links this one, with the line. */
  readonly bodies: ReadonlyArray<LinkedFromBody>;
  readonly mail: ReadonlyArray<MentionedIn>;
  readonly more: boolean;
};

export const ARTIFACT_LINKED_FROM_MAX = 20;

export type ArtifactHistoryEntry = {
  readonly version: ArtifactVersion;
  readonly author: ArtifactActor;
  readonly at: number;
  /**
   * `create` for version 1, else the edit's kind; `unrecorded` for a version
   * that arrived without its edit (too large to travel inline).
   */
  readonly change: "create" | "replace" | "patch" | "unrecorded";
};

export type ArtifactHistoryResult = {
  readonly artifactId: ItemId;
  readonly versions: ReadonlyArray<ArtifactHistoryEntry>;
  readonly more: boolean;
};

/**
 * How a write ended. `applied`: ruled here and readable now, with the head
 * it made. `queued`: the editing machine is away; `junto op show <opId>`
 * reads its ruling later. A refusal is never a result: it is the typed error,
 * with the opId in its details.
 */
export type ArtifactWriteResult =
  | {
      readonly disposition: "applied";
      readonly opId: OpId;
      readonly artifactId: ItemId;
      readonly version: ArtifactVersion;
    }
  | { readonly disposition: "queued"; readonly opId: OpId; readonly artifactId: ItemId };

export type ArtifactDisposition = ArtifactWriteResult["disposition"];

/** A colour write is on the node, so it names the label and the colour, not a version. */
export type ArtifactColourResult = {
  readonly disposition: "applied" | "queued";
  readonly opId: OpId;
  readonly nodeId: string;
  readonly label: string;
  readonly colour: ArtifactLabelColour | null;
};

/** A posted comment: its thread, its row, and the seats told, each once. */
export type ArtifactCommentResult = {
  readonly disposition: "applied";
  readonly opId: OpId;
  readonly threadId: string;
  readonly messageId: string;
  readonly notified: ReadonlyArray<string>;
  /** Each token that linked to nothing and stayed plain text, with the names nearest it. */
  readonly unlinked?: ReadonlyArray<{ readonly token: string; readonly nearest: ReadonlyArray<string> }>;
};
