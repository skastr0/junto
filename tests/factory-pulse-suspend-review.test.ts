/**
 * Independent review coverage (p15) for 3b744c2c: the kernel pulse slot on
 * the REAL managed-pulse bridge. Confirms the concrete-closure registration
 * cannot self-recurse, that repeated pulses each reach the drive exactly
 * once, and that the suspension gate (setManagedPulseDeliver(undefined))
 * stops delivery at the dispatcher. Suspension is monotonic — there is no
 * resume re-registration path (verified: the only callers are boot and the
 * suspend/shutdown cut), so the gate cannot re-introduce the wrapper trap.
 */
import { afterEach, describe, expect, it } from "vitest";
import type { WritePromptOptions } from "../src/main/vellum-command/term/drive";
import { factoryPulseTransport } from "../src/main/vellum-command/term/factory-delivery-composition";
import {
  managedPulseDeliver,
  setManagedPulseDeliver,
} from "../src/main/vellum-command/term/managed-pulse-bridge";

type FakeDrive = {
  writes: Array<{ bindingId: string; text: string }>;
  writePrompt: (b: string, t: string, o: WritePromptOptions) => Promise<boolean>;
  pasteWriteCount: (b: string) => number;
};

const fakeDrive = (): FakeDrive => {
  const writes: Array<{ bindingId: string; text: string }> = [];
  return {
    writes,
    writePrompt: (bindingId, text) => {
      writes.push({ bindingId, text });
      return Promise.resolve(true);
    },
    pasteWriteCount: () => 0,
  };
};

afterEach(() => setManagedPulseDeliver(undefined));

describe("managed pulse registration and suspend gate (real bridge)", () => {
  it("the boot registration order delivers each pulse once and never recurses", async () => {
    const drive = fakeDrive();
    // 1. factory registers the concrete closure on the real bridge.
    const concrete = factoryPulseTransport({
      pulse: { setDeliver: setManagedPulseDeliver },
      drive,
      driveReady: () => true,
    });
    // 2. ipc's suspension-conditional registration wraps THAT closure.
    const suspended = false;
    setManagedPulseDeliver(
      suspended ? undefined : (bindingId, text) => concrete(bindingId, text),
    );
    // 3. Several kernel pulses through the global dispatcher.
    for (let i = 0; i < 3; i++) {
      const ok = await managedPulseDeliver("b1", `pulse ${String(i)}`);
      expect(ok).toBe(true);
    }
    // Each pulse reached the drive exactly once — no wrapper self-recursion
    // (that path threw RangeError with zero writes on the pre-fix wiring).
    expect(drive.writes).toHaveLength(3);
    expect(drive.writes.map((w) => w.text)).toEqual([
      "pulse 0",
      "pulse 1",
      "pulse 2",
    ]);
  });

  it("suspension unregisters the dispatcher: later pulses never reach the drive", async () => {
    const drive = fakeDrive();
    const concrete = factoryPulseTransport({
      pulse: { setDeliver: setManagedPulseDeliver },
      drive,
      driveReady: () => true,
    });
    setManagedPulseDeliver((bindingId, text) => concrete(bindingId, text));
    expect(await managedPulseDeliver("b1", "before")).toBe(true);

    // productAutomationSuspension.suspend() / Remote shutdown does this.
    setManagedPulseDeliver(undefined);
    expect(await managedPulseDeliver("b1", "after")).toBe(false);
    expect(drive.writes.map((w) => w.text)).toEqual(["before"]);
  });

  it("a suspended-at-boot registration delivers nothing until re-registered", async () => {
    const drive = fakeDrive();
    const concrete = factoryPulseTransport({
      pulse: { setDeliver: setManagedPulseDeliver },
      drive,
      driveReady: () => true,
    });
    // Booting while already suspended registers the undefined gate.
    const suspended = true;
    setManagedPulseDeliver(
      suspended ? undefined : (bindingId, text) => concrete(bindingId, text),
    );
    expect(await managedPulseDeliver("b1", "gated")).toBe(false);
    expect(drive.writes).toHaveLength(0);
  });
});
