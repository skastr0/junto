import { Schema } from "effect";
import { ContentRef } from "./content-ref";

/**
 * Agent signals: a seat's own declared claim that it needs the operator.
 *
 * - `escalate`: needs the operator's attention; work continues. Any time.
 * - `blocked`: work is entirely blocked on the operator.
 * - `feedback`: not blocked; an opportunity for the operator to review.
 *
 * A signal is durable (it waits for an operator response) and belongs to one
 * canvas seat. It is the agent's claim, never an assessment: advisory thread
 * health (`thread-health.ts`) is a separate axis and must not be merged in.
 */

export const AGENT_SIGNAL_KINDS = ["escalate", "blocked", "feedback"] as const;
export const AgentSignalKind = Schema.Literals(AGENT_SIGNAL_KINDS);
export type AgentSignalKind = typeof AgentSignalKind.Type;

export const AGENT_SIGNAL_STATES = ["open", "answered", "dismissed", "withdrawn"] as const;
export const AgentSignalState = Schema.Literals(AGENT_SIGNAL_STATES);
export type AgentSignalState = typeof AgentSignalState.Type;

/** One short sentence, the same bound as a preamble. */
export const AGENT_SIGNAL_MAX_TEXT_LENGTH = 280;
/** Longer markdown the operator can open. */
export const AGENT_SIGNAL_MAX_DETAIL_LENGTH = 8_000;
/** The operator's answer, delivered to the seat as mail. */
export const AGENT_SIGNAL_MAX_RESPONSE_LENGTH = 8_000;
/**
 * Answers the agent pre-bakes for the operator: at most this many short
 * pills, shown ahead of the quick replies. A suggestion is one line the
 * operator can send as-is, the same bound as a quick reply.
 */
export const AGENT_SIGNAL_MAX_SUGGESTIONS = 2;
export const AGENT_SIGNAL_MAX_SUGGESTION_LENGTH = 80;

const boundedText = (max: number) =>
  Schema.String.pipe(
    Schema.check(Schema.isMinLength(1)),
    Schema.check(Schema.isMaxLength(max)),
  );

export const AgentSignalText = boundedText(AGENT_SIGNAL_MAX_TEXT_LENGTH);
export const AgentSignalDetail = boundedText(AGENT_SIGNAL_MAX_DETAIL_LENGTH);
export const AgentSignalResponseText = boundedText(AGENT_SIGNAL_MAX_RESPONSE_LENGTH);
export const AgentSignalSuggestion = boundedText(AGENT_SIGNAL_MAX_SUGGESTION_LENGTH);
export const AgentSignalSuggestions = Schema.Array(AgentSignalSuggestion).pipe(
  Schema.check(Schema.isMaxLength(AGENT_SIGNAL_MAX_SUGGESTIONS)),
);
export type AgentSignalSuggestions = typeof AgentSignalSuggestions.Type;


/** The agent's words beside an attachment ("Before"). No length of ours. */
const caption = Schema.optionalKey(Schema.String.pipe(Schema.check(Schema.isMinLength(1))));

/**
 * A file the agent attached: a picture, a video, text, a unified diff, a
 * source file, anything. The bytes live in the content store under `ref`
 * (its display name is the file's name); no path is kept, so the file
 * outlives the folder it came from. How it is shown is read off its bytes
 * and its name. This one has no `kind`: it is what every attachment was
 * before there were others.
 */
export const AgentSignalFileAttachment = Schema.Struct({
  ref: ContentRef,
  caption,
});
export type AgentSignalFileAttachment = typeof AgentSignalFileAttachment.Type;

/** Two texts to read as a change, with no repository behind them. */
export const AgentSignalCompareAttachment = Schema.Struct({
  kind: Schema.Literal("compare"),
  before: ContentRef,
  after: ContentRef,
  /** A file name or an extension: what the texts are highlighted as. */
  name: Schema.optionalKey(Schema.String.pipe(Schema.check(Schema.isMinLength(1)))),
  caption,
});
export type AgentSignalCompareAttachment = typeof AgentSignalCompareAttachment.Type;

/** A full commit id: forty hex characters, lower case. */
export const AgentSignalCommitSha = Schema.String.pipe(Schema.check(Schema.isPattern(/^[a-f0-9]{40}$/)));

/**
 * A commit in the sending seat's own folder. Only the id is carried: the
 * folder is the seat's, found by the app, never a path from the agent.
 */
export const AgentSignalCommitAttachment = Schema.Struct({
  kind: Schema.Literal("commit"),
  sha: AgentSignalCommitSha,
  caption,
});
export type AgentSignalCommitAttachment = typeof AgentSignalCommitAttachment.Type;

/**
 * A video at a web address the agent names. Untrusted: the card shows the
 * address, and nothing is fetched until the operator presses play.
 */
export const AgentSignalLinkAttachment = Schema.Struct({
  kind: Schema.Literal("link"),
  url: Schema.String,
  caption,
});
export type AgentSignalLinkAttachment = typeof AgentSignalLinkAttachment.Type;

/** A canvas node, as the wire carries it (the app brands it NodeId). */
const WireNodeId = Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(256));
/**
 * A task's or an artifact's id: a ULID. Said here, not imported, so the wire
 * keeps its closure of `effect` alone; the app brands it ItemId.
 */
const WireItemId = Schema.String.check(Schema.isPattern(/^[0-9A-HJKMNP-TV-Z]{26}$/u));

/**
 * A task the signal is about, on its board: a stamp request carries its task
 * this way (0.10 plan 03 section 6). Main admitted it in the seat's reach.
 */
export const AgentSignalTaskAttachment = Schema.Struct({
  kind: Schema.Literal("task"),
  nodeId: WireNodeId,
  taskId: WireItemId,
  caption,
});
export type AgentSignalTaskAttachment = typeof AgentSignalTaskAttachment.Type;

/** An artifact the signal is about, in its Artifacts node. Main admitted it in the seat's reach. */
export const AgentSignalArtifactAttachment = Schema.Struct({
  kind: Schema.Literal("artifact"),
  nodeId: WireNodeId,
  artifactId: WireItemId,
  caption,
});
export type AgentSignalArtifactAttachment = typeof AgentSignalArtifactAttachment.Type;

export const AgentSignalAttachment = Schema.Union([
  AgentSignalFileAttachment,
  AgentSignalCompareAttachment,
  AgentSignalCommitAttachment,
  AgentSignalLinkAttachment,
  AgentSignalTaskAttachment,
  AgentSignalArtifactAttachment,
]);
export type AgentSignalAttachment = typeof AgentSignalAttachment.Type;

export type AgentSignalAttachmentKind = "file" | Extract<AgentSignalAttachment, { readonly kind: string }>["kind"];

/** What kind of attachment this is; a file has no `kind` of its own. */
export const agentSignalAttachmentKind = (attachment: AgentSignalAttachment): AgentSignalAttachmentKind =>
  "kind" in attachment ? attachment.kind : "file";

/** A task or an artifact: named on the canvas, never bytes, never previewed. */
export type AgentSignalResourceAttachment = AgentSignalTaskAttachment | AgentSignalArtifactAttachment;

export const isResourceAttachment = (attachment: AgentSignalAttachment): attachment is AgentSignalResourceAttachment =>
  "kind" in attachment && (attachment.kind === "task" || attachment.kind === "artifact");

/**
 * The web address a link attachment may carry, normalized, or why not: http
 * or https, a host, and no name or password in it.
 */
export const admitLinkUrl = (
  raw: string,
): { readonly ok: true; readonly url: string } | { readonly ok: false; readonly reason: string } => {
  let parsed: URL;
  try {
    parsed = new URL(raw.trim());
  } catch {
    return { ok: false, reason: "not a web address" };
  }
  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
    return { ok: false, reason: "only http and https addresses can be attached" };
  }
  if (parsed.hostname === "") return { ok: false, reason: "the address has no host" };
  if (parsed.username !== "" || parsed.password !== "") {
    return { ok: false, reason: "the address carries a name or a password; remove them" };
  }
  return { ok: true, url: parsed.href };
};

const Identity = Schema.Struct({ sha256: ContentRef.fields.sha256, byteLength: ContentRef.fields.byteLength });

/**
 * One attachment as a seat sends it when raising a signal. Whatever is made
 * of bytes (a file, the two sides of a compare) the seat uploaded first
 * (`content.stage`) and names here by what came back; a commit is its id and
 * a link its address. Main is the authority on what is admitted.
 */
export const AgentSignalAttachmentInput = Schema.Union([
  Schema.Struct({ ref: Identity, caption: Schema.optionalKey(Schema.String) }).annotate({
    parseOptions: { onExcessProperty: "error" },
  }),
  Schema.Struct({
    kind: Schema.Literal("compare"),
    before: Identity,
    after: Identity,
    name: Schema.optionalKey(Schema.String),
    caption: Schema.optionalKey(Schema.String),
  }).annotate({ parseOptions: { onExcessProperty: "error" } }),
  Schema.Struct({
    kind: Schema.Literal("commit"),
    sha: Schema.String,
    caption: Schema.optionalKey(Schema.String),
  }).annotate({ parseOptions: { onExcessProperty: "error" } }),
  Schema.Struct({
    kind: Schema.Literal("link"),
    url: Schema.String,
    caption: Schema.optionalKey(Schema.String),
  }).annotate({ parseOptions: { onExcessProperty: "error" } }),
  // A task or an artifact by its ref: `junto://canvas/<canvas>?node=<id>&item=<ItemId>` (mention.ts).
  Schema.Struct({
    kind: Schema.Literal("task"),
    ref: Schema.String,
    caption: Schema.optionalKey(Schema.String),
  }).annotate({ parseOptions: { onExcessProperty: "error" } }),
  Schema.Struct({
    kind: Schema.Literal("artifact"),
    ref: Schema.String,
    caption: Schema.optionalKey(Schema.String),
  }).annotate({ parseOptions: { onExcessProperty: "error" } }),
]);
export type AgentSignalAttachmentInput = typeof AgentSignalAttachmentInput.Type;

export const AgentSignalResponse = Schema.Struct({
  text: AgentSignalResponseText,
  /** Epoch ms. */
  at: Schema.Number,
  /** Files the operator sent with the answer, in order. Absent when there are none. */
  attachments: Schema.optionalKey(Schema.Array(ContentRef)),
});
export type AgentSignalResponse = typeof AgentSignalResponse.Type;

export const AgentSignal = Schema.Struct({
  signalId: Schema.String,
  canvasName: Schema.String,
  nodeId: Schema.String,
  kind: AgentSignalKind,
  text: AgentSignalText,
  detail: Schema.optionalKey(AgentSignalDetail),
  /** Files the agent attached, in the order given. Absent when there are none. */
  attachments: Schema.optionalKey(Schema.Array(AgentSignalAttachment)),
  /**
   * Replies the agent pre-baked for the operator, up to two, shown ahead of
   * the quick replies. Absent when the agent offered none.
   */
  suggestions: Schema.optionalKey(AgentSignalSuggestions),
  /** Epoch ms. */
  createdAt: Schema.Number,
  state: AgentSignalState,
  /** Present once the operator answered. */
  response: Schema.optionalKey(AgentSignalResponse),
  /** Epoch ms of the last state change (answer, dismiss, withdraw). */
  closedAt: Schema.optionalKey(Schema.Number),
});
export type AgentSignal = typeof AgentSignal.Type;

/** Live renderer event: the signal as it now stands (upsert by signalId). */
export const AgentSignalEvent = Schema.Struct({
  signal: AgentSignal,
});
export type AgentSignalEvent = typeof AgentSignalEvent.Type;
