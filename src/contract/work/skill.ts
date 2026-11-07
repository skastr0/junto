/**
 * The work socket's artifact.*, automation.*, references.* and content.stage
 * ops, as one Effect `RpcGroup`: each op's arguments, its answer and its
 * refusal. Owned by cli-skill. The core serves the group
 * (`src/core/work-control/skill.ts`) and the CLI calls it (`src/cli`), so a
 * change to an op's arguments or answer fails the compile of both, and a
 * missing handler fails the core's.
 *
 * Each op's tag is its v1 name, and the wire stays v1: the arguments are the
 * frame's `args`, the answer its `data`, and the refusal its `error`.
 */
import { Schema } from "effect";
import { Rpc, RpcGroup } from "effect/rpc";
import { Artifact, ArtifactActor, ArtifactType, ArtifactVersion } from "../../shared/artifact";
import {
  ArtifactColourArgs,
  ArtifactCommentArgs,
  ArtifactCreateArgs,
  ArtifactEditArgs,
  ArtifactHistoryArgs,
  ArtifactLabelArgs,
  ArtifactListArgs,
  ArtifactOneArgs,
  ArtifactShowArgs,
  type ArtifactColourResult,
  type ArtifactCommentResult,
  type ArtifactHistoryResult,
  type ArtifactListResult,
  type ArtifactShowResult,
  type ArtifactWriteResult,
} from "../../shared/artifact-control";
import { ArtifactLabel, ArtifactLabelColour } from "../../shared/artifact-labels";
import { LinkedFromBody } from "../../shared/artifact-links";
import { Automation, Firing } from "../../shared/automation";
import { AutomationHistoryArgs, AutomationListArgs, AutomationShowArgs } from "../../shared/automation-control";
import { BriefingMentions } from "../../shared/briefing-mentions";
import { ContentStageArgs, ContentStageResult } from "../../shared/content-stage";
import { MentionedIn } from "../../shared/mention-ipc";
import type { PendingMark, PendingUnknown } from "../../shared/op-control";
import type { ReferenceListEntry, ReferenceReadResult } from "../../shared/references";
import { RefusalReason } from "../../shared/resource-command";
import { ItemId, OpId } from "../../shared/work-ids";
import { ReferencesListArgs, ReferencesReadArgs } from "../../shared/work-control";
import { WorkFailure, WorkInputHint, WorkInputRefusal } from "./failure";
import { UnlinkedMention } from "./msg";

/** The answers' own types are written by hand in `src/shared`; each schema below must be the same type, or the compile fails. */
type Same<A, B> = [A] extends [B] ? ([B] extends [A] ? true : false) : false;

/** An item one of this machine's queued writes touches (`PendingMark`), and a list or show whose marks are unknown. */
const pendingMark = {
  pending: Schema.optionalKey(Schema.Literal(true)),
  atRisk: Schema.optionalKey(
    Schema.Union([
      Schema.Struct({
        opId: OpId,
        refusal: Schema.Struct({
          reason: RefusalReason,
          message: Schema.String,
          expected: Schema.optionalKey(Schema.Unknown),
          next_step: Schema.optionalKey(Schema.String),
        }),
      }),
      Schema.Struct({ opId: OpId, waiting: Schema.Literal("base_not_pulled"), root: OpId }),
    ]),
  ),
};
const pendingUnknown = { pendingUnknown: Schema.optionalKey(Schema.Literal(true)) };
const PendingMarkFields = Schema.Struct(pendingMark);
const pendingMarkIsSame: Same<Partial<PendingMark>, typeof PendingMarkFields.Type> = true;
const PendingUnknownFields = Schema.Struct(pendingUnknown);
const pendingUnknownIsSame: Same<PendingUnknown, typeof PendingUnknownFields.Type> = true;

/** The colours of the labels an artifact carries that have one in its node. */
const labelColours = { labelColours: Schema.optionalKey(Schema.Record(ArtifactLabel, ArtifactLabelColour)) };

const { artifactId, nodeId, type, title, version, updatedAt, archived, labels } = Artifact.fields;

export const ArtifactListAnswer = Schema.Struct({
  artifacts: Schema.Array(
    Schema.Struct({ artifactId, nodeId, type, title, version, updatedAt, archived, labels, ...labelColours, ...pendingMark }),
  ),
  more: Schema.Boolean,
  ...pendingUnknown,
});
const listIsSame: Same<ArtifactListResult, typeof ArtifactListAnswer.Type> = true;

export const ArtifactShowAnswer = Schema.Struct({
  artifact: Schema.Struct({ ...Artifact.fields, ...pendingMark }),
  version: ArtifactVersion,
  text: Schema.String,
  body: Schema.Unknown,
  linkedFrom: Schema.Struct({
    bodies: Schema.Array(LinkedFromBody),
    mail: Schema.Array(MentionedIn),
    more: Schema.Boolean,
  }),
  ...labelColours,
  ...pendingUnknown,
});
const showIsSame: Same<ArtifactShowResult, typeof ArtifactShowAnswer.Type> = true;

export const ArtifactHistoryAnswer = Schema.Struct({
  artifactId: ItemId,
  versions: Schema.Array(
    Schema.Struct({
      version: ArtifactVersion,
      author: ArtifactActor,
      at: Schema.Number,
      change: Schema.Literals(["create", "replace", "patch", "unrecorded"]),
    }),
  ),
  more: Schema.Boolean,
});
const historyIsSame: Same<ArtifactHistoryResult, typeof ArtifactHistoryAnswer.Type> = true;

/** A write applied here with the head it made, or queued for the editing machine. */
export const ArtifactWriteAnswer = Schema.Union([
  Schema.Struct({ disposition: Schema.Literal("applied"), opId: OpId, artifactId: ItemId, version: ArtifactVersion }),
  Schema.Struct({ disposition: Schema.Literal("queued"), opId: OpId, artifactId: ItemId, message: Schema.optionalKey(Schema.String) }),
]);
const writeIsSame: Same<ArtifactWriteResult, typeof ArtifactWriteAnswer.Type> = true;

export const ArtifactColourAnswer = Schema.Struct({
  disposition: Schema.Literals(["applied", "queued"]),
  opId: OpId,
  nodeId: Schema.String,
  label: Schema.String,
  colour: Schema.NullOr(ArtifactLabelColour),
});
const colourIsSame: Same<ArtifactColourResult, typeof ArtifactColourAnswer.Type> = true;

export const ArtifactCommentAnswer = Schema.Struct({
  disposition: Schema.Literal("applied"),
  opId: OpId,
  threadId: Schema.String,
  messageId: Schema.String,
  notified: Schema.Array(Schema.String),
  unlinked: Schema.optionalKey(Schema.Array(UnlinkedMention)),
});
const commentIsSame: Same<ArtifactCommentResult, typeof ArtifactCommentAnswer.Type> = true;

export const AutomationListAnswer = Schema.Struct({ automations: Schema.Array(Automation) });
export const AutomationShowAnswer = Schema.Struct({ automation: Automation });
export const AutomationHistoryAnswer = Schema.Struct({ firings: Schema.Array(Firing) });

/** Where a reference comes from: the app, or one region around the seat. */
const referencePlace = {
  description: Schema.optionalKey(Schema.String),
  scope: Schema.Literals(["app", "region"]),
  region: Schema.optionalKey(Schema.Struct({ id: Schema.String, label: Schema.String })),
};

const ReferenceListEntryAnswer = Schema.Struct({
  name: Schema.String,
  ...referencePlace,
  read: Schema.String,
  bytes: Schema.Number,
  updatedAt: Schema.Number,
});
const referenceEntryIsSame: Same<ReferenceListEntry, typeof ReferenceListEntryAnswer.Type> = true;
export const ReferencesListAnswer = Schema.Struct({ references: Schema.Array(ReferenceListEntryAnswer) });

const ReferenceReadFields = Schema.Struct({ name: Schema.String, ...referencePlace, body: Schema.String, updatedAt: Schema.Number });
const referenceReadIsSame: Same<ReferenceReadResult, typeof ReferenceReadFields.Type> = true;
/** The reference, and each junto:// link its body makes, once, in order. */
export const ReferencesReadAnswer = Schema.Struct({ ...ReferenceReadFields.fields, mentions: Schema.optionalKey(BriefingMentions) });

// The checks above are read by the compiler alone.
void [
  pendingMarkIsSame, pendingUnknownIsSame, listIsSame, showIsSame, historyIsSame, writeIsSame, colourIsSame, commentIsSame,
  referenceEntryIsSame, referenceReadIsSame,
];

/** The artifact and automation verbs point a refused argument at the command's schema. */
const SCHEMA_SHOWS = "junto schema show shows this command's input";

const schemaShownRpc = <const Tag extends string, P extends Schema.Top, S extends Schema.Top>(tag: Tag, payload: P, success: S) =>
  Rpc.make(tag, { payload, success, error: WorkFailure }).annotate(WorkInputHint, SCHEMA_SHOWS);

export const ArtifactList = schemaShownRpc("artifact.list", ArtifactListArgs, ArtifactListAnswer);
export const ArtifactShow = schemaShownRpc("artifact.show", ArtifactShowArgs, ArtifactShowAnswer);
export const ArtifactHistory = schemaShownRpc("artifact.history", ArtifactHistoryArgs, ArtifactHistoryAnswer);
export const ArtifactCreate = schemaShownRpc("artifact.create", ArtifactCreateArgs, ArtifactWriteAnswer);
export const ArtifactEdit = schemaShownRpc("artifact.edit", ArtifactEditArgs, ArtifactWriteAnswer);
export const ArtifactLabelOp = schemaShownRpc("artifact.label", ArtifactLabelArgs, ArtifactWriteAnswer);
export const ArtifactColour = schemaShownRpc("artifact.colour", ArtifactColourArgs, ArtifactColourAnswer);
export const ArtifactComment = schemaShownRpc("artifact.comment", ArtifactCommentArgs, ArtifactCommentAnswer);
export const ArtifactArchive = schemaShownRpc("artifact.archive", ArtifactOneArgs, ArtifactWriteAnswer);
export const ArtifactRestore = schemaShownRpc("artifact.restore", ArtifactOneArgs, ArtifactWriteAnswer);

export const AutomationList = schemaShownRpc("automation.list", AutomationListArgs, AutomationListAnswer);
export const AutomationShow = schemaShownRpc("automation.show", AutomationShowArgs, AutomationShowAnswer);
export const AutomationHistory = schemaShownRpc("automation.history", AutomationHistoryArgs, AutomationHistoryAnswer);

/**
 * An empty struct admits any object, and publishes as "not null": this one
 * takes no key, publishes as a closed object, and refuses a key in the words
 * the verb always used.
 */
const ReferencesListNoArgs = ReferencesListArgs.check(
  Schema.makeFilter((args) => Object.keys(args).length === 0 || "references list takes no arguments: a seat lists its own scope", {
    toJsonSchema: () => ({ type: "object", properties: {}, additionalProperties: false }),
  }),
);

export const ReferencesList = Rpc.make("references.list", { payload: ReferencesListNoArgs, success: ReferencesListAnswer, error: WorkFailure })
  .annotate(WorkInputHint, "junto schema show references.list");
export const ReferencesRead = Rpc.make("references.read", { payload: ReferencesReadArgs, success: ReferencesReadAnswer, error: WorkFailure })
  .annotate(WorkInputHint, "junto schema show references.read");

export const ContentStage = Rpc.make("content.stage", { payload: ContentStageArgs, success: ContentStageResult, error: WorkFailure })
  // The arguments are file content: the schema's own words would quote them.
  .annotate(WorkInputRefusal, {
    type: "InputError",
    message: "content.stage takes {stageId?, bytesBase64?, done?: {mediaType, displayName?, expected?}} with a piece, a done, or both",
    details: { path: "args", retryable: false, hint: "junto schema show content.stage" },
  });

/** Decoded strictly where the core serves it: an argument or an answer field the contract does not name is refused. */
export const SkillRpcs = RpcGroup.make(
  ArtifactList,
  ArtifactShow,
  ArtifactHistory,
  ArtifactCreate,
  ArtifactEdit,
  ArtifactLabelOp,
  ArtifactColour,
  ArtifactComment,
  ArtifactArchive,
  ArtifactRestore,
  AutomationList,
  AutomationShow,
  AutomationHistory,
  ReferencesList,
  ReferencesRead,
  ContentStage,
).annotateRpcs(Rpc.ParseOptions, { onExcessProperty: "error" });
