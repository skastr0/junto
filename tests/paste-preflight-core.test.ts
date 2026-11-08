/**
 * The drive's paste preflight, through the real boundary.
 *
 * A seat whose harness refuses an image paste (Grok) is asked before the drive
 * types, and the pasteboard's formats are Electron's, so the core asks main
 * through the clipboard host group. Nothing bound the check after the core
 * split (0.11.7): the drive pasted every image, and Grok's own refuse path
 * never ran.
 *
 * What is real here: the drive's assert, the guard, the core's clipboard
 * client, main's host server and handler over a MessageChannel, and the
 * format test. What is fake: the pasteboard itself, which is Electron's.
 */
import { Context, Effect, Exit, Layer, Scope } from "effect";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { harnessRecordFor } from "../src/shared/harness-records";
import { ClipboardHost } from "../src/contract/host/clipboard";
import { HostClientsNoWindow } from "../src/core/host-clients";
import { ClipboardUnreadable, clipboardSafeAssert } from "../src/core/term/drive/clipboard-guard";
import { servedHost } from "./support/host-link";

/** The harness each binding runs, as the core reads it from the seat's slot. */
const HARNESS: Readonly<Record<string, string>> = { "grok-seat": "grok", "claude-seat": "claude" };

const assertWith = (clipboard: Context.Service.Shape<typeof ClipboardHost>) =>
  clipboardSafeAssert({
    guarded: (bindingId) =>
      harnessRecordFor(HARNESS[bindingId])?.pty.clipboardImageGuard === true,
    ask: () =>
      clipboard.ClipboardSafeForGrok().pipe(Effect.mapError((cause) => new ClipboardUnreadable({ message: cause.message }))),
    run: (effect) => Effect.runPromise(effect),
  });

let scope: Scope.Closeable;
let close: () => void = () => undefined;

beforeEach(async () => {
  scope = await Effect.runPromise(Scope.make());
});

afterEach(async () => {
  close();
  await Effect.runPromise(Scope.close(scope, Exit.void));
});

/** A core asking a main whose pasteboard reports these formats. */
const coreOver = async (availableFormats: () => ReadonlyArray<string>) => {
  const host = await servedHost(scope, { readText: () => "", writeText: () => undefined, clear: () => undefined, availableFormats });
  close = host.close;
  return (await host.core()).clipboard;
};

describe("the paste preflight a guarded seat makes", () => {
  it("is the guard the harness records name, and only Grok has it", () => {
    expect(harnessRecordFor("grok")?.pty.clipboardImageGuard).toBe(true);
    expect(harnessRecordFor("claude")?.pty.clipboardImageGuard).toBe(false);
  });

  it("refuses an image on the pasteboard and allows text", async () => {
    const formats = { now: ["text/plain"] as ReadonlyArray<string> };
    const assert = assertWith(await coreOver(() => formats.now));
    expect(await assert("grok-seat")).toBe(true);
    formats.now = ["image/png", "text/plain"];
    expect(await assert("grok-seat")).toBe(false);
    formats.now = ["public.tiff"];
    expect(await assert("grok-seat")).toBe(false);
  });

  it("never reads the pasteboard for a harness with no guard", async () => {
    let reads = 0;
    const clipboard = await coreOver(() => {
      reads += 1;
      return ["image/png"];
    });
    expect(await assertWith(clipboard)("claude-seat")).toBe(true);
    expect(reads).toBe(0);
  });

  it("refuses the paste when main does not answer", async () => {
    // A windowless core: no main answers, and the seat does not paste blind.
    const clipboard = Context.get(await Effect.runPromise(Layer.buildWithScope(HostClientsNoWindow, scope)), ClipboardHost);
    expect(await assertWith(clipboard)("grok-seat")).toBe(false);
  });
});
