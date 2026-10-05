/**
 * Focused composition tests: the seat delivery paths (injection supervisor)
 * reach the seat through the destination drive. No raw PTY bypass exists in
 * the shared recipe.
 */
import { afterEach, describe, expect, it, vi } from "vitest";
import type { WritePromptOptions } from "../src/main/junto/term/drive";
import type { ManagedPromptOutcome } from "../src/shared/managed-prompt";
import { createManagedTerminalDrive } from "../src/main/junto/term/drive/managed-drive-factory";
import { InjectionSupervisor } from "../src/main/junto/term/injection-supervisor";
import {
  composeFactoryDelivery,
  factoryDeliveryReadTag,
  makeFactoryWriteManagedPrompt,
  wireFactorySupervisor,
  type FactoryDeliveryDrive,
} from "../src/main/junto/term/factory-delivery-composition";

type FakeDrive = {
  writes: Array<{ bindingId: string; text: string; options: unknown }>;
  writePrompt: (
    bindingId: string,
    text: string,
    options: WritePromptOptions,
  ) => Promise<ManagedPromptOutcome>;
};

const submitted = (): ManagedPromptOutcome => ({
  status: "submitted",
  bindingGeneration: 3,
  writesBefore: 6,
  writesAfter: 7,
  pasteWrites: 1,
  wrotePhysicalBytes: true,
});
const refused = (): ManagedPromptOutcome => ({
  status: "refused",
  reason: "seat-busy",
  bindingGeneration: 3,
  writesBefore: 7,
  writesAfter: 7,
  pasteWrites: 0,
  wrotePhysicalBytes: false,
});
const unresolved = (): ManagedPromptOutcome => ({
  status: "unresolved",
  reason: "no-turn-start",
  bindingGeneration: 3,
  writesBefore: 6,
  writesAfter: 7,
  pasteWrites: 1,
  wrotePhysicalBytes: true,
});

const fakeDrive = (): FakeDrive => {
  const writes: Array<{ bindingId: string; text: string; options: unknown }> =
    [];
  return {
    writes,
    writePrompt: (bindingId, text, options) => {
      writes.push({ bindingId, text, options });
      return Promise.resolve(submitted());
    },
  };
};

describe("makeFactoryWriteManagedPrompt", () => {
  it("defaults readiness to the drive-ready predicate", async () => {
    const drive = fakeDrive();
    const write = makeFactoryWriteManagedPrompt(drive, () => false);
    await write("b1", "hello");
    expect(drive.writes).toHaveLength(1);
    expect(drive.writes[0]).toMatchObject({
      bindingId: "b1",
      text: "hello",
      options: { ready: false },
    });
  });

  it("lets an explicit ready flag win", async () => {
    const drive = fakeDrive();
    const write = makeFactoryWriteManagedPrompt(drive, () => false);
    await write("b1", "hello", { ready: true });
    expect(drive.writes[0]).toMatchObject({ options: { ready: true } });
  });

  it.each([submitted(), refused(), unresolved()])(
    "preserves the complete $status outcome",
    async (outcome) => {
      const drive = fakeDrive();
      drive.writePrompt = () => Promise.resolve(outcome);
      const write = makeFactoryWriteManagedPrompt(drive, () => true);
      await expect(write("b1", "hello")).resolves.toBe(outcome);
    },
  );
});

describe("wireFactorySupervisor", () => {
  it("hands the supervisor the interjecting writer and the drive's composer reading", async () => {
    let writer: ((b: string, t: string) => boolean | Promise<boolean>) | undefined;
    let composer: ((b: string) => "empty" | "draft" | null) | undefined;
    const typed: Array<{ bindingId: string; text: string }> = [];
    const snapshots: unknown[] = [];
    const closed: string[] = [];
    const dispose = wireFactorySupervisor({
      supervisor: {
        setWriter: (fn) => {
          writer = fn;
        },
        setComposerLookup: (fn) => {
          composer = fn;
        },
        noteSeatState: () => {},
        onSnapshot: (snap) => {
          snapshots.push(snap);
        },
      },
      interject: (bindingId, text) => {
        typed.push({ bindingId, text });
        return Promise.resolve(bindingId === "b1");
      },
      composerVerdict: (b) => (b === "b1" ? "draft" : "empty"),
      subscribeSnapshots: (listener) => {
        listener({ text: "frame" } as never);
        return () => {
          closed.push("snapshots");
        };
      },
    });
    // Acceptance is the interjection's own answer: typed or not.
    await expect(Promise.resolve(writer?.("b1", "nudge"))).resolves.toBe(true);
    await expect(Promise.resolve(writer?.("b2", "nudge"))).resolves.toBe(false);
    expect(typed).toEqual([
      { bindingId: "b1", text: "nudge" },
      { bindingId: "b2", text: "nudge" },
    ]);
    // The supervisor gates on the same composer reading the drive does.
    expect(composer?.("b1")).toBe("draft");
    expect(composer?.("b2")).toBe("empty");
    expect(snapshots).toEqual([{ text: "frame" }]);
    dispose();
    expect(closed).toEqual(["snapshots"]);
  });
});

describe("factoryDeliveryReadTag", () => {
  it("names every read site distinctly", () => {
    expect(factoryDeliveryReadTag("scan")).toBe("delivery.scan");
    expect(factoryDeliveryReadTag("attempt")).toBe("delivery.attempt");
  });
});

describe("composeFactoryDelivery", () => {
  const harness = () => {
    const drive = fakeDrive();
    const seatListeners: Array<(event: never) => void> = [];
    const noted: unknown[] = [];
    const unsubs: string[] = [];
    const composed = composeFactoryDelivery({
      drive,
      driveReady: () => true,
      kernel: { wakeManagedSeat: () => true },
      events: {
        subscribeSeatState: (listener) => {
          seatListeners.push(listener as (event: never) => void);
          return () => {
            unsubs.push("seat");
          };
        },
        subscribeSnapshots: () => () => {
          unsubs.push("snapshots");
        },
      },
      supervisor: {
        setWriter: () => {},
        setComposerLookup: () => {},
        noteSeatState: (event) => {
          noted.push(event);
        },
        onSnapshot: () => {},
      },
      interject: () => Promise.resolve(true),
      composerVerdict: () => "empty",
      pulse: { setDeliver: () => {} },
      board: { configure: () => {} },
    });
    return { drive, composed, seatListeners, noted, unsubs };
  };

  it("notes every seat state", () => {
    const h = harness();
    h.seatListeners[0]({ bindingId: "b1", state: "working" } as never);
    h.seatListeners[0]({ bindingId: "b2", state: "gone" } as never);
    expect(h.noted).toHaveLength(2);
  });

  it("dispose closes every subscription it opened", () => {
    const h = harness();
    h.composed.dispose();
    expect(h.unsubs).toEqual(expect.arrayContaining(["seat", "snapshots"]));
  });
});

describe("real destination-drive composition", () => {
  const writes: Array<{ bindingId: string; data: string }> = [];
  let drive!: ReturnType<typeof createManagedTerminalDrive>;

  const emptySnapshot = () => ({ text: "", lines: [] as string[] });

  const boot = () => {
    writes.length = 0;
    drive = createManagedTerminalDrive({
      write: (bindingId, data) => {
        writes.push({ bindingId, data });
        if (data === "\r") drive.onTurnStart(bindingId);
        return true;
      },
      isSeatIdle: () => true,
      seatState: () => "idle" as const,
      onAttention: () => {},
      snapshot: emptySnapshot,
      composerVerdict: () => "empty" as const,
      harnessFor: () => "codex",
    });
    return drive;
  };

  afterEach(() => {
    drive?.resetForTest();
    writes.length = 0;
    vi.useRealTimers();
  });

  it("the supervisor's nudge is typed by the real drive while the seat is mid-turn", async () => {
    writes.length = 0;
    const busy = createManagedTerminalDrive({
      write: (bindingId, data) => {
        writes.push({ bindingId, data });
        return true;
      },
      // Mid-turn: the gated write would refuse or queue here.
      isSeatIdle: () => false,
      seatState: () => "working" as const,
      onAttention: () => {},
      snapshot: emptySnapshot,
      composerVerdict: () => "empty" as const,
      harnessFor: () => "codex",
    });
    drive = busy;
    const supervisor = new InjectionSupervisor();
    wireFactorySupervisor({
      supervisor,
      interject: (bindingId, text) =>
        busy.writeMail(bindingId, text).then((outcome) => outcome === "written"),
      composerVerdict: () => "empty",
      subscribeSnapshots: () => () => {},
    });
    supervisor.noteSeatState({
      bindingId: "real-b3",
      epoch: "e1",
      state: "working",
      reason: "test",
      confidence: "high",
      at: 0,
    });
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(writes).toEqual([]);
    // The first real message goes in; the nudge follows without waiting for
    // the turn to end.
    supervisor.noteMailWritten("real-b3");
    await new Promise((resolve) => setTimeout(resolve, 400));
    const payload = writes
      .filter((w) => w.bindingId === "real-b3")
      .map((w) => w.data)
      .join("");
    expect(payload).toContain("Run `junto onboard`");
    expect(payload.endsWith("\r")).toBe(true);
  });
});
