import { useState } from "react";
import type { AgentSignalAnswerOptions } from "@shared/ipc";
import type { SignalActionResult } from "../../lib/agent-signals-view";
import { claimFocus } from "../../lib/focus-ownership";
import { modKeyGlyph } from "../../lib/platform";
import { useAttachments } from "../../lib/operator-attachments";
import { answerLabel, useQuickReplies, useQuietNotes } from "../../lib/quick-replies";
import { AttachButton, AttachmentTray } from "../attachments/AttachmentTray";
import { Button } from "../ui";
import { Textarea } from "../ui/Field";
import { QuickReplies } from "./QuickReplies";
import { keyAria, keyIs } from "../../lib/key-match";

// Stable callback ref: the reply field takes focus when the form mounts,
// without scrolling it in. The list it sits in moves only for the operator.
const claimReplyFocus = (wrapper: HTMLDivElement | null): void => {
  claimFocus(wrapper?.querySelector("textarea"), "open", { preventScroll: true });
};

/** What the pills wait on while a file uploads: no pill's own text. */
const UPLOADING = "\u0000uploading";

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
 * and the seat is not told. Files pasted, dropped or attached ride on
 * whichever answer goes, and with files the text may be empty; nothing is
 * sent while one is still uploading. Shared by the seat sidebar popover and
 * the feed.
 */
export function SignalReply({
  signalId,
  canvasName,
  suggested,
  respond,
  dismiss,
  onDone,
  className = "seat-signal-popover__reply",
}: {
  readonly signalId: string;
  /** The signal's canvas: attached files are uploaded for a mail on it. */
  readonly canvasName: string;
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
  const attachments = useAttachments(canvasName);
  const { pending, error, act } = useSignalAction(() => {
    attachments.clear();
    onDone();
  });
  // Every attached file is in (or there are none): an answer may go.
  const filesIn = attachments.ready !== undefined;
  const files = attachments.ready ?? [];
  const withFiles = (silent: boolean) =>
    silent || files.length > 0 ? { ...(silent ? { silent } : {}), ...(files.length > 0 ? { attachments: files } : {}) } : undefined;
  const answer = (label: string, text: string, silent: boolean): void => {
    if (pending !== null || !filesIn) return;
    void act(label, () => respond(signalId, text, withFiles(silent)));
  };
  const canSend = pending === null && filesIn && (reply.trim().length > 0 || files.length > 0);
  const send = (): void => {
    if (canSend) answer("", reply.trim(), false);
  };
  // Empty is allowed: a quiet answer with no note and no file acknowledges.
  const sendQuietly = (): void => answer("", reply.trim(), true);
  const mod = modKeyGlyph();
  const waiting = filesIn ? undefined : "Waiting for the files to attach";

  return (
    <div ref={claimReplyFocus} className={className} data-testid="signal-reply" {...attachments.dropTarget}>
      <QuickReplies
        replies={quickReplies}
        suggested={suggested}
        pending={filesIn ? pending : UPLOADING}
        onPick={(text) => answer(text, text, false)}
      />
      <QuickReplies
        replies={quietNotes}
        quiet
        pending={filesIn ? pending : UPLOADING}
        onPick={(text) => answer(answerLabel({ kind: "quiet", text }), text, true)}
      />
      <AttachmentTray attachments={attachments} />
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
        placeholder="Or write a reply, or paste or drop files…"
        rows={3}
        aria-label="Your reply"
        aria-keyshortcuts={[keyAria("message.send"), keyAria("message.sendQuietly")].filter(Boolean).join(" ")}
      />
      {error ? <p className="seat-signal-popover__error" role="alert">{error}</p> : null}
      <div className="seat-signal-popover__actions">
        <span className="mr-auto flex">
          <AttachButton attachments={attachments} disabled={pending !== null} />
        </span>
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
          disabled={pending !== null || !filesIn}
          title={waiting ?? `Send quietly: answered, the seat is not woken (⇧${mod}↵)`}
          onClick={sendQuietly}
        >
          Send quietly
        </Button>
        <Button
          size="xs"
          variant="primary"
          disabled={!canSend}
          title={waiting ?? `Send reply: mails and wakes the seat (${mod}↵)`}
          onClick={send}
        >
          Send reply
        </Button>
      </div>
    </div>
  );
}
