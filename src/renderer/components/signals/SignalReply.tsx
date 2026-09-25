import { useState } from "react";
import type { SignalActionResult } from "../../lib/agent-signals-view";
import { claimFocusOnMount } from "../../lib/focus-ownership";
import { modKeyGlyph } from "../../lib/platform";
import { Button } from "../ui";
import { Textarea } from "../ui/Field";

// Stable callback ref: the reply field takes focus when the form mounts.
const claimReplyFocus = (wrapper: HTMLDivElement | null): void => {
  claimFocusOnMount(wrapper?.querySelector("textarea") ?? null);
};

/**
 * Answer or dismiss one open agent signal. The answer is delivered to the
 * seat as operator mail. Shared by the seat sidebar popover and the feed.
 */
export function SignalReply({
  signalId,
  respond,
  dismiss,
  onDone,
  className = "seat-signal-popover__reply",
}: {
  readonly signalId: string;
  readonly respond: (signalId: string, text: string) => Promise<SignalActionResult>;
  readonly dismiss: (signalId: string) => Promise<SignalActionResult>;
  /** Called after a successful send or dismiss. */
  readonly onDone: () => void;
  readonly className?: string;
}) {
  const [reply, setReply] = useState("");
  const [pending, setPending] = useState(false);
  const [error, setError] = useState("");
  const canSend = !pending && reply.trim().length > 0;

  const act = async (run: () => Promise<SignalActionResult>): Promise<void> => {
    setPending(true);
    setError("");
    try {
      const result = await run();
      if (result.ok) onDone();
      else setError(result.message);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    } finally {
      setPending(false);
    }
  };
  const send = (): void => {
    if (canSend) void act(() => respond(signalId, reply.trim()));
  };

  return (
    <div ref={claimReplyFocus} className={className}>
      <Textarea
        value={reply}
        onChange={(event) => setReply(event.target.value)}
        onKeyDown={(event) => {
          if (event.key !== "Enter" || !(event.metaKey || event.ctrlKey)) return;
          event.preventDefault();
          send();
        }}
        placeholder="Reply to the agent…"
        rows={3}
        aria-label="Your reply"
        aria-keyshortcuts="Meta+Enter Control+Enter"
      />
      {error ? <p className="seat-signal-popover__error" role="alert">{error}</p> : null}
      <div className="seat-signal-popover__actions">
        <Button size="xs" variant="subtle" disabled={pending} onClick={() => void act(() => dismiss(signalId))}>
          Dismiss
        </Button>
        <Button size="xs" variant="primary" disabled={!canSend} title={`${modKeyGlyph()}+↵`} onClick={send}>
          Send reply
        </Button>
      </div>
    </div>
  );
}
