import { Schema } from "effect";
import { mailExtensionMetadata, type MailMessageId, type MailSenderStamp } from "./crew";
import type { NodeId } from "./physics/schema";
import { threadSubjectMetadata, type ResourceSubject } from "./thread-subject";
import { noticeSenderStamp } from "./mail-sender";
import type { WorkErrorBody } from "./work-control";
import type { ItemId, OpId } from "./work-ids";

/**
 * Notices in a subject thread (plan 0.10, 03 section 4 and 02 queued writes).
 * A comment, a mention, an assignment or a stamp request on a resource puts
 * one row in each recipient's mailbox; a refused resource command puts one in
 * the actor seat's own. Each is mail kind `notice`, carries its subject and
 * thread, and has an id derived from what caused it, so writing it twice
 * writes one row: the second append meets `identity-conflict` at the sink.
 *
 * A ruling's notices are written by each recipient seat's own machine, into
 * that seat's own mailbox (`ruling-notices.ts`). Pure: no I/O, no clock.
 */

/** Why a seat got the notice. Closed: delivery and the header match on it. */
export const SubjectNoticeKind = Schema.Literals(["comment", "mention", "assignment", "stamp-request", "defect", "refusal"]);
export type SubjectNoticeKind = typeof SubjectNoticeKind.Type;

/** The metadata key a notice names its kind under. */
export const SUBJECT_NOTICE_KEY = "subjectNotice";

const isNoticeKind = Schema.is(SubjectNoticeKind);

/** A row's notice kind, or undefined when it is not a subject notice. */
export const subjectNoticeKindOf = (message: {
  readonly metadata?: Readonly<Record<string, unknown>> | undefined;
}): SubjectNoticeKind | undefined => {
  const held = message.metadata?.[SUBJECT_NOTICE_KEY];
  return isNoticeKind(held) ? held : undefined;
};

/** A refusal is written from the refused node and carries no reply command. */
export const noticeTakesReply = (kind: SubjectNoticeKind): boolean => {
  switch (kind) {
    case "comment":
    case "mention":
    case "assignment":
    case "stamp-request":
    case "defect":
      return true;
    case "refusal":
      return false;
  }
};

// ---- Derived ids ----

const CROCKFORD = "0123456789ABCDEFGHJKMNPQRSTVWXYZ";
const FNV_PRIME = 0x100000001b3n;
const MASK_64 = 0xffffffffffffffffn;

/** FNV-1a over UTF-8, 64 bits, from a chosen basis so two passes are independent. */
const fnv1a64 = (bytes: Uint8Array, basis: bigint): bigint => {
  let hash = basis;
  for (const byte of bytes) hash = ((hash ^ BigInt(byte)) * FNV_PRIME) & MASK_64;
  return hash;
};

/** The source of a derived id: what caused the notice, and where. */
export type NoticeSource = {
  /** The installation whose machine wrote the cause: the ruler keys ops by it. */
  readonly installationId: string;
  /** The cause: a resource command's opId, or a comment's id. Its time is the notice's. */
  readonly sourceId: OpId | ItemId | MailMessageId;
  readonly kind: SubjectNoticeKind;
  readonly recipient: NodeId;
};

/**
 * A notice's id: a ULID whose time is its cause's and whose 80 random bits
 * are a hash of (installation, cause, kind, recipient). The same cause to the
 * same seat for the same reason is always the same id; one op that assigns a
 * seat and mentions it gives that seat two notices.
 */
export const subjectNoticeId = (source: NoticeSource): MailMessageId => {
  const key = new TextEncoder().encode(
    JSON.stringify([source.installationId, source.sourceId, source.kind, source.recipient]),
  );
  const high = fnv1a64(key, 0xcbf29ce484222325n);
  const low = fnv1a64(key, 0x84222325cbf29ce4n) & 0xffffn;
  let bits = (high << 16n) | low;
  let random = "";
  for (let index = 0; index < 16; index += 1) {
    random = CROCKFORD[Number(bits & 31n)]! + random;
    bits >>= 5n;
  }
  return `${source.sourceId.slice(0, 10)}${random}` as MailMessageId;
};

// ---- Rows ----

type NoticeBase = {
  readonly installationId: string;
  readonly subject: ResourceSubject;
  /** The subject thread the notice sits in. */
  readonly threadId: MailMessageId;
  readonly recipient: NodeId;
  readonly text: string;
};

/**
 * What a notice is built from. A seat's act is stamped with that seat as the
 * sender; a refusal comes from the refused resource's node.
 */
export type SubjectNoticeInput =
  | (NoticeBase & {
      readonly kind: "comment" | "mention";
      /** The comment row's id. */
      readonly sourceId: ItemId | MailMessageId;
      readonly sender: MailSenderStamp;
    })
  | (NoticeBase & {
      readonly kind: "assignment" | "stamp-request" | "defect";
      readonly sourceId: OpId;
      readonly sender: MailSenderStamp;
    })
  | (NoticeBase & {
      readonly kind: "refusal";
      readonly sourceId: OpId;
      readonly from: { readonly nodeId: NodeId; readonly name: string };
    });

export type SubjectNoticeRow = {
  readonly messageId: MailMessageId;
  readonly text: string;
  readonly metadata: Readonly<Record<string, unknown>>;
};

/** One recipient's notice row: its derived id, text and metadata. */
export const subjectNoticeRow = (input: SubjectNoticeInput): SubjectNoticeRow => {
  const messageId = subjectNoticeId(input);
  const sender = input.kind === "refusal"
    ? mailExtensionMetadata({ ...noticeSenderStamp(input.from.nodeId, input.from.name), mailKind: "notice" })
    : mailExtensionMetadata({ ...input.sender, mailKind: "notice" });
  return {
    messageId,
    text: input.text,
    metadata: {
      factoryMail: true,
      ...sender,
      [SUBJECT_NOTICE_KEY]: input.kind,
      ...threadSubjectMetadata(input.subject),
      threadId: input.threadId,
    },
  };
};

/**
 * One row per recipient, each seat once, the sender never: a seat that
 * mentions itself or comments on its own task is not told about it.
 */
export const subjectNoticeRecipients = (
  recipients: ReadonlyArray<NodeId>,
  sender: NodeId | undefined,
): ReadonlyArray<NodeId> => [...new Set(recipients)].filter((recipient) => recipient !== sender);

// ---- Texts ----

/** A refused command, told to the seat that sent it. */
export type RefusalNotice = {
  /** The command as the seat wrote it, e.g. `task assign`. */
  readonly command: string;
  readonly error: WorkErrorBody;
  /** What it lost to: who assigned what, the new epoch or head. */
  readonly lostTo?: string;
  /** Commands that depended on it and were refused with it. */
  readonly dependents?: ReadonlyArray<OpId>;
};

export const refusalText = (refusal: RefusalNotice): string => {
  const nextStep = refusal.error.details?.next_step;
  return [
    `${refusal.command} was refused: ${refusal.error.message} (${refusal.error.type})`,
    ...(refusal.lostTo === undefined ? [] : [`lost to: ${refusal.lostTo}`]),
    ...(refusal.dependents === undefined || refusal.dependents.length === 0
      ? []
      : [`refused with it: ${refusal.dependents.join(", ")}`]),
    ...(typeof nextStep === "string" && nextStep !== "" ? [`next step: ${nextStep}`] : []),
  ].join("\n");
};
