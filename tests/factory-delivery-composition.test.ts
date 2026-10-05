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
  it.each([submitted(), refused(), unresolved()])(
    "only accepts a submitted supervisor notice, outcome $status",
    async (outcome) => {
      let writer: ((b: string, t: string) => boolean | Promise<boolean>) | undefined;
      const dispose = wireFactorySupervisor({
        supervisor: {
          setWriter: (fn) => {
            writer = fn;
          },
          setEscalationHandler: () => {},
          noteSeatState: () => {},
          onSnapshot: () => {},
        },
        write: () => Promise.resolve(outcome),
        escalate: () => {},
        subscribeSnapshots: () => () => {},
      });
      await expect(Promise.resolve(writer?.("b1", "notice"))).resolves.toBe(
        outcome.status === "submitted",
      );
      dispose();
    },
  );

  it("re-delivers supervisory notices through the writer", async () => {
    const drive = fakeDrive();
    let writer: ((b: string, t: string) => Promise<boolean>) | undefined;
    let escalation: ((b: string, r: string) => void) | undefined;
    const snapshots: unknown[] = [];
    const closed: string[] = [];
    const dispose = wireFactorySupervisor({
      supervisor: {
        setWriter: (fn) => {
          writer = (b, t) => Promise.resolve(fn(b, t)).then((ok) => ok);
        },
        setEscalationHandler: (fn) => {
          escalation = fn;
        },
        noteSeatState: () => {},
        onSnapshot: (snap) => {
          snapshots.push(snap);
        },
      },
      write: makeFactoryWriteManagedPrompt(drive, () => true),
      escalate: (b, r) => escalation?.(b, r),
      subscribeSnapshots: (listener) => {
        listener({ text: "frame" } as never);
        return () => {
          closed.push("snapshots");
        };
      },
    });
    await writer?.("b1", "supervisor nudge");
    expect(drive.writes).toHaveLength(1);
    expect(drive.writes[0]).toMatchObject({ text: "supervisor nudge" });
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
        setEscalationHandler: () => {},
        noteSeatState: (event) => {
          noted.push(event);
        },
        onSnapshot: () => {},
      },
      escalate: () => {},
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

  it("preserves the writer promise through supervisor wiring", async () => {
    const d = boot();
    const supervisor = new InjectionSupervisor();
    let captured:
      | ((bindingId: string, text: string) => boolean | Promise<boolean>)
      | undefined;
    wireFactorySupervisor({
      supervisor: {
        setWriter: (fn) => {
          captured = fn;
          supervisor.setWriter(fn);
        },
        setEscalationHandler: (fn) => supervisor.setEscalationHandler(fn),
        noteSeatState: (event) => supervisor.noteSeatState(event),
        onSnapshot: (snap) => supervisor.onSnapshot(snap),
      },
      write: makeFactoryWriteManagedPrompt(d, () => true),
      escalate: () => {},
      subscribeSnapshots: () => () => {},
    });
    expect(captured).toBeDefined();
    const result = captured?.("real-b3", "supervisor nudge");
    // Acceptance must stay a real promise result: budgets advance only on
    // true acceptance (see 94657fa1), never on a coerced sync value.
    expect(typeof result).not.toBe("boolean");
    await new Promise((resolve) => setTimeout(resolve, 150));
    d.onTurnStart("real-b3");
    await expect(result).resolves.toBe(true);
    const payload = writes
      .filter((w) => w.bindingId === "real-b3")
      .map((w) => w.data)
      .join("");
    expect(payload).toContain("supervisor nudge");
  });
});
