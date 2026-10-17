/**
 * The harness version a seat says: read from its own machine's inventory,
 * one answer per machine, asked again at most once a minute.
 */
import { Result } from "effect";
import { afterEach, describe, expect, it } from "vitest";
import { InventoryUnavailableError, type MachineInventory } from "../src/shared/harness-domain";
import {
  ASK_AGAIN_AFTER_MS,
  askHarnessVerification,
  harnessVerification$,
  harnessVersionNote,
  resetHarnessVerification,
} from "../src/renderer/lib/harness-verification";
import {
  coreHarnessMachineSource,
  pendingHarnessMachineSource,
  setHarnessMachineSource,
} from "../src/renderer/lib/harness-machine-source";

const row = (harness: string, extra: Record<string, unknown>) => ({
  harness, machine: "studio", installed: true, models: [], efforts: [], refreshing: false, ...extra,
});

const inventory = (machine: string): MachineInventory =>
  ({
    machine,
    harnesses: [
      row("claude", { version: "2.4.1", verification: { verdict: "newer", from: "2.0.0", through: "2.1.0" } }),
      row("codex", { version: "0.46.0", verification: { verdict: "verified", from: "0.40.0", through: "0.50.0" } }),
      row("grok", { installed: false }),
    ],
  }) as unknown as MachineInventory;

const settle = () => new Promise((resolve) => setTimeout(resolve, 0));

describe("harness version note", () => {
  it("says nothing for a verified version, and what was tested otherwise", () => {
    const at = (verdict: "verified" | "newer" | "older" | "unknown", version?: string) =>
      harnessVersionNote({ verification: { verdict, from: "2026.09.01", through: "2026.10.01" }, ...(version ? { version } : {}) });
    expect(at("verified", "2026.09.15")).toBeUndefined();
    expect(at("newer", "2026.10.14")).toEqual({
      label: "unverified",
      title: "Newer than tested (verified through 2026.10.01). This machine has 2026.10.14. It still launches.",
    });
    expect(at("older", "2026.08.01")?.title).toBe(
      "Older than tested (verified from 2026.09.01). This machine has 2026.08.01. It still launches.",
    );
    expect(at("unknown")?.title).toBe("Version not read (verified 2026.09.01 through 2026.10.01). It still launches.");
    expect(harnessVersionNote(undefined)).toBeUndefined();
  });
});

describe("harness verification store", () => {
  afterEach(() => {
    resetHarnessVerification();
    setHarnessMachineSource(coreHarnessMachineSource);
  });

  it("keeps each installed harness's verdict per machine, asks once a minute, and keeps an answer through a refusal", async () => {
    const asked: string[] = [];
    let refuse = false;
    setHarnessMachineSource({
      ...pendingHarnessMachineSource,
      inventory: async (machine) => {
        asked.push(machine);
        return refuse
          ? Result.fail(new InventoryUnavailableError({ machine, reason: "unreachable", message: "no link" }))
          : Result.succeed(inventory(machine));
      },
    });

    askHarnessVerification("studio", 0);
    askHarnessVerification("studio", ASK_AGAIN_AFTER_MS - 1);
    await settle();
    expect(asked).toEqual(["studio"]);
    expect(harnessVerification$.studio.peek()).toEqual({
      claude: { verification: { verdict: "newer", from: "2.0.0", through: "2.1.0" }, version: "2.4.1" },
      codex: { verification: { verdict: "verified", from: "0.40.0", through: "0.50.0" }, version: "0.46.0" },
    });

    refuse = true;
    askHarnessVerification("studio", ASK_AGAIN_AFTER_MS);
    askHarnessVerification("atlas", ASK_AGAIN_AFTER_MS);
    await settle();
    expect(asked).toEqual(["studio", "studio", "atlas"]);
    expect(harnessVerification$.studio.claude.verification.verdict.peek()).toBe("newer");
    expect(harnessVerification$.atlas.peek()).toBeUndefined();
  });
});
