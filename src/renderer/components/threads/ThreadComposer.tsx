import { useCallback, useMemo, useState, type KeyboardEvent } from "react";
import { MAIL_TEXT_INLINE_MAX_BYTES, type TextBound } from "@shared/mail-text-bound";
import type { NodeId } from "@shared/physics/schema";
import { claimFocusOnMount } from "../../lib/focus-ownership";
import { carryText, useLongText } from "../../lib/long-text";
import { useMentionItems } from "../../lib/mention-items";
import { useConnectedSeats, useResourcesInReach } from "../../lib/mention-sources";
import { useAttachments } from "../../lib/operator-attachments";
import { sendSeatThread, THREAD_TEXT_MAX, type SeatAddress } from "../../lib/seat-threads";
import { AttachButton, AttachmentTray } from "../attachments/AttachmentTray";
import { Button } from "../ui/Button";
import { Chip } from "../ui/Chip";
import { MentionCombobox } from "../ui/MentionCombobox";

/** Main's bound on a thread mail's text: past it the text goes as a file. */
const THREAD_BOUND: TextBound = { bytes: MAIL_TEXT_INLINE_MAX_BYTES, characters: THREAD_TEXT_MAX };

/**
 * The operator writes in a seat's threads: a reply in a thread they are in,
 * or a new thread to the seat. Enter sends, Shift+Enter is a new line, @
 * opens the seats wired to this one and the pages in its reach, and # the
 * tasks and artifacts in its reach. The mail goes to this seat alone: a
 * mention is a reference, its seat gets no copy and does not join the thread. Past
 * main's bound the text goes as a file, attached. A refused send says
 * main's message as is and keeps the draft.
 */
export function ThreadComposer({
  seat,
  name,
  mode,
  threadId,
  inReplyTo,
  onSent,
  onCancel,
}: {
  readonly seat: SeatAddress;
  /** The seat's name: the one recipient, for the hint and the To line. */
  readonly name: string;
  readonly mode: "reply" | "new";
  /** Reply: the thread written in. */
  readonly threadId?: string;
  /** Reply: the mail answered, when known; it names the thread too. */
  readonly inReplyTo?: string;
  /** Sent: the thread it went in (a new thread's own id). */
  readonly onSent?: (threadId: string) => void;
  /** New thread only: leave without sending. */
  readonly onCancel?: () => void;
}) {
  const connected = useConnectedSeats(seat);
  const inReach = useResourcesInReach(seat.canvasName, seat.seatId as NodeId, useMentionItems(seat.canvasName));
  const candidates = useMemo(() => [...connected, ...inReach], [connected, inReach]);
  const attachments = useAttachments(seat.canvasName);
  const [draft, setDraft] = useState("");
  const [sending, setSending] = useState(false);
  const [failure, setFailure] = useState<string>();
  // The field takes the keyboard once, when it mounts.
  const setField = useCallback((element: HTMLTextAreaElement | null) => {
    claimFocusOnMount(element);
  }, []);


  // Files ride along: a mail may be only files, and waits for every one to be in.
  const hasFiles = attachments.items.length > 0;
  const uploading = attachments.items.some((item) => item.state === "uploading");
  const long = useLongText(draft.trim(), attachments.items.length, THREAD_BOUND);
  const unsendable = long.blocked || (draft.trim() === "" && !hasFiles) || attachments.ready === undefined;

  const send = async (): Promise<void> => {
    const text = draft.trim();
    const files = attachments.ready;
    if (unsendable || files === undefined || sending) return;
    setSending(true);
    setFailure(undefined);
    let carried: Awaited<ReturnType<typeof carryText>>;
    try {
      carried = await carryText(seat.canvasName, text, files, THREAD_BOUND);
    } catch (error) {
      setSending(false);
      setFailure(error instanceof Error ? error.message : String(error));
      return;
    }
    const result = await sendSeatThread({
      ...seat,
      text: carried.text,
      ...(mode === "reply" && inReplyTo !== undefined ? { inReplyTo } : {}),
      ...(mode === "reply" && inReplyTo === undefined && threadId !== undefined ? { threadId } : {}),
      ...(carried.files.length > 0 ? { attachments: carried.files } : {}),
    });
    setSending(false);
    if (!result.ok) {
      setFailure(result.message);
      return;
    }
    setDraft("");
    attachments.clear();
    onSent?.(result.threadId);
  };

  // The list takes its own keys first; what reaches here is the composer's.
  const onKeyDown = (event: KeyboardEvent<HTMLTextAreaElement>): void => {
    if (event.nativeEvent.isComposing) return;
    if (event.key === "Enter" && !event.shiftKey) {
      event.preventDefault();
      void send();
    }
  };

  const wired = `@ names a seat connected to ${name}, who gets no copy`;
  return (
    <div className="thread-composer" data-testid="thread-composer" data-mode={mode} {...attachments.dropTarget}>
      {mode === "new" ? (
        <div className="thread-composer__to" data-testid="thread-composer-to">
          <span>To</span>
          <Chip tone="steel">{name}</Chip>
        </div>
      ) : null}
      <div className="thread-composer__field">
        <MentionCombobox
          fieldRef={setField}
          dense
          placement="above"
          value={draft}
          onValueChange={(next) => {
            setDraft(next);
            setFailure(undefined);
          }}
          canvasName={seat.canvasName}
          candidates={candidates}
          listLabel={(trigger) => (trigger === "@" ? `Seats connected to ${name}, and pages in reach` : `Tasks and artifacts in reach of ${name}`)}
          aria-label={mode === "new" ? `New thread to ${name}` : "Reply"}
          data-testid="thread-composer-input"
          onKeyDown={onKeyDown}
        />
      </div>
      <AttachmentTray attachments={attachments} />
      <div className="thread-composer__foot">
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
          <span className="thread-composer__hint">
            {mode === "reply" ? `Enter sends, Shift+Enter is a new line, ${wired}` : wired}
          </span>
        )}
        <AttachButton attachments={attachments} disabled={sending} />
        {mode === "new" && onCancel ? (
          <Button size="sm" variant="chrome" disabled={sending} onClick={onCancel}>
            Cancel
          </Button>
        ) : null}
        <Button
          size="sm"
          variant="chrome"
          disabled={sending || unsendable}
          data-testid="thread-composer-send"
          onClick={() => void send()}
        >
          {mode === "new" ? "Start thread" : "Send"}
        </Button>
      </div>
    </div>
  );
}
