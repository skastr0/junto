import { useEffect, useRef, useState } from "react";
import { MessageSquare } from "lucide-react";
import type { CanvasNode } from "@shared/canvas";
import { claimFocusOnMount } from "../../lib/focus-ownership";
import type { Side } from "../../lib/menu-placement";
import {
  planSeatMessage,
  planSeatMessageFor,
  seatMessageReach,
  seatMessageTitle,
  sendSeatMessage,
  type SeatMessageOutcome,
} from "../../lib/seat-message";
import { state$ } from "../../lib/state";
import { use$ } from "@legendapp/state/react";
import { Button, IconButton, Popover } from "../ui";
import "./seat-message.css";

/**
 * Type one message to one or more agent seats. Enter sends, Shift+Enter is a
 * new line, Esc closes (the host owns Esc). The field keeps focus after a
 * send, so the next message can follow; the line under it says whether each
 * seat got it now or will when it is up.
 */
export function SeatMessageForm({ nodeIds }: { readonly nodeIds: ReadonlyArray<string> }) {
  const plan = use$(() => {
    state$.doc.get();
    return planSeatMessageFor(nodeIds);
  });
  const [draft, setDraft] = useState("");
  const [sending, setSending] = useState(false);
  const [outcome, setOutcome] = useState<SeatMessageOutcome | null>(null);
  const draftRef = useRef(draft);
  draftRef.current = draft;
  const fieldRef = useRef<HTMLTextAreaElement>(null);

  // The field takes focus when the composer opens, which the operator just
  // asked for with a press. One frame late: a popover stays hidden while it
  // places itself, and a hidden field cannot take focus.
  useEffect(() => {
    const frame = requestAnimationFrame(() => claimFocusOnMount(fieldRef.current));
    return () => cancelAnimationFrame(frame);
  }, []);

  const reach = seatMessageReach(plan);
  const canSend = !sending && plan.targets.length > 0 && draft.trim().length > 0;

  const send = async (): Promise<void> => {
    if (!canSend) return;
    const text = draft;
    setSending(true);
    setOutcome(null);
    try {
      // Plan again at send time: a seat may have gone or come since opening.
      const result = await sendSeatMessage(planSeatMessageFor(nodeIds), text);
      setOutcome(result);
      // Clear only what was sent: text typed while it went out stays.
      if (!result.keepDraft && draftRef.current === text) setDraft("");
    } finally {
      setSending(false);
    }
  };

  return (
    <div className="seat-message" data-testid="seat-message">
      <div className="seat-message__head">
        <span className="seat-message__title">{seatMessageTitle(plan)}</span>
        {reach ? <span className="seat-message__reach">{reach}</span> : null}
      </div>
      <textarea
        ref={fieldRef}
        className="seat-message__field"
        value={draft}
        rows={2}
        placeholder={plan.targets.length > 1 ? "Write to all of them" : "Write a message"}
        aria-label={seatMessageTitle(plan)}
        aria-keyshortcuts="Enter"
        data-testid="seat-message-field"
        onChange={(event) => setDraft(event.target.value)}
        onKeyDown={(event) => {
          if (event.key !== "Enter" || event.shiftKey || event.nativeEvent.isComposing) return;
          event.preventDefault();
          void send();
        }}
      />
      <div className="seat-message__foot">
        <p
          className="seat-message__status"
          role="status"
          aria-live="polite"
          data-testid="seat-message-status"
          data-tone={sending ? "sending" : outcome?.tone}
        >
          {sending ? "Sending…" : outcome?.line ?? "Enter sends, Shift+Enter adds a line"}
        </p>
        <Button size="xs" variant="primary" disabled={!canSend} onClick={() => void send()}>
          Send
        </Button>
      </div>
    </div>
  );
}

// Above the toolbar first, centred on the button: below it is the seat the
// message is about.
const COMPOSER_SIDES: ReadonlyArray<Side> = ["above", "below", "right", "left"];

/** Seat toolbar button: opens the composer for this one seat. */
export function SeatMessageToolbarAction({ node }: { readonly node: CanvasNode }) {
  const [anchor, setAnchor] = useState<HTMLElement | null>(null);
  if (planSeatMessage([node]).targets.length === 0) return null;
  return (
    <>
      <IconButton
        className="nodrag nopan"
        aria-label="Message agent"
        title="Message this agent"
        aria-haspopup="dialog"
        aria-expanded={anchor !== null}
        data-testid="seat-message-open"
        onPointerDown={(event) => {
          event.preventDefault();
          event.stopPropagation();
          const button = event.currentTarget;
          setAnchor((open) => (open ? null : button));
        }}
      >
        <MessageSquare size={14} />
      </IconButton>
      {anchor ? (
        <Popover
          anchor={anchor}
          onClose={() => setAnchor(null)}
          label={`Message ${planSeatMessage([node]).names.get(node.id) ?? "agent"}`}
          sides={COMPOSER_SIDES}
          align="center"
          width={320}
          className="seat-message-popover"
        >
          <SeatMessageForm nodeIds={[node.id]} />
        </Popover>
      ) : null}
    </>
  );
}
