/**
 * The drive's paste preflight, through the real boundary.
 *
 * A seat whose harness refuses an image paste (Grok) is asked before the drive
 * types, and the pasteboard's formats are Electron's, so the core asks main by
 * host operation. Nothing bound the check after the core split (0.11.7): the
 * drive pasted every image, and Grok's own refuse path never ran.
 *
 * What is real here: the drive's assert, the guard, the host operation, main's
 * body and the format test. What is fake: the pasteboard itself, which is
 * Electron's.
 */
import { Effect } from "effect";
import { describe, expect, it } from "vitest";
import { harnessRecordFor } from "../src/shared/harness-records";
import { host } from "../src/main/core-process/host-ops";
import { serveClipboardFormats } from "../src/main/core-process/main-side/clipboard";
import { ClipboardUnreadable, clipboardSafeAssert } from "../src/main/junto/term/drive/clipboard-guard";

/** The harness each binding runs, as the core reads it from the seat's slot. */
const HARNESS: Readonly<Record<string, string>> = { "grok-seat": "grok", "claude-seat": "claude" };

const assertWith = () =>
  clipboardSafeAssert({
    guarded: (bindingId) =>
      harnessRecordFor(HARNESS[bindingId])?.pty.clipboardImageGuard === true,
    ask: () =>
      Effect.tryPromise({
        try: () => host.call("clipboard.safeForGrok", {}),
        catch: (cause) => new ClipboardUnreadable({ message: cause instanceof Error ? cause.message : String(cause) }),
      }),
  });

describe("the paste preflight a guarded seat makes", () => {
  it("is the guard the harness records name, and only Grok has it", () => {
    expect(harnessRecordFor("grok")?.pty.clipboardImageGuard).toBe(true);
    expect(harnessRecordFor("claude")?.pty.clipboardImageGuard).toBe(false);
  });

  it("refuses an image on the pasteboard and allows text", async () => {
    const formats = { now: ["text/plain"] as ReadonlyArray<string> };
    const stop = serveClipboardFormats({ availableFormats: () => formats.now });
    try {
      const assert = assertWith();
      expect(await assert("grok-seat")).toBe(true);
      formats.now = ["image/png", "text/plain"];
      expect(await assert("grok-seat")).toBe(false);
      formats.now = ["public.tiff"];
      expect(await assert("grok-seat")).toBe(false);
    } finally {
      stop();
    }
  });

  it("never reads the pasteboard for a harness with no guard", async () => {
    let reads = 0;
    const stop = serveClipboardFormats({
      availableFormats: () => {
        reads += 1;
        return ["image/png"];
      },
    });
    try {
      expect(await assertWith()("claude-seat")).toBe(true);
      expect(reads).toBe(0);
    } finally {
      stop();
    }
  });

  it("refuses the paste when main does not answer", async () => {
    // Nothing serves the operation: main is not there, and the seat does not paste blind.
    expect(await assertWith()("grok-seat")).toBe(false);
  });
});
