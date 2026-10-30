/**
 * The drive's paste preflight, as the core can hold it.
 *
 * A seat whose harness refuses an image paste (Grok) is asked before the drive
 * types: `assertClipboardSafe` answers false and the drive aborts to attention
 * without touching the operator's clipboard. The formats are the pasteboard's
 * own (`clipboard-safe.ts`), which only Electron main can read, so the core
 * asks through a host operation and this module decides what an answer means.
 *
 * An answer main does not give is a refusal. The seat does not paste blind
 * because the clipboard could not be read.
 */
import { Effect, Result, Schema } from "effect";
import type { ClipboardSafeAssert } from "./managed-terminal-drive";

/** The pasteboard could not be read: no answer from main, or a failing one. */
export class ClipboardUnreadable extends Schema.TaggedError<ClipboardUnreadable>()(
  "ClipboardUnreadable",
  { message: Schema.String },
) {}

export type ClipboardGuard = {
  /** Whether this seat's harness has the image-paste guard at all. */
  readonly guarded: (bindingId: string) => boolean;
  /** Whether the pasteboard holds only formats the guard accepts. */
  readonly ask: () => Effect.Effect<boolean, ClipboardUnreadable>;
};

/**
 * The drive's preflight. A seat with no guard is pasted without reading the
 * clipboard; a guarded one asks, and reads anything but a yes as no.
 */
export const clipboardSafeAssert = (guard: ClipboardGuard): ClipboardSafeAssert =>
  async (bindingId: string): Promise<boolean> => {
    if (!guard.guarded(bindingId)) return true;
    // `Effect.result` moves the failure into the value, so this cannot throw.
    const answered = await Effect.runPromise(Effect.result(guard.ask()));
    return Result.isSuccess(answered) ? answered.success : false;
  };
