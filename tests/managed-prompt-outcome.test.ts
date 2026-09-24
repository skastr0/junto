import { describe, expect, it } from "vitest";
import { ManagedTerminalDrive } from "../src/main/junto/term/drive/managed-terminal-drive";
import {
  readManagedPromptOutcome,
  type ManagedPromptOutcome,
} from "../src/shared/managed-prompt";

describe("managed-prompt outcome decoding", () => {
  it("validates wire outcomes and rejects contradictory counters", () => {
    expect(
      readManagedPromptOutcome({
        status: "submitted",
        bindingGeneration: 2,
        writesBefore: 4,
        writesAfter: 5,
        pasteWrites: 1,
        wrotePhysicalBytes: true,
      }),
    ).toMatchObject({ status: "submitted", pasteWrites: 1 });
    expect(
      readManagedPromptOutcome({
        status: "refused",
        reason: "seat-busy",
        bindingGeneration: 0,
        writesBefore: 0,
        writesAfter: 0,
        pasteWrites: 0,
        wrotePhysicalBytes: false,
      }),
    ).toMatchObject({ status: "refused", reason: "seat-busy" });
    // Backwards delta proves nothing.
    expect(
      readManagedPromptOutcome({
        status: "submitted",
        bindingGeneration: 0,
        writesBefore: 5,
        writesAfter: 4,
        pasteWrites: -1,
        wrotePhysicalBytes: true,
      }),
    ).toBeUndefined();
    // Per-attempt count must equal the envelope delta.
    expect(
      readManagedPromptOutcome({
        status: "submitted",
        bindingGeneration: 0,
        writesBefore: 4,
        writesAfter: 5,
        pasteWrites: 0,
        wrotePhysicalBytes: true,
      }),
    ).toBeUndefined();
    // Malformed shape or reason proves nothing.
    expect(readManagedPromptOutcome({ status: "submitted" })).toBeUndefined();
    expect(
      readManagedPromptOutcome({
        status: "refused",
        reason: "bogus",
        bindingGeneration: 0,
        writesBefore: 0,
        writesAfter: 0,
        pasteWrites: 0,
        wrotePhysicalBytes: false,
      }),
    ).toBeUndefined();
    expect(readManagedPromptOutcome(true)).toBeUndefined();
    expect(readManagedPromptOutcome(null)).toBeUndefined();
  });
});

describe("ManagedTerminalDrive discriminated outcomes", () => {
  const makeDrive = (
    over: Partial<
      ConstructorParameters<typeof ManagedTerminalDrive>[0]
    > = {},
  ) => {
    let idle = true;
    const writes: Array<{ bindingId: string; data: string }> = [];
    const drive = new ManagedTerminalDrive({
      write: (bindingId, data) => {
        writes.push({ bindingId, data });
        return true;
      },
      isSeatIdle: () => idle,
      now: () => 10_000,
      stallWatch: false,
      stallTimeoutMs: 10,
      pasteToCrSettleMs: 0,
      ...over,
    });
    return {
      drive,
      writes,
      setIdle: (value: boolean) => {
        idle = value;
      },
    };
  };

  it("resolves submitted with physical-write facts on the fast path", async () => {
    const { drive } = makeDrive({
      pendingText: () => false,
      write: (bindingId, data) => {
        if (data === "\r") drive.onTurnStart(bindingId);
        return true;
      },
    });
    const outcome = await drive.writePrompt("b", "hello", {
      awaitTurnStart: false,
    });
    expect(outcome.status).toBe("submitted");
    if (outcome.status !== "submitted") return;
    expect(outcome.wrotePhysicalBytes).toBe(true);
    expect(outcome.pasteWrites).toBe(1);
    expect(outcome.writesAfter).toBeGreaterThan(outcome.writesBefore);
    expect(outcome.bindingGeneration).toBe(0);
  });

  it("refuses seat-busy with zero writes when non-queueing and busy", async () => {
    const { drive, setIdle } = makeDrive();
    setIdle(false);
    const outcome = await drive.writePrompt("b", "hello", {
      queueIfBusy: false,
    });
    expect(outcome).toMatchObject({
      status: "refused",
      reason: "seat-busy",
      pasteWrites: 0,
      wrotePhysicalBytes: false,
    });
  });

  it("refuses not-ready before any gate when the caller is not ready", async () => {
    const { drive } = makeDrive();
    const outcome = await drive.writePrompt("b", "hello", { ready: false });
    expect(outcome).toMatchObject({
      status: "refused",
      reason: "not-ready",
      wrotePhysicalBytes: false,
    });
  });

  it("refuses composer-not-empty on a visible draft", async () => {
    const { drive } = makeDrive({ composerVerdict: () => "draft" });
    const outcome = await drive.writePrompt("b", "hello", {
      queueIfBusy: false,
    });
    expect(outcome).toMatchObject({
      status: "refused",
      reason: "composer-not-empty",
      wrotePhysicalBytes: false,
    });
  });

  it("resolves unresolved chip-pending when evidence shows our text, then guards the seat", async () => {
    const { drive } = makeDrive({ pendingText: () => true });
    const first = await drive.writePrompt("b", "hello", {
      awaitTurnStart: false,
    });
    expect(first).toMatchObject({
      status: "unresolved",
      reason: "chip-pending",
      wrotePhysicalBytes: true,
    });
    const second = await drive.writePrompt("b", "later", {
      awaitTurnStart: false,
    });
    expect(second).toMatchObject({
      status: "refused",
      reason: "written-unresolved",
      wrotePhysicalBytes: false,
    });
  });

  it("resolves suspended after shutdown without writing", async () => {
    const { drive, writes } = makeDrive();
    drive.suspend();
    const outcome = await drive.writePrompt("b", "hello");
    expect(outcome).toMatchObject({
      status: "refused",
      reason: "suspended",
    });
    expect(writes).toHaveLength(0);
  });
});
