import { useCallback, useEffect, useId, useRef, useState, type ChangeEvent, type KeyboardEvent } from "react";
import { claimFocusOnMount } from "../../lib/focus-ownership";
import {
  mentionQueryAt,
  mentionsIn,
  pickMention,
  sendSeatThread,
  useSeatThreadMentionables,
  type MentionableSeat,
  type SeatAddress,
} from "../../lib/seat-threads";
import { Button } from "../ui/Button";
import { Chip } from "../ui/Chip";
import { Textarea } from "../ui/Field";

/**
 * The operator writes in a seat's threads: a reply in a thread they are in,
 * or a new thread to the seat. Enter sends, Shift+Enter is a new line, and @
 * opens the seats wired to this one; a chosen seat gets the same mail in the
 * same thread. A refused send says main's message as is and keeps the draft.
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
  /** The seat's name, for the hint and the To line. */
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
  const mentionables = useSeatThreadMentionables(seat);
  const [draft, setDraft] = useState("");
  const [picked, setPicked] = useState<ReadonlyArray<MentionableSeat>>([]);
  const [caret, setCaret] = useState(0);
  const [active, setActive] = useState(0);
  const [dismissedAt, setDismissedAt] = useState<number>();
  const [sending, setSending] = useState(false);
  const [failure, setFailure] = useState<string>();
  const fieldRef = useRef<HTMLTextAreaElement | null>(null);
  const pendingCaret = useRef<number | undefined>(undefined);
  const listId = useId();
  // The field takes the keyboard once, when it mounts.
  const setField = useCallback((element: HTMLTextAreaElement | null) => {
    fieldRef.current = element;
    claimFocusOnMount(element);
  }, []);

  const query = mentionQueryAt(draft, caret);
  const options =
    query === undefined || query.start === dismissedAt
      ? []
      : mentionables.filter((candidate) => candidate.name.toLowerCase().startsWith(query.text.toLowerCase()));
  const picking = options.length > 0;
  const chosen = Math.min(active, Math.max(0, options.length - 1));
  const mentions = mentionsIn(draft, picked);

  // Put the caret after a chosen name once the draft holding it is drawn.
  useEffect(() => {
    const field = fieldRef.current;
    const at = pendingCaret.current;
    if (!field || at === undefined) return;
    pendingCaret.current = undefined;
    field.setSelectionRange(at, at);
    setCaret(at);
  }, [draft]);

  const follow = (event: ChangeEvent<HTMLTextAreaElement> | { currentTarget: HTMLTextAreaElement }): void => {
    setCaret(event.currentTarget.selectionStart ?? event.currentTarget.value.length);
  };

  const choose = (candidate: MentionableSeat): void => {
    if (query === undefined) return;
    const next = pickMention(draft, query, candidate.name);
    pendingCaret.current = next.caret;
    setDraft(next.text);
    setPicked((known) => (known.some((seat) => seat.nodeId === candidate.nodeId) ? known : [...known, candidate]));
    setActive(0);
  };

  const send = async (): Promise<void> => {
    const text = draft.trim();
    if (text === "" || sending) return;
    setSending(true);
    setFailure(undefined);
    const result = await sendSeatThread({
      ...seat,
      text,
      ...(mode === "reply" && inReplyTo !== undefined ? { inReplyTo } : {}),
      ...(mode === "reply" && inReplyTo === undefined && threadId !== undefined ? { threadId } : {}),
      ...(mentions.length > 0 ? { mentions: mentions.map((seat) => seat.nodeId) } : {}),
    });
    setSending(false);
    if (!result.ok) {
      setFailure(result.message);
      return;
    }
    setDraft("");
    setPicked([]);
    setCaret(0);
    onSent?.(result.threadId);
  };

  const onKeyDown = (event: KeyboardEvent<HTMLTextAreaElement>): void => {
    if (event.nativeEvent.isComposing) return;
    if (picking) {
      if (event.key === "ArrowDown" || event.key === "ArrowUp") {
        event.preventDefault();
        const step = event.key === "ArrowDown" ? 1 : -1;
        setActive((chosen + step + options.length) % options.length);
        return;
      }
      if (event.key === "Enter" || event.key === "Tab") {
        event.preventDefault();
        const candidate = options[chosen];
        if (candidate) choose(candidate);
        return;
      }
      if (event.key === "Escape") {
        // The list closes; the dialog stays.
        event.preventDefault();
        event.stopPropagation();
        setDismissedAt(query?.start);
        return;
      }
    }
    if (event.key === "Enter" && !event.shiftKey) {
      event.preventDefault();
      void send();
    }
  };

  const wired = `@ adds a seat connected to ${name}`;
  return (
    <div className="thread-composer" data-testid="thread-composer" data-mode={mode}>
      {mode === "new" ? (
        <div className="thread-composer__to" data-testid="thread-composer-to">
          <span>To</span>
          <Chip tone="steel">{name}</Chip>
          {mentions.map((seat) => (
            <Chip key={seat.nodeId} tone="steel">
              {seat.name}
            </Chip>
          ))}
          {mentions.length > 0 ? <span>added by its @</span> : null}
        </div>
      ) : null}
      <div className="thread-composer__field">
        {picking ? (
          <div className="thread-composer__picker" data-testid="thread-composer-picker">
            <div className="thread-composer__picker-head">Connected to {name}</div>
            <ul id={listId} role="listbox" aria-label={`Seats connected to ${name}`}>
              {options.map((candidate, index) => (
                <li
                  key={candidate.nodeId}
                  id={`${listId}-${index}`}
                  role="option"
                  aria-selected={index === chosen}
                  className="thread-composer__option"
                  data-testid="thread-composer-option"
                  // A press must not take the keyboard from the field.
                  onMouseDown={(event) => event.preventDefault()}
                  onClick={() => choose(candidate)}
                >
                  {candidate.name}
                </li>
              ))}
            </ul>
          </div>
        ) : null}
        <Textarea
          ref={setField}
          dense
          className="thread-composer__input"
          aria-label={mode === "new" ? `New thread to ${name}` : "Reply"}
          aria-controls={picking ? listId : undefined}
          aria-activedescendant={picking ? `${listId}-${chosen}` : undefined}
          aria-autocomplete="list"
          data-testid="thread-composer-input"
          value={draft}
          onChange={(event) => {
            setDraft(event.currentTarget.value);
            setFailure(undefined);
            follow(event);
          }}
          onSelect={(event) => follow(event)}
          onKeyDown={onKeyDown}
        />
      </div>
      <div className="thread-composer__foot">
        {failure ? (
          <span className="thread-composer__failure" role="alert" data-testid="thread-composer-failure">
            {failure}
          </span>
        ) : (
          <span className="thread-composer__hint">
            {mode === "reply" ? `Enter sends, Shift+Enter is a new line, ${wired}` : wired}
          </span>
        )}
        {mode === "new" && onCancel ? (
          <Button size="sm" variant="chrome" disabled={sending} onClick={onCancel}>
            Cancel
          </Button>
        ) : null}
        <Button
          size="sm"
          variant="chrome"
          disabled={sending || draft.trim() === ""}
          data-testid="thread-composer-send"
          onClick={() => void send()}
        >
          {mode === "new" ? "Start thread" : "Send"}
        </Button>
      </div>
    </div>
  );
}
