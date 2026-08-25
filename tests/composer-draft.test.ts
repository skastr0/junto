import { afterEach, describe, expect, it } from "vitest";
import {
  ComposerDraftLedger,
  classifyComposerWrite,
  composerDraft,
} from "../src/main/vellum/term/composer-draft";
import { ManagedTerminalDrive } from "../src/main/vellum/term/drive";

const ESC = "\u001b";

describe("classifyComposerWrite", () => {
  it("counts visible characters the operator typed", () => {
    expect(classifyComposerWrite("fix the bug")).toEqual({
      kind: "delta",
      chars: 11,
    });
  });

  it("treats submit and clearing keys as a clear", () => {
    expect(classifyComposerWrite("\r")).toEqual({ kind: "clear" });
    expect(classifyComposerWrite("\n")).toEqual({ kind: "clear" });
    expect(classifyComposerWrite("half typed\r")).toEqual({ kind: "clear" });
    expect(classifyComposerWrite("\u0003")).toEqual({ kind: "clear" });
    expect(classifyComposerWrite("\u0015")).toEqual({ kind: "clear" });
    expect(classifyComposerWrite("\u0017")).toEqual({ kind: "clear" });
  });

  it("subtracts backspaces", () => {
    expect(classifyComposerWrite("ab\u007f")).toEqual({ kind: "delta", chars: 1 });
    expect(classifyComposerWrite("\u007f\u0008")).toEqual({
      kind: "delta",
      chars: -2,
    });
  });

  it("skips escape sequences — arrows never look like typing", () => {
    expect(classifyComposerWrite(`${ESC}[A`)).toEqual({ kind: "delta", chars: 0 });
    expect(classifyComposerWrite(`${ESC}[200~`)).toEqual({
      kind: "delta",
      chars: 0,
    });
    expect(classifyComposerWrite(`${ESC}OP`)).toEqual({ kind: "delta", chars: 0 });
    expect(classifyComposerWrite(`a${ESC}[Db`)).toEqual({
      kind: "delta",
      chars: 2,
    });
  });
});

describe("ComposerDraftLedger", () => {
  it("holds a draft until it is submitted", () => {
    const led = new ComposerDraftLedger();
    expect(led.hasDraft("b1")).toBe(false);
    led.note("b1", "fix ");
    led.note("b1", "the bug");
    expect(led.hasDraft("b1")).toBe(true);
    led.note("b1", "\r");
    expect(led.hasDraft("b1")).toBe(false);
  });

  it("clears when the operator backspaces the draft away", () => {
    const led = new ComposerDraftLedger();
    led.note("b1", "hi");
    led.note("b1", "\u007f\u007f");
    expect(led.draftLength("b1")).toBe(0);
    expect(led.hasDraft("b1")).toBe(false);
  });

  it("notifies once when a draft goes empty", () => {
    const led = new ComposerDraftLedger();
    const cleared: string[] = [];
    led.onClear((b) => cleared.push(b));
    led.note("b1", "draft");
    led.note("b1", "\u0003");
    led.note("b1", "\u0003");
    expect(cleared).toEqual(["b1"]);
  });

  it("keeps drafts per binding", () => {
    const led = new ComposerDraftLedger();
    led.note("b1", "typing");
    expect(led.hasDraft("b2")).toBe(false);
    led.clear("b1");
    expect(led.hasDraft("b1")).toBe(false);
  });
});

describe("drive operator-draft gate", () => {
  const writes: Array<{ bindingId: string; data: string }> = [];
  let drafting = false;
  let drive: ManagedTerminalDrive;

  const makeDrive = () =>
    new ManagedTerminalDrive({
      write: (bindingId, data) => {
        writes.push({ bindingId, data });
        return true;
      },
      isSeatIdle: () => true,
      stallWatch: false,
      pasteToCrSettleMs: 0,
      hasOperatorDraft: () => drafting,
    });

  afterEach(() => {
    drive?.resetForTest();
    writes.length = 0;
    drafting = false;
    composerDraft.resetForTest();
  });

  it("never writes into a half-typed prompt on an idle seat", async () => {
    drive = makeDrive();
    drafting = true;
    const refused = await drive.writePrompt("b1", "factory notice", {
      queueIfBusy: false,
    });
    expect(refused).toBe(false);
    expect(writes).toEqual([]);
  });

  it("delivers the queued prompt once the box is clear", async () => {
    drive = makeDrive();
    drafting = true;
    const pending = drive.writePrompt("b1", "factory notice", {
      queueTimeoutMs: 5_000,
    });
    await Promise.resolve();
    expect(writes).toEqual([]);
    expect(drive.queuedCount("b1")).toBe(1);

    drafting = false;
    drive.onComposerClear("b1");
    expect(await pending).toBe(true);
    expect(writes.map((w) => w.data)).toEqual([
      "\u001b[200~factory notice\u001b[201~",
      "\r",
    ]);
  });

  it("does not interrupt a working seat while a draft is on screen", async () => {
    const busy = new ManagedTerminalDrive({
      write: (bindingId, data) => {
        writes.push({ bindingId, data });
        return true;
      },
      isSeatIdle: () => false,
      stallWatch: false,
      pasteToCrSettleMs: 0,
      hasOperatorDraft: () => true,
    });
    const pending = busy.writePrompt("b1", "mail", {
      interruptIfBusy: true,
      queueTimeoutMs: 50,
    });
    await Promise.resolve();
    expect(writes).toEqual([]);
    expect(await pending).toBe(false);
    busy.resetForTest();
  });
});
