import { useCallback, useState, type KeyboardEvent } from "react";
import type { MentionRef } from "@shared/mention";
import { claimFocusOnMount } from "../../lib/focus-ownership";
import { useConnectedSeats } from "../../lib/mention-sources";
import { useAttachments } from "../../lib/operator-attachments";
import { sendSeatThread, THREAD_MENTIONS_MAX, THREAD_TEXT_MAX, type SeatAddress } from "../../lib/seat-threads";
import { AttachButton, AttachmentTray } from "../attachments/AttachmentTray";
import { Button } from "../ui/Button";
import { Chip } from "../ui/Chip";
import { MentionCombobox } from "../ui/MentionCombobox";

/**
 * The operator writes in a seat's threads: a reply in a thread they are in,
 * or a new thread to the seat. Enter sends, Shift+Enter is a new line, and @
 * opens the seats wired to this one. The mail goes to this seat alone: an @
 * is a reference, its seat gets no copy and does not join the thread. A
 * refused send says main's message as is and keeps the draft.
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
  const attachments = useAttachments(seat.canvasName);
  const [draft, setDraft] = useState("");
  const [mentioned, setMentioned] = useState<ReadonlyArray<MentionRef>>([]);
  const [sending, setSending] = useState(false);
  const [failure, setFailure] = useState<string>();
  // The field takes the keyboard once, when it mounts.
  const setField = useCallback((element: HTMLTextAreaElement | null) => {
    claimFocusOnMount(element);
  }, []);

  const mentions = mentioned.flatMap((ref) => (ref.kind === "seat" ? [ref.nodeId] : []));
  const mentionsFull = mentions.length >= THREAD_MENTIONS_MAX;
  const tooLong = draft.trim().length > THREAD_TEXT_MAX;

  // Files ride along: a mail may be only files, and waits for every one to be in.
  const hasFiles = attachments.items.length > 0;
  const uploading = attachments.items.some((item) => item.state === "uploading");
  const unsendable = tooLong || (draft.trim() === "" && !hasFiles) || attachments.ready === undefined;

  const send = async (): Promise<void> => {
    const text = draft.trim();
    const files = attachments.ready;
    if (unsendable || files === undefined || sending) return;
    setSending(true);
    setFailure(undefined);
    const result = await sendSeatThread({
      ...seat,
      text,
      ...(mode === "reply" && inReplyTo !== undefined ? { inReplyTo } : {}),
      ...(mode === "reply" && inReplyTo === undefined && threadId !== undefined ? { threadId } : {}),
      ...(mentions.length > 0 ? { mentions } : {}),
      ...(files.length > 0 ? { attachments: files } : {}),
    });
    setSending(false);
    if (!result.ok) {
      setFailure(result.message);
      return;
    }
    setDraft("");
    attachments.clear();
    setMentioned([]);
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
          onValueChange={(next, refs) => {
            setDraft(next);
            setMentioned(refs);
            setFailure(undefined);
          }}
          canvasName={seat.canvasName}
          candidates={connected}
          listLabel={() => `Seats connected to ${name}`}
          noun={{ one: "seat", other: "seats" }}
          maxMentions={THREAD_MENTIONS_MAX}
          aria-label={mode === "new" ? `New thread to ${name}` : "Reply"}
          data-testid="thread-composer-input"
          onKeyDown={onKeyDown}
        />
      </div>
      <AttachmentTray attachments={attachments} />
      <div className="thread-composer__foot">
        {failure || tooLong ? (
          <span className="thread-composer__failure" role="alert" data-testid="thread-composer-failure">
            {failure ?? `${draft.trim().length} characters; a mail holds at most ${THREAD_TEXT_MAX}.`}
          </span>
        ) : mentionsFull ? (
          <span className="thread-composer__hint" data-testid="thread-composer-mentions-full">
            {`A mail names at most ${THREAD_MENTIONS_MAX} seats.`}
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
