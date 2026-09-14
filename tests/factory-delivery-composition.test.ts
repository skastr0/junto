/**
 * Focused composition tests: the five factory delivery paths (pulse, mail,
 * supervisor, board, first-typed) all reach the seat through the destination
 * drive. No raw PTY bypass exists in the shared recipe.
 */
import { afterEach, describe, expect, it, vi } from "vitest";
import type { WritePromptOptions } from "../src/main/vellum-command/term/drive";
import { createManagedTerminalDrive } from "../src/main/vellum-command/term/drive/managed-drive-factory";
import { makeManagedPulseDeliver } from "../src/main/vellum-command/term/managed-pulse-bridge";
import { InjectionSupervisor } from "../src/main/vellum-command/term/injection-supervisor";
import {
  armFirstTypedMessage,
  clearDeliveredForBinding,
  peekFirstTypedEntry,
  peekFirstTypedMessage,
  resetFirstTypedForTest,
  takeFirstTypedEntryIfCurrent,
} from "../src/main/vellum-command/term/first-typed";
import { MessageDeliveryService } from "../src/main/vellum-command/work/message-delivery";
import {
  composeFactoryDelivery,
  factoryBoardTransport,
  factoryDeliveryReadTag,
  factoryMailTransport,
  factoryPulseTransport,
  factorySeatPaused,
  makeFactoryFirstTypedKick,
  makeFactoryWriteManagedPrompt,
  wireFactorySupervisor,
  type FactoryDeliveryDrive,
} from "../src/main/vellum-command/term/factory-delivery-composition";

type FakeDrive = {
  writes: Array<{ bindingId: string; text: string; options: unknown }>;
  writePrompt: (
    bindingId: string,
    text: string,
    options: WritePromptOptions,
  ) => Promise<boolean>;
  pasteWriteCount: (bindingId: string) => number;
};

const fakeDrive = (): FakeDrive => {
  const writes: Array<{ bindingId: string; text: string; options: unknown }> =
    [];
  return {
    writes,
    writePrompt: (bindingId, text, options) => {
      writes.push({ bindingId, text, options });
      return Promise.resolve(true);
    },
    pasteWriteCount: () => 7,
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
});

describe("makeFactoryFirstTypedKick", () => {
  it("consumes the armed doctrine only after a successful paste", async () => {
    const drive = fakeDrive();
    let armed: string | undefined = "doctrine body";
    let seq = 1;
    const taken: string[] = [];
    const { kick } = makeFactoryFirstTypedKick({
      firstTyped: {
        peekEntry: () => (armed === undefined ? undefined : { text: armed, seq }),
        takeEntryIfCurrent: (_b, s) => {
          if (s !== seq || armed === undefined) return undefined;
          taken.push("b1");
          const text = armed;
          armed = undefined;
          return text;
        },
        clearDeliveredForBinding: () => {},
      },
      driveReady: () => true,
      write: makeFactoryWriteManagedPrompt(drive, () => true),
    });
    kick("b1");
    await Promise.resolve();
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(drive.writes).toHaveLength(1);
    expect(drive.writes[0].options).toMatchObject({ awaitTurnStart: false });
    expect(taken).toEqual(["b1"]);
  });

  it("keeps the arm when the drive refuses", async () => {
    const drive = fakeDrive();
    drive.writePrompt = () => Promise.resolve(false);
    let armed: string | undefined = "doctrine body";
    const seq = 1;
    let took = 0;
    const { kick } = makeFactoryFirstTypedKick({
      firstTyped: {
        peekEntry: () => (armed === undefined ? undefined : { text: armed, seq }),
        takeEntryIfCurrent: (_b, s) => {
          if (s !== seq) return undefined;
          took += 1;
          return armed;
        },
        clearDeliveredForBinding: () => {},
      },
      driveReady: () => true,
      write: makeFactoryWriteManagedPrompt(drive, () => true),
    });
    kick("b1");
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(took).toBe(0);
    expect(armed).toBe("doctrine body");
  });

  it("holds one arm per binding while a kick is in flight", () => {
    const drive = fakeDrive();
    let calls = 0;
    let resolveWrite!: (ok: boolean) => void;
    drive.writePrompt = () => {
      calls += 1;
      return new Promise<boolean>((resolve) => {
        resolveWrite = resolve;
      });
    };
    const { kick, inFlight } = makeFactoryFirstTypedKick({
      firstTyped: {
        peekEntry: () => ({ text: "doctrine", seq: 1 }),
        takeEntryIfCurrent: (_b, s) => (s === 1 ? "doctrine" : undefined),
        clearDeliveredForBinding: () => {},
      },
      driveReady: () => true,
      write: makeFactoryWriteManagedPrompt(drive, () => true),
    });
    kick("b1");
    kick("b1");
    expect(calls).toBe(1);
    expect(inFlight.has("b1")).toBe(true);
    resolveWrite(true);
  });

  it("does nothing when the seat is not drive-ready", () => {
    const drive = fakeDrive();
    const { kick } = makeFactoryFirstTypedKick({
      firstTyped: {
        peekEntry: () => ({ text: "doctrine", seq: 1 }),
        takeEntryIfCurrent: (_b, s) => (s === 1 ? "doctrine" : undefined),
        clearDeliveredForBinding: () => {},
      },
      driveReady: () => false,
      write: makeFactoryWriteManagedPrompt(drive, () => true),
    });
    kick("b1");
    expect(drive.writes).toHaveLength(0);
  });

  it("late success never consumes a newer rearmed doctrine", async () => {
    const drive = fakeDrive();
    let resolveWrite!: (ok: boolean) => void;
    drive.writePrompt = () =>
      new Promise<boolean>((resolve) => {
        resolveWrite = resolve;
      });
    let armed: string | undefined = "generation-one";
    let seq = 1;
    const taken: string[] = [];
    const { kick, inFlight } = makeFactoryFirstTypedKick({
      firstTyped: {
        peekEntry: () => (armed === undefined ? undefined : { text: armed, seq }),
        takeEntryIfCurrent: (_b, s) => {
          if (s !== seq || armed === undefined) return undefined;
          taken.push(armed);
          const text = armed;
          armed = undefined;
          return text;
        },
        clearDeliveredForBinding: () => {},
      },
      driveReady: () => true,
      write: makeFactoryWriteManagedPrompt(drive, () => true),
    });
    kick("b1");
    // Generation replacement rearms mid-flight with newer doctrine.
    armed = "generation-two";
    seq = 2;
    resolveWrite(true);
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(taken).toEqual([]);
    expect(armed).toBe("generation-two");
    expect(inFlight.has("b1")).toBe(false);
    // The newer doctrine remains kickable.
    let secondCalls = 0;
    drive.writePrompt = () => {
      secondCalls += 1;
      return Promise.resolve(true);
    };
    kick("b1");
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(secondCalls).toBe(1);
    expect(taken).toEqual(["generation-two"]);
  });

  it("same-text rearm survives a late old success (real registry)", async () => {
    // Reviewer scenario: arm T, old kick in flight, clear plus rearm of the
    // IDENTICAL text. Text equality is not arm identity — the old success
    // must not consume the new arm.
    const drive = fakeDrive();
    let resolveWrite!: (ok: boolean) => void;
    drive.writePrompt = () =>
      new Promise<boolean>((resolve) => {
        resolveWrite = resolve;
      });
    const { kick, inFlight } = makeFactoryFirstTypedKick({
      firstTyped: {
        peekEntry: peekFirstTypedEntry,
        takeEntryIfCurrent: takeFirstTypedEntryIfCurrent,
        clearDeliveredForBinding,
      },
      driveReady: () => true,
      write: makeFactoryWriteManagedPrompt(drive, () => true),
    });
    armFirstTypedMessage("rearm-b", "identical doctrine");
    kick("rearm-b");
    clearDeliveredForBinding("rearm-b");
    armFirstTypedMessage("rearm-b", "identical doctrine");
    resolveWrite(true);
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(peekFirstTypedMessage("rearm-b")).toBe("identical doctrine");
    expect(inFlight.has("rearm-b")).toBe(false);
  });

  it("same-body new idle before old settle re-kicks once (real registry)", async () => {
    // Liveness: old seq1 in flight, generation clear plus IDENTICAL rearm
    // (seq2), then a new idle before the old write settles. The old
    // completion must neither consume the new arm nor strand it: exactly
    // one re-kick delivers the new arm.
    const drive = fakeDrive();
    const resolvers: Array<(ok: boolean) => void> = [];
    let calls = 0;
    drive.writePrompt = () => {
      calls += 1;
      return new Promise<boolean>((resolve) => {
        resolvers.push(resolve);
      });
    };
    const { kick, inFlight } = makeFactoryFirstTypedKick({
      firstTyped: {
        peekEntry: peekFirstTypedEntry,
        takeEntryIfCurrent: takeFirstTypedEntryIfCurrent,
        clearDeliveredForBinding,
      },
      driveReady: () => true,
      write: makeFactoryWriteManagedPrompt(drive, () => true),
    });
    armFirstTypedMessage("live-b", "same body");
    kick("live-b");
    expect(calls).toBe(1);
    clearDeliveredForBinding("live-b");
    armFirstTypedMessage("live-b", "same body");
    kick("live-b");
    expect(calls).toBe(1);
    resolvers[0](false);
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(calls).toBe(2);
    resolvers[1](true);
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(peekFirstTypedMessage("live-b")).toBeUndefined();
    expect(inFlight.has("live-b")).toBe(false);
  });

  it("same-arm kicks while settling never retry-loop", async () => {
    const drive = fakeDrive();
    let calls = 0;
    let resolveWrite!: (ok: boolean) => void;
    drive.writePrompt = () => {
      calls += 1;
      return new Promise<boolean>((resolve) => {
        resolveWrite = resolve;
      });
    };
    const { kick } = makeFactoryFirstTypedKick({
      firstTyped: {
        peekEntry: () => ({ text: "doctrine", seq: 1 }),
        takeEntryIfCurrent: (_b, s) => (s === 1 ? "doctrine" : undefined),
        clearDeliveredForBinding: () => {},
      },
      driveReady: () => true,
      write: makeFactoryWriteManagedPrompt(drive, () => true),
    });
    kick("b1");
    kick("b1");
    resolveWrite(false);
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(calls).toBe(1);
  });

  it("a rejected write releases the flight and keeps the arm", async () => {
    const drive = fakeDrive();
    drive.writePrompt = () => Promise.reject(new Error("seat gone"));
    let armed: string | undefined = "doctrine body";
    const seq = 7;
    let took = 0;
    const { kick, inFlight } = makeFactoryFirstTypedKick({
      firstTyped: {
        peekEntry: () => (armed === undefined ? undefined : { text: armed, seq }),
        takeEntryIfCurrent: (_b, s) => {
          if (s !== seq) return undefined;
          took += 1;
          return armed;
        },
        clearDeliveredForBinding: () => {},
      },
      driveReady: () => true,
      write: makeFactoryWriteManagedPrompt(drive, () => true),
    });
    kick("b1");
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(took).toBe(0);
    expect(armed).toBe("doctrine body");
    expect(inFlight.has("b1")).toBe(false);
  });
});

describe("factoryPulseTransport", () => {
  it("routes pulses through the drive without the busy queue", async () => {
    const drive = fakeDrive();
    let delivered: ((b: string, m: string) => Promise<boolean>) | undefined;
    const returned = factoryPulseTransport({
      pulse: {
        setDeliver: (fn) => {
          delivered = fn;
        },
      },
      drive,
      driveReady: () => true,
    });
    expect(delivered).toBeDefined();
    expect(returned).toBe(delivered);
    await delivered?.("b1", "pulse body");
    expect(drive.writes).toHaveLength(1);
    expect(drive.writes[0]).toMatchObject({
      bindingId: "b1",
      text: "pulse body",
      options: { ready: true, queueIfBusy: false },
    });
  });

  it("registers the concrete closure so conditional wrappers cannot recurse", async () => {
    // Regression for the ipc wiring defect: the suspension-conditional
    // re-registration wrapped the global dispatcher instead of the
    // factory closure, so every kernel pulse recursed into itself.
    // This test replays the exact registration order against the real
    // bridge: factory registration, conditional wrapper, one pulse.
    const {
      managedPulseDeliver,
      setManagedPulseDeliver,
    } = await import(
      "../src/main/vellum-command/term/managed-pulse-bridge"
    );
    const drive = fakeDrive();
    try {
      const concrete = factoryPulseTransport({
        pulse: { setDeliver: setManagedPulseDeliver },
        drive,
        driveReady: () => true,
      });
      const suspended = false;
      setManagedPulseDeliver(
        suspended ? undefined : (bindingId, text) => concrete(bindingId, text),
      );
      await managedPulseDeliver("bridge-b1", "kernel pulse");
      const payload = drive.writes
        .filter((w) => w.bindingId === "bridge-b1")
        .map((w) => w.text)
        .join("");
      expect(payload).toContain("kernel pulse");
      expect(
        drive.writes.filter((w) => w.bindingId === "bridge-b1"),
      ).toHaveLength(1);
    } finally {
      setManagedPulseDeliver(undefined);
    }
  });
});

describe("factoryBoardTransport", () => {
  it("wakes the seat then sends through the writer", async () => {
    const drive = fakeDrive();
    const woke: Array<[string, string]> = [];
    const transport = factoryBoardTransport({
      kernel: {
        wakeManagedSeat: (canvas, nodeId) => {
          woke.push([canvas, nodeId]);
          return true;
        },
      },
      write: makeFactoryWriteManagedPrompt(drive, () => true),
    });
    await transport.wakeManagedSeat?.("board-canvas", "n1");
    await transport.sendManagedTerminalPrompt("b1", "megaphone");
    expect(woke).toEqual([["board-canvas", "n1"]]);
    expect(drive.writes).toHaveLength(1);
    expect(drive.writes[0]).toMatchObject({ text: "megaphone" });
  });
});

describe("factoryMailTransport", () => {
  it("refuses raw paste and gates managed sends on the drive", async () => {
    const drive = fakeDrive();
    const transport = factoryMailTransport({
      kernel: { wakeManagedSeat: () => true },
      write: makeFactoryWriteManagedPrompt(drive, () => true),
      drive,
      seatSnapshot: () => ({
        idle: true,
        generationKey: "g1",
        operatorDraft: false,
      }),
    });
    expect(transport.sendTerminalPaste?.("b1", "x", "m1")).toBe(false);
    await transport.sendManagedTerminalPrompt?.("b1", "mail body", {});
    expect(drive.writes).toHaveLength(1);
    expect(transport.pasteWriteCount?.("b1")).toBe(7);
    await expect(
      Promise.resolve(transport.seatDeliverySnapshot?.("b1")),
    ).resolves.toMatchObject({ idle: true, generationKey: "g1" });
  });
});

describe("wireFactorySupervisor", () => {
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
    expect(factoryDeliveryReadTag("batch")).toBe("delivery.batch");
  });
});

describe("factorySeatPaused", () => {
  it("applies the pause law to the plane snapshot", () => {
    const doc = { nodes: [], edges: [] } as unknown as Parameters<
      typeof factorySeatPaused
    >[2];
    expect(
      factorySeatPaused(
        { stateFor: () => ({ playing: false }) } as never,
        "c",
        doc,
        "n1",
      ),
    ).toBe(true);
  });
});

describe("composeFactoryDelivery", () => {
  const harness = () => {
    const drive = fakeDrive();
    const seatListeners: Array<(event: never) => void> = [];
    const composerListeners: Array<(bindingId: string) => void> = [];
    const pauseListeners: Array<(canvas: string) => void> = [];
    const idle: string[] = [];
    const composerEmpty: string[] = [];
    const resumed: string[] = [];
    const booted: string[] = [];
    const noted: unknown[] = [];
    const cleared: string[] = [];
    const scheduled: Array<{ ms: number }> = [];
    const unsubs: string[] = [];
    const composed = composeFactoryDelivery({
      drive,
      driveReady: () => true,
      kernel: { wakeManagedSeat: () => true },
      pause: {
        stateFor: () => ({ playing: true }) as never,
        subscribe: (listener) => {
          pauseListeners.push(listener);
          return () => {
            unsubs.push("pause");
          };
        },
      },
      events: {
        subscribeSeatState: (listener) => {
          seatListeners.push(listener as (event: never) => void);
          return () => {
            unsubs.push("seat");
          };
        },
        subscribeComposerEmpty: (listener) => {
          composerListeners.push(listener);
          return () => {
            unsubs.push("composer");
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
      mail: {
        configure: () => {},
        onManagedTerminalIdle: (b) => {
          idle.push(b);
        },
        onComposerEmpty: (b) => {
          composerEmpty.push(b);
        },
        onResumed: () => {
          resumed.push("resumed");
        },
        onBooted: () => {
          booted.push("booted");
        },
        suspend: () => {},
      },
      store: {} as never,
      pulse: { setDeliver: () => {} },
      board: { configure: () => {} },
      firstTyped: {
        peekEntry: () => undefined,
        takeEntryIfCurrent: () => undefined,
        clearDeliveredForBinding: (b) => {
          cleared.push(b);
        },
      },
      seatSnapshot: () => undefined,
      scheduleBootRescan: (fn, ms) => {
        scheduled.push({ ms });
        fn();
      },
    });
    return {
      drive,
      composed,
      seatListeners,
      composerListeners,
      pauseListeners,
      idle,
      composerEmpty,
      resumed,
      booted,
      noted,
      cleared,
      scheduled,
      unsubs,
    };
  };

  it("drives mail lifecycle from seat, composer, pause, and boot events", () => {
    const h = harness();
    h.seatListeners[0]({
      bindingId: "b1",
      state: "idle",
    } as never);
    h.seatListeners[0]({
      bindingId: "b2",
      state: "gone",
    } as never);
    h.composerListeners[0]("b1");
    h.pauseListeners[0]("canvas");
    expect(h.idle).toEqual(["b1"]);
    expect(h.noted).toHaveLength(2);
    expect(h.cleared).toEqual(["b2"]);
    expect(h.composerEmpty).toEqual(["b1"]);
    expect(h.resumed).toEqual(["resumed"]);
    expect(h.booted).toEqual(["booted"]);
    expect(h.scheduled).toEqual([{ ms: 10_000 }]);
  });

  it("holds mail while its canvas is paused", () => {
    const h = harness();
    expect(h.composed).toBeDefined();
    expect(h.drive.writes).toHaveLength(0);
  });

  it("dispose closes every subscription it opened", () => {
    const h = harness();
    h.composed.dispose();
    expect(h.unsubs).toEqual(
      expect.arrayContaining(["seat", "composer", "pause", "snapshots"]),
    );
  });

  it("exposes a doctrine kick for the runtime pre-idle hook", async () => {
    const drive = fakeDrive();
    const h = harness();
    void h;
    const armed = new Map([["b9", "doctrine"]]);
    const { kickFirstTyped } = composeFactoryDelivery({
      drive,
      driveReady: () => true,
      kernel: { wakeManagedSeat: () => true },
      pause: {
        stateFor: () => ({ playing: true }) as never,
        subscribe: () => () => {},
      },
      events: {
        subscribeSeatState: () => () => {},
        subscribeComposerEmpty: () => () => {},
        subscribeSnapshots: () => () => {},
      },
      supervisor: {
        setWriter: () => {},
        setEscalationHandler: () => {},
        noteSeatState: () => {},
        onSnapshot: () => {},
      },
      escalate: () => {},
      mail: {
        configure: () => {},
        onManagedTerminalIdle: () => {},
        onComposerEmpty: () => {},
        onResumed: () => {},
        onBooted: () => {},
        suspend: () => {},
      },
      store: {} as never,
      pulse: { setDeliver: () => {} },
      board: { configure: () => {} },
      firstTyped: {
        peekEntry: (b) => {
          const text = armed.get(b);
          return text === undefined ? undefined : { text, seq: 1 };
        },
        takeEntryIfCurrent: (b, s) => (s === 1 ? armed.get(b) : undefined),
        clearDeliveredForBinding: () => {},
      },
      seatSnapshot: () => undefined,
      scheduleBootRescan: () => {},
    });
    kickFirstTyped("b9");
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(
      drive.writes.some(
        (w) => w.bindingId === "b9" && w.text === "doctrine",
      ),
    ).toBe(true);
  });

  it("uses the injected boot delay when provided", () => {
    const drive = fakeDrive();
    const seen: number[] = [];
    composeFactoryDelivery({
      drive,
      driveReady: () => true,
      kernel: { wakeManagedSeat: () => true },
      pause: {
        stateFor: () => ({ playing: true }) as never,
        subscribe: () => () => {},
      },
      events: {
        subscribeSeatState: () => () => {},
        subscribeComposerEmpty: () => () => {},
        subscribeSnapshots: () => () => {},
      },
      supervisor: {
        setWriter: () => {},
        setEscalationHandler: () => {},
        noteSeatState: () => {},
        onSnapshot: () => {},
      },
      escalate: () => {},
      mail: {
        configure: () => {},
        onManagedTerminalIdle: () => {},
        onComposerEmpty: () => {},
        onResumed: () => {},
        onBooted: () => {},
        suspend: () => {},
      },
      store: {} as never,
      pulse: { setDeliver: () => {} },
      board: { configure: () => {} },
      firstTyped: {
        peekEntry: () => undefined,
        takeEntryIfCurrent: () => undefined,
        clearDeliveredForBinding: () => {},
      },
      seatSnapshot: () => undefined,
      bootRescanMs: 5_000,
      scheduleBootRescan: (_fn, ms) => {
        seen.push(ms);
      },
    });
    expect(seen).toEqual([5_000]);
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
    resetFirstTypedForTest();
    writes.length = 0;
    vi.useRealTimers();
  });

  it("kicks armed doctrine through the real drive recipe", async () => {
    const d = boot();
    armFirstTypedMessage("real-b1", "doctrine body");
    const write = makeFactoryWriteManagedPrompt(d, () => true);
    const { kick } = makeFactoryFirstTypedKick({
      firstTyped: {
        peekEntry: peekFirstTypedEntry,
        takeEntryIfCurrent: takeFirstTypedEntryIfCurrent,
        clearDeliveredForBinding,
      },
      driveReady: () => true,
      write,
    });
    kick("real-b1");
    await new Promise((resolve) => setTimeout(resolve, 250));
    expect(peekFirstTypedMessage("real-b1")).toBeUndefined();
    const payload = writes
      .filter((w) => w.bindingId === "real-b1")
      .map((w) => w.data)
      .join("");
    expect(payload).toContain("doctrine body");
    // Paste and CR are separate writes — never joined, never LF.
    expect(writes.filter((w) => w.bindingId === "real-b1").length).toBeGreaterThanOrEqual(2);
  });

  it("routes the real pulse deliverable through the drive", async () => {
    const d = boot();
    const deliver = makeManagedPulseDeliver(
      (bindingId, text, options) => d.writePrompt(bindingId, text, options),
      () => true,
    );
    const pending = deliver("real-b2", "pulse body");
    await new Promise((resolve) => setTimeout(resolve, 150));
    d.onTurnStart("real-b2");
    await expect(pending).resolves.toBe(true);
    const payload = writes
      .filter((w) => w.bindingId === "real-b2")
      .map((w) => w.data)
      .join("");
    expect(payload).toContain("pulse body");
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

  it("accepts the composed mail transport on the real delivery class", async () => {
    const d = boot();
    const delivery = new MessageDeliveryService();
    const write = makeFactoryWriteManagedPrompt(d, () => true);
    delivery.configure({
      transport: factoryMailTransport({
        kernel: { wakeManagedSeat: () => true },
        write,
        drive: d,
        seatSnapshot: () => undefined,
      }),
      store: {
        listCanvasNames: () => Promise.resolve([]),
        readDoc: () => Promise.resolve(undefined),
        readNodeStructure: () => Promise.resolve(undefined),
        hasAcceptedMessageDelivery: () => Promise.resolve(false),
        hasAcceptedMessageRead: () => Promise.resolve(false),
        acceptMessageDelivery: () => Promise.resolve(true),
        acceptMessageRead: () => Promise.resolve(true),
      },
      seatPaused: () => false,
    });
    delivery.onManagedTerminalIdle("real-b4");
    delivery.onComposerEmpty("real-b4");
    delivery.onResumed();
    await new Promise((resolve) => setTimeout(resolve, 50));
    // Empty world: nothing to send, and no raw write escapes the drive.
    expect(writes).toHaveLength(0);
    delivery.suspend();
    delivery.resetForTest();
  });

  it("sends board wakes through the real drive", async () => {
    const d = boot();
    const transport = factoryBoardTransport({
      kernel: { wakeManagedSeat: () => true },
      write: makeFactoryWriteManagedPrompt(d, () => true),
    });
    const pending = transport.sendManagedTerminalPrompt("real-b5", "megaphone", {
      ready: true,
    });
    await new Promise((resolve) => setTimeout(resolve, 150));
    d.onTurnStart("real-b5");
    await expect(pending).resolves.toBe(true);
    const payload = writes
      .filter((w) => w.bindingId === "real-b5")
      .map((w) => w.data)
      .join("");
    expect(payload).toContain("megaphone");
  });
});
