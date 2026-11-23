import { useCallback, useEffect, useMemo, useRef, useState, type KeyboardEvent, type ReactNode, type Ref, type RefObject } from "react";
import { MAIL_TEXT_INLINE_MAX_BYTES, type TextBound } from "@shared/mail-text-bound";
import type { NodeKind } from "@shared/model/kinds";
import type { NodeId } from "@shared/physics/schema";
import { claimFocusOnMount } from "../../lib/focus-ownership";
import { keyIs } from "../../lib/key-match";
import { useContentCalls } from "../../lib/content-calls";
import { carryText, useLongText } from "../../lib/long-text";
import { useMentionItems } from "../../lib/mention-items";
import { useResourcesInReachOfAll, useSeatsConnectedToAll } from "../../lib/mention-sources";
import { useAttachments } from "../../lib/operator-attachments";
import {
  sendNewThreads,
  sendSeatThread,
  THREAD_TEXT_MAX,
  type HeldThreadDraft,
  type NewThreadsOutcome,
  type SeatAddress,
  type ThreadRecipient,
} from "../../lib/seat-threads";
import { useCanvas } from "../../lib/use-model";
import { AttachButton, AttachmentTray } from "../attachments/AttachmentTray";
import { Button } from "../ui/Button";
import { Chip } from "../ui/Chip";
import { MentionCombobox } from "../ui/MentionCombobox";

/** Main's bound on a thread mail's text: past it the text goes as a file. */
const THREAD_BOUND: TextBound = { bytes: MAIL_TEXT_INLINE_MAX_BYTES, characters: THREAD_TEXT_MAX };

type Shared = {
  /** New thread only: leave without sending. */
  readonly onCancel?: () => void;
  /** Asked as the field mounts: true leaves the keyboard where the operator has it. */
  readonly yields?: () => boolean;
};

/** The mail a send wrote, and whether its seat has it yet. */
export type SentMail = {
  readonly messageId: string;
  /** Written, and not with its seat: anything short of delivered. */
  readonly waiting: boolean;
};

/** In one seat's threads: a reply in a thread, or a new thread to that seat. */
type ToOneSeat = Shared & {
  readonly seat: SeatAddress;
  /** The seat's name: the one recipient, for the hint and the To line. */
  readonly name: string;
  readonly mode: "reply" | "new";
  /** Reply: the thread written in. */
  readonly threadId?: string;
  /** Reply: the mail answered, when known; it names the thread too. */
  readonly inReplyTo?: string;
  /** Sent: the thread it went in (a new thread's own id), and the mail as the send answered for it. */
  readonly onSent?: (threadId: string, mail: SentMail) => void;
};

/** New threads to the seats the operator chose, one each (Quick thread). */
type ToRecipients = Shared & {
  readonly mode: "new";
  readonly canvasName: string;
  /** Who it goes to, in the order chosen. With none nothing sends. */
  readonly recipients: ReadonlyArray<ThreadRecipient>;
  /** The row that shows and changes them, where the To line would be. */
  readonly recipientsRow: ReactNode;
  /**
   * The send ended: the thread each seat got, and each seat that got none.
   * With any unsent the draft is kept, for the host to send again to those.
   */
  readonly onSentAll?: (outcome: NewThreadsOutcome) => void;
  /** A send started or ended, for a host that holds its row still meanwhile. */
  readonly onSending?: (sending: boolean) => void;
  /**
   * Asked as Send is pressed with something to send: true, and nothing goes
   * now. The host has the press, to ask first, and sends through `sender`.
   */
  readonly holds?: () => boolean;
  /**
   * Filled with the send itself, to exactly the seats it is given and no
   * others, whatever `recipients` reads by then: what a host confirmed is
   * what goes. `holds` is not asked again. Empty once the input is gone.
   */
  readonly sender?: RefObject<((to: ReadonlyArray<ThreadRecipient>) => void) | null>;
  /** Keep the draft here, past this composer's own life. */
  readonly held?: HeldThreadDraft;
  /** The field, for a host that moves the keyboard to it once a seat is chosen. */
  readonly fieldRef?: Ref<HTMLTextAreaElement>;
};

/**
 * The operator writes in a seat's threads: a reply in a thread they are in,
 * or a new thread to the seat. Enter sends, Shift+Enter is a new line, @
 * opens the seats wired to this one and the pages in its reach, and # the
 * tasks and artifacts in its reach. The mail goes to this seat alone: a
 * mention is a reference, its seat gets no copy and does not join the thread. Past
 * main's bound the text goes as a file, attached. A refused send says
 * main's message as is and keeps the draft.
 *
 * With `recipients` it is the same input for a new thread to each of several
 * seats: the same text and files go to every one, @ and # offer only what
 * every one of them may be sent (so no send is refused for a mention), and a
 * seat that got nothing is named to the host while the draft stays.
 */
export function ThreadComposer(props: ToOneSeat | ToRecipients) {
  const several = "recipients" in props;
  const { mode, onCancel, yields } = props;
  const canvasName = several ? props.canvasName : props.seat.canvasName;
  const recipients: ReadonlyArray<ThreadRecipient> = several ? props.recipients : [{ seatId: props.seat.seatId, name: props.name }];
  const seatIds = recipients.map((recipient) => recipient.seatId);
  const held = several ? props.held : undefined;
  const connected = useSeatsConnectedToAll(canvasName, seatIds);
  const inReach = useResourcesInReachOfAll(canvasName, seatIds, useMentionItems(canvasName));
  const candidates = useMemo(() => [...connected, ...inReach], [connected, inReach]);
  const attachments = useAttachments(canvasName, held?.files);
  const content = useContentCalls();
  // A held draft is read back as it was written, whoever may be mentioned now: its links name nodes of this canvas.
  const canvas = useCanvas(canvasName);
  const kindOnCanvas = useCallback((nodeId: NodeId): NodeKind | undefined => canvas.nodes.get(nodeId)?.kind, [canvas]);
  const [draft, setDraft] = useState(() => held?.text() ?? "");
  const write = (next: string): void => {
    setDraft(next);
    held?.keepText(next);
  };
  const [sending, setSending] = useState(false);
  const onSending = useRef(several ? props.onSending : undefined);
  onSending.current = several ? props.onSending : undefined;
  useEffect(() => {
    onSending.current?.(sending);
  }, [sending]);
  const [failure, setFailure] = useState<string>();
  // The field takes the keyboard once, when it mounts, unless it is asked to
  // yield. The combobox hands its field over again on every render, so the
  // one already taken is remembered: mail landing in the thread must not pull
  // the keyboard back from the stream or the list.
  const yieldsNow = useRef(yields);
  yieldsNow.current = yields;
  const taken = useRef<HTMLTextAreaElement | null>(null);
  const hostField = useRef(several ? props.fieldRef : undefined);
  hostField.current = several ? props.fieldRef : undefined;
  const setField = useCallback((element: HTMLTextAreaElement | null) => {
    const host = hostField.current;
    if (typeof host === "function") host(element);
    else if (host) (host as { current: HTMLTextAreaElement | null }).current = element;
    if (element === null || element === taken.current) return;
    taken.current = element;
    if (yieldsNow.current?.() !== true) claimFocusOnMount(element);
  }, []);


  // Files ride along: a mail may be only files, and waits for every one to be in.
  const hasFiles = attachments.items.length > 0;
  const uploading = attachments.items.some((item) => item.state === "uploading");
  const long = useLongText(draft.trim(), attachments.items.length, THREAD_BOUND);
  const unsendable =
    long.blocked || (draft.trim() === "" && !hasFiles) || attachments.ready === undefined || recipients.length === 0;

  const send = async (fixed?: ReadonlyArray<ThreadRecipient>): Promise<void> => {
    const text = draft.trim();
    const files = attachments.ready;
    if (unsendable || files === undefined || sending) return;
    if (fixed === undefined ? several && props.holds?.() === true : fixed.length === 0) return;
    setSending(true);
    setFailure(undefined);
    let carried: Awaited<ReturnType<typeof carryText>>;
    try {
      carried = await carryText(content, canvasName, text, files, THREAD_BOUND);
    } catch (error) {
      setSending(false);
      setFailure(error instanceof Error ? error.message : String(error));
      return;
    }
    const mail = { text: carried.text, ...(carried.files.length > 0 ? { attachments: carried.files } : {}) };
    if (several) {
      const outcome = await sendNewThreads(canvasName, fixed?.map((recipient) => recipient.seatId) ?? seatIds, mail);
      setSending(false);
      // Any seat left unsent keeps the draft: the host says which, and Send goes to those.
      if (outcome.failed.length === 0) {
        write("");
        attachments.clear();
      }
      props.onSentAll?.(outcome);
      return;
    }
    const { seat, threadId, inReplyTo } = props;
    const result = await sendSeatThread({
      ...seat,
      ...mail,
      ...(mode === "reply" && inReplyTo !== undefined ? { inReplyTo } : {}),
      ...(mode === "reply" && inReplyTo === undefined && threadId !== undefined ? { threadId } : {}),
    });
    setSending(false);
    if (!result.ok) {
      setFailure(result.message);
      return;
    }
    write("");
    attachments.clear();
    props.onSent?.(result.threadId, { messageId: result.messageId, waiting: result.delivery !== "delivered" });
  };

  // The host's way to send, as this render knows the draft and its files.
  const sender = several ? props.sender : undefined;
  const sendNow = useRef(send);
  sendNow.current = send;
  useEffect(() => {
    if (sender === undefined) return;
    sender.current = (to) => void sendNow.current(to);
    return () => {
      sender.current = null;
    };
  }, [sender]);

  // The list takes its own keys first; what reaches here is the composer's.
  const onKeyDown = (event: KeyboardEvent<HTMLTextAreaElement>): void => {
    if (event.nativeEvent.isComposing) return;
    // The key table's send for every thread input: Keyboard settings and the
    // help say what this field does, and a change there changes it here.
    if (keyIs(event, "inThread.send")) {
      event.preventDefault();
      void send();
    }
  };

  // One seat is named; several are counted, since the row above names them.
  const only = recipients.length === 1 ? recipients[0]!.name : undefined;
  const wired = only === undefined ? "" : `@ names a seat connected to ${only}, who gets no copy`;
  const hint = several
    ? recipients.length > 1
      ? "One thread for each seat"
      : wired
    : mode === "reply"
      ? `Enter sends, Shift+Enter is a new line, ${wired}`
      : wired;
  const fieldLabel =
    mode === "reply"
      ? "Reply"
      : only !== undefined
        ? `New thread to ${only}`
        : recipients.length === 0
          ? "New thread"
          : `New thread to ${recipients.length} seats`;
  // Several seats: the count is said before it happens.
  const sendLabel = several
    ? sending
      ? "Sending"
      : recipients.length > 1
        ? `Send to ${recipients.length}`
        : "Send"
    : mode === "new"
      ? "Start thread"
      : "Send";
  return (
    <div
      className="thread-composer"
      data-testid="thread-composer"
      data-mode={mode}
      data-recipients={several ? recipients.length : undefined}
      {...attachments.dropTarget}
    >
      {several ? (
        props.recipientsRow
      ) : mode === "new" ? (
        <div className="thread-composer__to" data-testid="thread-composer-to">
          <span>To</span>
          <Chip tone="steel">{props.name}</Chip>
        </div>
      ) : null}
      <div className="thread-composer__field">
        <MentionCombobox
          fieldRef={setField}
          dense
          // At the foot of a pane the list opens over the field; under a row of recipients, below it.
          placement={several ? "below" : "above"}
          value={draft}
          onValueChange={(next) => {
            write(next);
            setFailure(undefined);
          }}
          canvasName={canvasName}
          candidates={candidates}
          {...(held === undefined ? {} : { nodeKindOf: kindOnCanvas })}
          listLabel={(trigger) => {
            const whose = only ?? "every seat chosen";
            return trigger === "@" ? `Seats connected to ${whose}, and pages in reach` : `Tasks and artifacts in reach of ${whose}`;
          }}
          aria-label={fieldLabel}
          placeholder={mode === "new" ? "Write the first line" : "Reply to the thread"}
          data-testid="thread-composer-input"
          onKeyDown={onKeyDown}
        />
        <AttachmentTray attachments={attachments} />
        <div className="thread-composer__bar">
          {failure ? (
            <span className="thread-composer__failure" role="alert" data-testid="thread-composer-failure">
              {failure}
            </span>
          ) : long.notice ? (
            <span
              className={long.blocked ? "thread-composer__failure" : "thread-composer__hint"}
              role="status"
              data-testid="thread-composer-long-text"
            >
              {long.notice}
            </span>
          ) : uploading ? (
            <span className="thread-composer__hint" data-testid="thread-composer-uploading">
              Attaching files, then it sends.
            </span>
          ) : hasFiles && attachments.ready === undefined ? (
            <span className="thread-composer__hint" data-testid="thread-composer-file-failed">
              Remove the file that did not attach, or add it again.
            </span>
          ) : (
            <span className="thread-composer__hint">{hint}</span>
          )}
          <AttachButton attachments={attachments} disabled={sending} />
          {mode === "new" && onCancel ? (
            <Button size="sm" variant="chrome" disabled={sending} onClick={onCancel}>
              Cancel
            </Button>
          ) : null}
          <Button
            size="sm"
            variant="primary"
            disabled={sending || unsendable}
            data-testid="thread-composer-send"
            onClick={() => void send()}
          >
            {sendLabel}
          </Button>
        </div>
      </div>
    </div>
  );
}
