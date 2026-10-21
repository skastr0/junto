import { Context, type Effect } from "effect";
import type { AgentSignal } from "@shared/agent-signals";
import type { ContentPullRefused } from "@shared/content-pull";
import { ATTACHMENT_HEAD_BYTES, attachmentMediaType, isTextHead } from "@shared/preview-bytes";
import type { ContentRef } from "@shared/wire/content-ref";
import type { ContentPullFailed } from "../content/pull";
import { readContentObjectRange } from "../content/store";

/**
 * Bring a file a seat's signal attached here, from the machine the seat
 * lives on, when the operator opens it on the machine that edits the canvas.
 * The machine core provides it (`MachineCoreRows.pullSignalFile`); the
 * preview reads it without importing the runtime. A rig without it pulls
 * nothing, and the file stays missing.
 */
export class SignalFilePuller extends Context.Service<SignalFilePuller, {
  readonly pull: (input: {
    readonly signal: AgentSignal;
    readonly ref: ContentRef;
  }) => Effect.Effect<void, ContentPullRefused | ContentPullFailed>;
}>()("@junto/SignalFilePuller") {}

/**
 * How a signal's file that arrived here is shown, judged from its own bytes
 * and its name, never from the type its reference states: the same judgment
 * main makes of a seat's upload (`attachmentMediaType`). A side of a compare
 * must be text, or the file is not kept.
 */
export const judgeArrivedSignalFile = (
  root: string,
  ref: ContentRef,
  signal: Pick<AgentSignal, "attachments">,
): { readonly mediaType: string } | { readonly refused: string } => {
  const head = ref.byteLength === 0 ? new Uint8Array(0) : readContentObjectRange(root, ref, 0, Math.min(ref.byteLength, ATTACHMENT_HEAD_BYTES));
  if (head === undefined) return { refused: "the file is not in this machine's store" };
  const compared = (signal.attachments ?? []).some(
    (attachment) =>
      "kind" in attachment &&
      attachment.kind === "compare" &&
      [attachment.before, attachment.after].some((side) => side.sha256 === ref.sha256 && side.byteLength === ref.byteLength),
  );
  if (compared && !isTextHead(head)) return { refused: "a side of a compare is not text" };
  return { mediaType: attachmentMediaType(ref.displayName ?? "file", head) };
};
