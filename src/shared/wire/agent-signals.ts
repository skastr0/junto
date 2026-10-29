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

export const AGENT_SIGNAL_KINDS = ["escalate", "blocked", "feedback", "notice", "work"] as const;
export const AgentSignalKind = Schema.Literals(AGENT_SIGNAL_KINDS);
export type AgentSignalKind = typeof AgentSignalKind.Type;

/** The kinds a seat may raise. `notice` and `work` are an automation's kinds. */
export const SEAT_RAISE_KINDS = ["escalate", "blocked", "feedback"] as const;
export const SeatRaiseKind = Schema.Literals(SEAT_RAISE_KINDS);
export type SeatRaiseKind = typeof SeatRaiseKind.Type;

/** Does a raise, as a seat asks for it, name one of the seat's own kinds? */
export const isSeatRaiseKind = (kind: AgentSignalKind): kind is SeatRaiseKind =>
  (SEAT_RAISE_KINDS as ReadonlyArray<AgentSignalKind>).includes(kind);

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

// ── The operator's work (0.11/07) ─────────────────────────────────────────

/** An artifact form's condition when the raise named none. */
export const SIGNAL_DEFAULT_MIN_WORDS = 1;
/** The longest artifact form condition. */
export const SIGNAL_MAX_MIN_WORDS = 100_000;
/**
 * The longest title a form may ask for, and the most labels it may carry.
 * Both are artifact bounds (`shared/artifact.ts`, `shared/artifact-labels.ts`)
 * applied where artifacts live: this module may import nothing but `effect`
 * and its wire siblings, so it bounds what it can and main settles the rest
 * (the title it stores is cut to the artifact's own length, and the labels it
 * stores are folded by the artifact label rule).
 */
export const SIGNAL_FORM_TITLE_MAX_LENGTH = 280;
export const SIGNAL_FORM_LABELS_MAX = 20;

/**
 * A variable name a process environment accepts, as a region's sources name
 * one: the same bound `automation.ts` gives a code step's secret, so a name
 * the automation editor takes is never one this refuses.
 */
export const SIGNAL_SECRET_NAME_MAX_LENGTH = 128;
const SignalSecretName = Schema.String.pipe(
  Schema.check(Schema.isPattern(/^[A-Za-z_][A-Za-z0-9_]*$/)),
  Schema.check(Schema.isMaxLength(SIGNAL_SECRET_NAME_MAX_LENGTH)),
);

/**
 * Who raised a signal. A seat signal names its seat; an automation signal
 * names the Automations node and the automation, and never a seat.
 */
export const SignalSource = Schema.Union([
  Schema.Struct({ kind: Schema.Literal("seat"), nodeId: WireNodeId }),
  Schema.Struct({
    kind: Schema.Literal("automation"),
    automationId: WireItemId,
    nodeId: WireNodeId,
  }),
]);
export type SignalSource = typeof SignalSource.Type;

/** When work is due, and whether whoever raised it marked it urgent (a work signal only). */
export const WorkTiming = Schema.Struct({
  /** Epoch ms. */
  dueAt: Schema.optionalKey(Schema.Number.check(Schema.isGreaterThanOrEqualTo(0))),
  urgent: Schema.optionalKey(Schema.Boolean),
});
export type WorkTiming = typeof WorkTiming.Type;

/**
 * What a signal asks the operator to produce. The raise names it; main
 * resolves the fields a window may not choose (the artifact node's id, the
 * hidden request for a secret) before it stores the form below.
 *
 * One form per signal in this version.
 */
export const SignalFormRequest = Schema.Union([
  Schema.Struct({ kind: Schema.Literal("text") }),
  Schema.Struct({
    kind: Schema.Literal("artifact"),
    /** The Artifacts node, as the raiser named it; main resolves it in reach. */
    node: Schema.String.pipe(Schema.check(Schema.isMinLength(1))),
    /** The document's title; the raise defaults it to the signal's text. */
    title: Schema.optionalKey(
      Schema.String.pipe(
        Schema.check(Schema.isMinLength(1)),
        Schema.check(Schema.isMaxLength(SIGNAL_FORM_TITLE_MAX_LENGTH)),
      ),
    ),
    labels: Schema.optionalKey(Schema.Array(Schema.String)),
    /** The condition: at least this many words. */
    minWords: Schema.optionalKey(
      Schema.Int.check(Schema.isBetween({ minimum: SIGNAL_DEFAULT_MIN_WORDS, maximum: SIGNAL_MAX_MIN_WORDS })),
    ),
  }),
  Schema.Struct({ kind: Schema.Literal("secret"), name: SignalSecretName }),
  Schema.Struct({ kind: Schema.Literal("proof") }),
]);
export type SignalFormRequest = typeof SignalFormRequest.Type;

/**
 * A form as stored on the signal: the request with the resolved artifact
 * node, title, canonical labels and condition, or the secret request the
 * asking machine recorded.
 */
export const SignalForm = Schema.Union([
  Schema.Struct({ kind: Schema.Literal("text") }),
  Schema.Struct({
    kind: Schema.Literal("artifact"),
    nodeId: WireNodeId,
    title: Schema.String.pipe(
      Schema.check(Schema.isMinLength(1)),
      Schema.check(Schema.isMaxLength(SIGNAL_FORM_TITLE_MAX_LENGTH)),
    ),
    labels: Schema.Array(Schema.String).check(Schema.isMaxLength(SIGNAL_FORM_LABELS_MAX)),
    minWords: Schema.Int.check(Schema.isBetween({ minimum: SIGNAL_DEFAULT_MIN_WORDS, maximum: SIGNAL_MAX_MIN_WORDS })),
  }),
  Schema.Struct({
    kind: Schema.Literal("secret"),
    name: SignalSecretName,
    /** The asking machine's own record of the request (its `agent_signal_secret_requests` row). */
    requestId: Schema.String.pipe(Schema.check(Schema.isMinLength(1))),
    regionId: Schema.String.pipe(Schema.check(Schema.isMinLength(1))),
    /** The machine the value is for, by its real short name. */
    machine: Schema.String.pipe(Schema.check(Schema.isMinLength(1))),
  }),
  Schema.Struct({ kind: Schema.Literal("proof") }),
]);
export type SignalForm = typeof SignalForm.Type;

/** The document a reply made, and the condition it met. */
export const SignalReplyArtifact = Schema.Struct({
  nodeId: WireNodeId,
  artifactId: WireItemId,
  title: Schema.String.pipe(Schema.check(Schema.isMinLength(1)), Schema.check(Schema.isMaxLength(SIGNAL_FORM_TITLE_MAX_LENGTH))),
  /** Words in the markdown, by the one word rule (`word-count.ts`). */
  words: Schema.Int.check(Schema.isGreaterThanOrEqualTo(0)),
});
export type SignalReplyArtifact = typeof SignalReplyArtifact.Type;

/** A secret's reply, by name only: the value is never here. */
export const SignalReplySecret = Schema.Struct({
  /** The vault item or the local secret id the value went to. */
  item: Schema.String.pipe(Schema.check(Schema.isMinLength(1))),
  name: SignalSecretName,
  regionId: Schema.String.pipe(Schema.check(Schema.isMinLength(1))),
  machine: Schema.String.pipe(Schema.check(Schema.isMinLength(1))),
  /** Epoch ms the vault or store confirmed it. */
  setAt: Schema.Number,
});
export type SignalReplySecret = typeof SignalReplySecret.Type;

export const AgentSignalResponse = Schema.Struct({
  text: AgentSignalResponseText,
  /** Epoch ms. */
  at: Schema.Number,
  /** Files the operator sent with the answer, in order. Absent when there are none. */
  attachments: Schema.optionalKey(Schema.Array(ContentRef)),
  /** The document an artifact form's reply made. */
  artifact: Schema.optionalKey(SignalReplyArtifact),
  /** The names a secret form's reply set; never the value. */
  secret: Schema.optionalKey(SignalReplySecret),
  /** Links a proof carries, in the order given. */
  links: Schema.optionalKey(Schema.Array(Schema.String)),
});
export type AgentSignalResponse = typeof AgentSignalResponse.Type;

export const AgentSignal = Schema.Struct({
  signalId: Schema.String,
  canvasName: Schema.String,
  /** The seat's node, or the Automations node for an automation's signal. */
  nodeId: Schema.String,
  /**
   * Who raised it. Absent on a signal a seat raised, which is every signal
   * before automations could raise one: a seat signal's source is its own
   * `nodeId`. Present names the automation, and `nodeId` is its node.
   */
  source: Schema.optionalKey(SignalSource),
  kind: AgentSignalKind,
  text: AgentSignalText,
  detail: Schema.optionalKey(AgentSignalDetail),
  /** When work is due; present only on a work signal. */
  work: Schema.optionalKey(WorkTiming),
  /** What the operator must produce; one per signal. Absent when it asks for nothing. */
  form: Schema.optionalKey(SignalForm),
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
