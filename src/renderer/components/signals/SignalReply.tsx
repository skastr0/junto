import { useState } from "react";
import type { AgentSignalAnswerOptions } from "@shared/ipc";
import type { SignalActionResult } from "../../lib/agent-signals-view";
import { claimFocus } from "../../lib/focus-ownership";
import { modKeyGlyph } from "../../lib/platform";
import { answerLabel, useQuickReplies, useQuietNotes } from "../../lib/quick-replies";
import { Button } from "../ui";
import { Textarea } from "../ui/Field";
import { QuickReplies } from "./QuickReplies";
import { keyAria, keyIs } from "../../lib/key-match";

// Stable callback ref: the reply field takes focus when the form mounts,
// without scrolling it in. The list it sits in moves only for the operator.
const claimReplyFocus = (wrapper: HTMLDivElement | null): void => {
  claimFocus(wrapper?.querySelector("textarea"), "open", { preventScroll: true });
};

/**
 * One answer or dismiss in flight at a time, with its failure kept for the
 * operator. `pending` names what is being sent ("" for a typed reply or a
 * dismiss), so a quick reply pill can show that it is the one waiting.
 */
export const useSignalAction = (onDone: () => void) => {
  const [pending, setPending] = useState<string | null>(null);
  const [error, setError] = useState("");
  const act = async (label: string, run: () => Promise<SignalActionResult>): Promise<void> => {
    setPending(label);
    setError("");
    try {
      const result = await run();
      if (result.ok) onDone();
      else setError(result.message);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    } finally {
      setPending(null);
    }
  };
  return { pending, error, act };
};

/**
 * Answer or dismiss one open agent signal. Send reply (Cmd+Enter, or a quick
 * reply pill) delivers the answer to the seat as operator mail and wakes it;
 * Send quietly (Shift+Cmd+Enter, or a quiet note pill) records it on the
 * signal with no mail, and with no text it acknowledges; Dismiss closes it
 * and the seat is not told. Shared by the seat sidebar popover and the feed.
 */
export function SignalReply({
  signalId,
  suggested,
  respond,
  dismiss,
  onDone,
  className = "seat-signal-popover__reply",
}: {
  readonly signalId: string;
  /** Replies the seat pre-baked for this signal; they lead the pill row. */
  readonly suggested?: ReadonlyArray<string>;
  readonly respond: (
    signalId: string,
    text: string,
    options?: AgentSignalAnswerOptions,
  ) => Promise<SignalActionResult>;
  readonly dismiss: (signalId: string) => Promise<SignalActionResult>;
  /** Called after a successful send or dismiss. */
  readonly onDone: () => void;
  readonly className?: string;
}) {
  const [reply, setReply] = useState("");
  const quickReplies = useQuickReplies();
  const quietNotes = useQuietNotes();
  const { pending, error, act } = useSignalAction(onDone);
  const canSend = pending === null && reply.trim().length > 0;
  const send = (): void => {
    if (canSend) void act("", () => respond(signalId, reply.trim()));
  };
  // Empty is allowed: a quiet answer with no note acknowledges.
  const sendQuietly = (): void => {
    if (pending === null) void act("", () => respond(signalId, reply.trim(), { silent: true }));
  };
  const mod = modKeyGlyph();

  return (
    <div ref={claimReplyFocus} className={className}>
      <QuickReplies
        replies={quickReplies}
        suggested={suggested}
        pending={pending}
        onPick={(text) => void act(text, () => respond(signalId, text))}
      />
      <QuickReplies
        replies={quietNotes}
        quiet
        pending={pending}
        onPick={(text) => void act(answerLabel({ kind: "quiet", text }), () => respond(signalId, text, { silent: true }))}
      />
      <Textarea
        value={reply}
        onChange={(event) => setReply(event.target.value)}
        onKeyDown={(event) => {
          if (keyIs(event, "message.sendQuietly")) {
            event.preventDefault();
            sendQuietly();
          } else if (keyIs(event, "message.send")) {
            event.preventDefault();
            send();
          }
        }}
        placeholder="Or write a reply…"
        rows={3}
        aria-label="Your reply"
        aria-keyshortcuts={[keyAria("message.send"), keyAria("message.sendQuietly")].filter(Boolean).join(" ")}
      />
      {error ? <p className="seat-signal-popover__error" role="alert">{error}</p> : null}
      <div className="seat-signal-popover__actions">
        <Button
          size="xs"
          variant="subtle"
          disabled={pending !== null}
          title="Dismiss: closes it, the seat is not told"
          onClick={() => void act("", () => dismiss(signalId))}
        >
          Dismiss
        </Button>
        <Button
          size="xs"
          variant="subtle"
          disabled={pending !== null}
          title={`Send quietly: answered, the seat is not woken (⇧${mod}↵)`}
          onClick={sendQuietly}
        >
          Send quietly
        </Button>
        <Button
          size="xs"
          variant="primary"
          disabled={!canSend}
          title={`Send reply: mails and wakes the seat (${mod}↵)`}
          onClick={send}
        >
          Send reply
        </Button>
      </div>
    </div>
  );
}
