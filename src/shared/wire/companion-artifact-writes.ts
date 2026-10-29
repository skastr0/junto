/**
 * The phone's artifact writes, as wire shapes (0.11.3, docs/artifacts-proposal.md
 * sections 3, 5, 6 and 7): `artifact.apply`'s args and result, the fields a
 * conflict refusal carries on `CompanionError`, the `content.stage` purpose a
 * create or pad image claims, and the `signal.answer` member for an artifact
 * form. `companion-protocol.ts` imports them and names the ops; the writers
 * that honour them live beside the desktop's own (companion backend and
 * `companion-demo.ts`).
 *
 * The phone speaks the desktop's own model: the same `ArtifactOp`, the same
 * head, the same refusal vocabulary, never a dialect.
 *
 * A wire module: its import closure is `effect` and its siblings alone.
 */

import { Schema } from "effect";
import { ARTIFACT_MAX_DOCUMENT_LENGTH, Artifact, ArtifactOp, ArtifactVersion } from "./artifact";
import { ItemId, NodeId, OpId } from "./ids";
import { ULID_PATTERN } from "./ulid";

const bounded = (min: number, max: number) =>
  Schema.String.pipe(Schema.check(Schema.isMinLength(min)), Schema.check(Schema.isMaxLength(max)));

/** A canvas name, as the companion protocol spells one. */
const CanvasName = bounded(1, 256);

// --- artifact.apply -----------------------------------------------------------

/**
 * One artifact write (section 3): every `ArtifactOp` a seat or the window can
 * issue — create, edit, retitle, labels, archive, restore, tasks, labelColour,
 * move — carried as the desktop spells it, never a phone dialect.
 *
 * `artifactId` is the command's target item: the phone mints it on `create`,
 * names it on every item op, and leaves it out on `labelColour`, the one op on
 * the node itself.
 */
export const CompanionArtifactApplyArgs = Schema.Struct({
  canvasName: CanvasName,
  /** The Artifacts node the artifact lives in; on `create`, the node it lands in. */
  nodeId: NodeId,
  /** The item the write names; minted by the phone on `create`, absent on `labelColour`. */
  artifactId: Schema.optionalKey(ItemId),
  /**
   * The write's id, minted by the phone and stable across reconnects: a resend
   * with the same opId returns the first ruling, never a second version
   * (section 5, 1). The dedup key is this Mac's writer plus opId.
   */
  opId: OpId,
  op: ArtifactOp,
});
export type CompanionArtifactApplyArgs = typeof CompanionArtifactApplyArgs.Type;

/**
 * The ruling on one apply (section 3). `applied` carries the head as it now
 * stands — the new version on a create or edit, the head unchanged when a
 * resend replays an earlier ruling. `queued` answers while the editing machine
 * is elsewhere: the write is held against `opId` and ruled when a path exists.
 */
export const CompanionArtifactApplyResult = Schema.Union([
  Schema.Struct({
    disposition: Schema.Literal("applied"),
    artifact: Artifact,
    version: ArtifactVersion,
  }),
  Schema.Struct({
    disposition: Schema.Literal("queued"),
    opId: OpId,
  }),
]);
export type CompanionArtifactApplyResult = typeof CompanionArtifactApplyResult.Type;

// --- conflict refusals ----------------------------------------------------------

/**
 * The two refusals a phone resolves against the head (section 5, 2): the
 * write's base fell behind it (`stale`), or its patch would not rebase
 * (`rebase_conflict`). They cross as `conflict` carrying the head; every
 * other refusal is `invalid` with the ruler's sentence.
 */
export const CompanionArtifactConflictReason = Schema.Literals(["stale", "rebase_conflict"]);
export type CompanionArtifactConflictReason = typeof CompanionArtifactConflictReason.Type;

/**
 * The fields `CompanionError` gains for an artifact refusal: `reason` says
 * which conflict it is, `artifact` the head and its version to merge or take.
 * Absent on every error but an artifact `conflict`.
 */
export const COMPANION_ARTIFACT_CONFLICT_FIELDS = {
  reason: Schema.optionalKey(CompanionArtifactConflictReason),
  artifact: Schema.optionalKey(Artifact),
} as const;

// --- content.stage --------------------------------------------------------------

/**
 * What a staged piece is for (section 6). Absent, the mail and answer claims
 * behave as always; `{ for: "artifact", canvasName }` binds the ref to that
 * canvas's artifacts, so an `artifact.apply` create (a file or link-content
 * body) or a pad `upsertImage` on it claims the bytes exactly once, and they
 * are kept for good.
 */
export const CompanionContentStagePurpose = Schema.Struct({
  for: Schema.Literal("artifact"),
  canvasName: CanvasName,
});
export type CompanionContentStagePurpose = typeof CompanionContentStagePurpose.Type;

// --- signal.answer --------------------------------------------------------------

/**
 * The document an artifact-form answer writes (section 7): its markdown,
 * bounded as the ruler bounds it, and `replyId`, the artifact write's opId —
 * a resend returns the first answer's artifact, never a second document.
 */
export const CompanionArtifactAnswer = Schema.Struct({
  markdown: Schema.String.pipe(Schema.check(Schema.isMaxLength(ARTIFACT_MAX_DOCUMENT_LENGTH))),
  replyId: Schema.String.check(Schema.isPattern(ULID_PATTERN)),
});
export type CompanionArtifactAnswer = typeof CompanionArtifactAnswer.Type;

/**
 * A `signal.answer` member for a signal whose `form` is artifact: the phone
 * writes the document in the same editor, the Mac makes it in the form's node
 * and checks `minWords`, as `agentSignalReply` does.
 */
export const CompanionSignalArtifactAnswer = Schema.Struct({
  signalId: bounded(1, 128),
  artifact: CompanionArtifactAnswer,
});
export type CompanionSignalArtifactAnswer = typeof CompanionSignalArtifactAnswer.Type;
