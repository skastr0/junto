// Pure helpers for the one-way message nudge channel.
// Actor delivery is kind-discriminated (actor-surface sum) — never ACP.
// The runtime projection carries delivery state from normalized message rows:
// delivered = metadata.deliveredAt stamped.

import { decodeTime } from "ulid";
import type { Node } from "./model";
import type { Message } from "./work-model";
import type { SurfaceDeliveryTarget } from "./actor-surface";
import { readMailExtension } from "./crew";

const ULID_PATTERN = /^[0-9A-HJKMNP-TV-Z]{26}$/;

/** Birth time from a ULID message id. Non-ULID ids have no time. */
export const messageIdTimeMs = (id: string): number | undefined => {
  if (!ULID_PATTERN.test(id)) return undefined;
  try {
    return decodeTime(id);
  } catch {
    return undefined;
  }
};

/** Newest first. ULID ids order by birth; non-ULID ids sink. */
export const compareMessageIdsNewestFirst = (a: string, b: string): number => {
  const aMs = messageIdTimeMs(a);
  const bMs = messageIdTimeMs(b);
  if (aMs !== undefined && bMs !== undefined) return b.localeCompare(a);
  if (aMs !== undefined) return -1;
  if (bMs !== undefined) return 1;
  return b.localeCompare(a);
};

export const sortMessagesNewestFirst = (
  messages: ReadonlyArray<Message>,
): Message[] =>
  [...messages].sort((a, b) =>
    compareMessageIdsNewestFirst(a.messageId, b.messageId),
  );

/**
 * Strip C0/C1 controls (and DEL) so a delivered line never carries CSI/ESC
 * inject material into a PTY. Whitespace is collapsed to a single line.
 */
export const sanitizeDeliveryLine = (text: string): string =>
  text
    .replace(/[\u0000-\u001f\u007f-\u009f]/g, " ")
    .replace(/\s+/g, " ")
    .trim();

/**
 * Max brief length that may ride the PTY as the full one-liner, for mail that
 * is not factory mail. Longer bodies become a summary pointer instead.
 */
export const MESSAGE_PTY_FULL_BODY_MAX = 160;

/**
 * The most of a factory notice's body typed into a seat, in characters.
 * Longer mail is cut there with a pointer to `junto msg read` for the rest.
 */
export const MAIL_TYPED_BODY_MAX = 2_500;

/** Preview length inside a summary line (before the CLI pointer). */
export const MESSAGE_PTY_SUMMARY_PREVIEW_MAX = 48;

/** True when metadata.factoryMail is the boolean true (peer factory mail). */
export const isFactoryMailMessage = (message: Message): boolean =>
  message.metadata?.factoryMail === true;

/**
 * Full body may paste only when short AND not factory mail.
 * Factory mail and long bodies always summarize.
 */
export const shouldSummarizeMessageForPty = (message: Message): boolean => {
  if (isFactoryMailMessage(message)) return true;
  return messageBriefText(message).length > MESSAGE_PTY_FULL_BODY_MAX;
};

const shortMessageId = (messageId: string): string =>
  messageId.length > 12 ? messageId.slice(0, 12) : messageId;

const factoryMailFromSeat = (message: Message): string | undefined => {
  const raw = message.metadata?.senderName ?? message.metadata?.senderNodeId ?? message.metadata?.fromSeat;
  if (typeof raw !== "string") return undefined;
  const trimmed = sanitizeDeliveryLine(raw);
  return trimmed.length > 0 ? trimmed.slice(0, 32) : undefined;
};

/** Strip only a recognized envelope; sender text elsewhere remains the body. */
export const stripFactoryEnvelope = (text: string, message: Message): string => {
  const body = text.replace(/^\[factory mail from [^\]]*\]\s*/i, "").trim();
  const labels = [message.metadata?.senderName, message.metadata?.senderNodeId, message.metadata?.fromSeat]
    .filter((value): value is string => typeof value === "string")
    .map(sanitizeDeliveryLine)
    .filter(Boolean)
    .sort((a, b) => b.length - a.length);
  for (const label of labels) {
    const prefix = `mail from ${label}`;
    if (body.startsWith(prefix) && (body.length === prefix.length || /\s/.test(body[prefix.length]!))) {
      return body.slice(prefix.length).trim();
    }
  }
  return body;
};

const briefWithoutFactoryEnvelope = (message: Message): string =>
  stripFactoryEnvelope(messageBriefText(message), message);

/**
 * Rides the mail line of a seat that has not run `junto onboard` yet. Mail is
 * often the first thing a fresh seat sees, and nothing else has told it where
 * it is. Part of the line itself: never a separate message.
 */
export const MAIL_ONBOARD_POINTER = "new to this seat? run `junto onboard` first";

/** Who sent a mail, as the recipient reads it, and where a reply goes. */
export type MailSender = {
  /** The sender as one line: "cli-lead (Junto / CLI)". */
  readonly label: string;
  /** `junto msg reply`'s target: the sender's node id. Absent: no reply command. */
  readonly replyTarget?: string;
};

/** What the composer knows about the destination seat. */
export type MailLineOptions = {
  /** False adds the onboard pointer. Absent means onboarded: no pointer. */
  readonly onboarded?: boolean;
  /** The sender as the canvas names it at delivery. Absent: as the mail was stamped. */
  readonly sender?: MailSender;
};

const withOnboardPointer = (line: string, options: MailLineOptions | undefined): string =>
  options?.onboarded === false ? `${line} — ${MAIL_ONBOARD_POINTER}` : line;

/** The mail's text as typed: its lines kept, terminal controls stripped, the old envelope dropped. */
const typedBody = (message: Message): string => {
  const raw = message.parts
    .filter((part) => part.kind === "text")
    .map((part) => part.text)
    .join("\n")
    .replace(/\r\n?/g, "\n")
    .replace(/[\u0000-\u0008\u000b-\u001f\u007f-\u009f]/g, "")
    .trim();
  return stripFactoryEnvelope(raw, message);
};

/** A prompt: the sender asked for its full text, typed as is. */
const isPromptMail = (message: Message): boolean => readMailExtension(message.metadata)?.mailKind === "prompt";

/** The sender as the mail was stamped, when the canvas has not named it. */
const stampedSender = (message: Message): MailSender => {
  const node = message.metadata?.senderNodeId;
  const target = typeof node === "string" ? sanitizeDeliveryLine(node) : "";
  return { label: factoryMailFromSeat(message) ?? "seat", ...(target === "" ? {} : { replyTarget: target }) };
};

/** The thread a notice is a reply in; undefined for a thread's own root. */
const replyThreadOf = (message: Message): string | undefined => {
  const thread = message.metadata?.threadId;
  if (typeof thread !== "string") return undefined;
  const id = sanitizeDeliveryLine(thread);
  return id === "" || id === message.messageId ? undefined : id;
};

/**
 * The header a factory notice and a prompt share: who sent it and the regions
 * around them, its id, its thread when it is a reply, and the exact
 * `junto msg reply` that answers it.
 */
const mailHeader = (message: Message, options: MailLineOptions | undefined): string => {
  const sender = options?.sender ?? stampedSender(message);
  const id = sanitizeDeliveryLine(message.messageId);
  const thread = replyThreadOf(message);
  const named = [`mail from ${sanitizeDeliveryLine(sender.label)}`, `id ${id}`, ...(thread === undefined ? [] : [`thread ${thread}`])].join(", ");
  const reply = sender.replyTarget === undefined
    ? ""
    : ` — reply: junto msg reply '${JSON.stringify({ target: sanitizeDeliveryLine(sender.replyTarget), inReplyTo: id, text: "..." })}'`;
  return withOnboardPointer(`${named}${reply}`, options);
};

/**
 * A factory notice, typed whole under the header. Past MAIL_TYPED_BODY_MAX
 * characters the body is cut, with a pointer to `junto msg read` for the rest.
 */
const composeMailNotice = (message: Message, options: MailLineOptions | undefined): string => {
  const id = sanitizeDeliveryLine(message.messageId);
  const characters = [...(typedBody(message) || "(empty)")];
  const body = characters.length > MAIL_TYPED_BODY_MAX
    ? `${characters.slice(0, MAIL_TYPED_BODY_MAX).join("")}\n(cut at ${String(MAIL_TYPED_BODY_MAX)} characters; the rest: junto msg read ${id})`
    : characters.join("");
  return `${mailHeader(message, options)}\n${body}`;
};

/**
 * A prompt, typed whole under the notice's header: its id, its thread, and
 * the reply that answers it. The operator's thread mail is a prompt, and
 * `junto msg reply` with target "operator" is how the seat answers in it.
 */
export const composeImmediatePromptPayload = (
  message: Message,
  options?: MailLineOptions,
): string => `${mailHeader(message, options)}\n${typedBody(message)}`;

/**
 * What a single message types into its seat. Factory notices: whole, under
 * one header. Short ordinary mail: its brief. A long ordinary body: summary +
 * CLI pointer. A destination that has not onboarded gets the onboard pointer
 * on the first line.
 */
export const composeMessageDeliveryPayload = (
  message: Message,
  options?: MailLineOptions,
): string =>
  isFactoryMailMessage(message) ? composeMailNotice(message, options) : withOnboardPointer(composeMailLine(message), options);

/**
 * Mail typed whole is read: the seat has every word of it, so it is marked
 * read when it is typed. A prompt is typed whole, a factory notice within
 * MAIL_TYPED_BODY_MAX characters, and short ordinary mail. Anything cut or
 * summarized stays unread until `junto msg read` or `junto msg list`.
 */
export const mailTypedWhole = (message: Message): boolean => {
  if (isPromptMail(message)) return true;
  if (isFactoryMailMessage(message)) return [...typedBody(message)].length <= MAIL_TYPED_BODY_MAX;
  return !shouldSummarizeMessageForPty(message);
};

/**
 * At most this many characters of mail bodies go into one typed turn: two
 * full-size mails. Past it, each further mail is one line naming its id.
 */
export const MAIL_BATCH_BODY_MAX = 6_000;

/**
 * At most this many mails past the body cap get a line of their own. A seat
 * with thousands waiting otherwise gets a paste thousands of lines long; the
 * rest are counted on one line that lists them.
 */
export const MAIL_BATCH_POINTER_MAX = 20;

/** One mail in a batch, and its sender as the canvas names it at delivery. */
export type BatchedMail = { readonly message: Message; readonly sender?: MailSender };

/** A batch as typed, and, in its order, which of its mails went in whole. */
export type MailBatch = { readonly text: string; readonly whole: ReadonlyArray<boolean> };

/** The characters of a mail's body that a batch types. */
const typedLength = (message: Message): number =>
  isFactoryMailMessage(message)
    ? Math.min([...(typedBody(message) || "(empty)")].length, MAIL_TYPED_BODY_MAX)
    : [...composeMailLine(message)].length;

/** A mail past the batch's cap: who sent it, and how to read it. */
const composeMailPointer = (message: Message, sender: MailSender | undefined): string => {
  const id = sanitizeDeliveryLine(message.messageId);
  return `mail from ${sanitizeDeliveryLine((sender ?? stampedSender(message)).label)}, id ${id} — junto msg read ${id}`;
};

/**
 * Mail for one seat, oldest first, as one typed turn. One mail is typed
 * exactly as it is alone. More open with a count line, then each mail under
 * its own header, whole while their bodies stay within MAIL_BATCH_BODY_MAX;
 * past that, each further mail is one line with its id, up to
 * MAIL_BATCH_POINTER_MAX, and one last line counts the rest with the
 * `junto msg list` that lists them. Mail past the cap stays unread. The
 * onboard pointer rides the first line. Prompts are never batched: the
 * delivery types each one as its own turn.
 */
export const composeMailBatch = (
  mails: ReadonlyArray<BatchedMail>,
  options?: Pick<MailLineOptions, "onboarded">,
): MailBatch => {
  const [only] = mails;
  if (mails.length === 1 && only !== undefined) {
    return {
      text: composeMessageDeliveryPayload(only.message, { ...options, ...(only.sender === undefined ? {} : { sender: only.sender }) }),
      whole: [mailTypedWhole(only.message)],
    };
  }
  let room = MAIL_BATCH_BODY_MAX;
  let past = 0;
  let lastNamed = "";
  const sections: string[] = [];
  const whole: boolean[] = [];
  for (const { message, sender } of mails) {
    const length = typedLength(message);
    if (past > 0 || length > room) {
      past += 1;
      whole.push(false);
      if (past > MAIL_BATCH_POINTER_MAX) continue;
      sections.push(composeMailPointer(message, sender));
      lastNamed = message.messageId;
      continue;
    }
    room -= length;
    sections.push(composeMessageDeliveryPayload(message, sender === undefined ? {} : { sender }));
    whole.push(mailTypedWhole(message));
  }
  const counted = past - MAIL_BATCH_POINTER_MAX;
  if (counted > 0) {
    const list = JSON.stringify({ unread: true, since: sanitizeDeliveryLine(lastNamed) });
    sections.push(`${String(counted)} more ${counted === 1 ? "mail" : "mails"}, unread — junto msg list '${list}'`);
  }
  const cap =
    past === 0
      ? ""
      : `; the last ${String(past)} are past the ${String(MAIL_BATCH_BODY_MAX)}-character cap, ${counted > 0 ? `the first ${String(MAIL_BATCH_POINTER_MAX)} by id and the rest counted` : "by id only"}`;
  return { text: [withOnboardPointer(`${String(mails.length)} mails, oldest first${cap}`, options), ...sections].join("\n\n"), whole };
};

const composeMailLine = (message: Message): string => {
  if (!shouldSummarizeMessageForPty(message)) {
    const sender = messageSenderLabel(message);
    const brief = messageBriefText(message);
    const task =
      typeof message.taskId === "string" && message.taskId.trim().length > 0
        ? ` - task ${sanitizeDeliveryLine(message.taskId)}`
        : "";
    return sanitizeDeliveryLine(`[message - ${sender}] ${brief}${task}`);
  }
  return composeMessageDeliverySummary([message]);
};

/**
 * One PTY notify line for unread mail on the same seat.
 * Cadence: N === 1 is the latest unread; N > 1 is one newest-first list.
 * Never serial dumps. Bodies stay in the mailbox.
 */
export const composeMessageDeliverySummary = (
  messages: ReadonlyArray<Message>,
): string => {
  const ordered = sortMessagesNewestFirst(messages);
  if (ordered.length === 0) {
    return sanitizeDeliveryLine("[message] (empty)");
  }
  if (ordered.length === 1) {
    const message = ordered[0]!;
    if (!shouldSummarizeMessageForPty(message)) {
      return composeMailLine(message);
    }
    const id = sanitizeDeliveryLine(message.messageId);
    const from = factoryMailFromSeat(message);
    const fromBit = from ? ` from ${from}` : "";
    const previewRaw = briefWithoutFactoryEnvelope(message);
    const preview =
      previewRaw.length > MESSAGE_PTY_SUMMARY_PREVIEW_MAX
        ? `${previewRaw.slice(0, MESSAGE_PTY_SUMMARY_PREVIEW_MAX)}…`
        : previewRaw;
    const previewBit = preview.length > 0 ? ` — ${preview}` : "";
    return sanitizeDeliveryLine(
      `mail${fromBit}${previewBit} — junto msg read ${id}`,
    );
  }
  const senders = [...new Set(ordered.map(factoryMailFromSeat).filter((from) => from !== undefined))];
  const fromBit = senders.length > 0 ? ` from ${senders.slice(0, 3).join(", ")}` : "";
  const ids = ordered
    .slice(0, 3)
    .map((m) => shortMessageId(m.messageId))
    .join(",");
  const more =
    ordered.length > 3 ? ` +${String(ordered.length - 3)}` : "";
  return sanitizeDeliveryLine(
    `mail${fromBit} — ${String(ordered.length)} unread — ${ids}${more} — junto msg list`,
  );
};

/**
 * Sender label for the nudge line. Prefer role only — free metadata.sender
 * is spoofable on authorial writes and must not mint an "operator" trust label.
 */
export const messageSenderLabel = (message: Message): string => message.role;

export const messageBriefText = (message: Message): string => {
  const chunks: string[] = [];
  for (const part of message.parts) {
    if (part.kind !== "text") continue;
    const line = sanitizeDeliveryLine(part.text);
    if (line) chunks.push(line);
  }
  return chunks.join(" ") || "(empty)";
};

/** True when metadata.deliveredAt is a finite number (already nudged the PTY). */
export const isMessageDelivered = (message: Message): boolean => {
  const at = message.metadata?.deliveredAt;
  return typeof at === "number" && Number.isFinite(at);
};

/** True when metadata.readAt is a finite number (mailbox listed or marked read). */
export const isMessageRead = (message: Message): boolean => {
  const at = message.metadata?.readAt;
  return typeof at === "number" && Number.isFinite(at);
};

/**
 * Own-echo guard: role "agent" is from the live process behind the node —
 * never send those back. Role "user" (and any other non-agent role) is foreign.
 */
export const isForeignMessage = (message: Message): boolean => message.role !== "agent";

/**
 * Needs a PTY notify: foreign, still unread, and not yet nudged.
 * Listed mail is read — do not inject it. deliveredAt is only the
 * at-most-once notify receipt, not a product status.
 */
export const isPendingDelivery = (message: Message): boolean =>
  isForeignMessage(message) && !isMessageRead(message) && !isMessageDelivered(message);

/**
 * Resolve transport target from kind-discriminated actor surface.
 * No optional-field OR. No ACP. Illegal agent shapes → undefined.
 *
 * The wire target sum itself is {@link SurfaceDeliveryTarget}, declared once
 * beside the surfaces it is derived from.
 */
export const deliveryTargetOf = (
  node: Node,
): SurfaceDeliveryTarget | undefined => {
  return node.kind === "agent" ? { bindingId: node.bindingId } : undefined;
};
