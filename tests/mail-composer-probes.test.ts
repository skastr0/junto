/**
 * Mail and harnesses Junto cannot read at all.
 *
 * "Junto cannot read this seat's input box" must mean probes exist and did
 * not match. A harness with no composer probes can never read as empty, so
 * holding its mail on an unread box would hold it forever. Built through the
 * shared drive factory, the way the app and the Remote build their drive.
 */
import { afterEach, describe, expect, it } from "vitest";
import { CR, encodeBracketedPaste } from "../src/main/junto/term/drive";
import { createManagedTerminalDrive } from "../src/main/junto/term/drive/managed-drive-factory";
import { harnessHasComposerProbes } from "../src/main/junto/term/agent-state/composer";
import { HARNESS_IDS } from "../src/shared/managed-terminal-templates";
import type { AgentSeatState } from "../src/shared/agent-seat-state";

const UNPROBED = HARNESS_IDS.filter((harness) => !harnessHasComposerProbes(harness));

const drives: Array<{ resetForTest: () => void }> = [];
afterEach(() => {
  for (const drive of drives.splice(0)) drive.resetForTest();
});

/** A drive for one seat of `harness` whose screen matches no probe. */
const rig = (harness: string | undefined, state: AgentSeatState) => {
  const writes: string[] = [];
  const drive = createManagedTerminalDrive({
    write: (_bindingId, data) => {
      writes.push(data);
      return true;
    },
    isSeatIdle: () => state === "idle",
    seatState: () => state,
    onAttention: () => undefined,
    snapshot: () => ({ text: "", lines: [] }),
    composerVerdict: () => null,
    harnessFor: () => harness,
  });
  drives.push(drive);
  return { drive, writes };
};

describe("harnesses with no composer probes", () => {
  it("are exactly these", () => {
    expect(UNPROBED).toEqual(["junto-overseer"]);
    expect(harnessHasComposerProbes(undefined)).toBe(false);
    expect(harnessHasComposerProbes("some-future-harness")).toBe(false);
  });

  for (const harness of [...UNPROBED, "some-future-harness", undefined]) {
    it(`${harness ?? "a seat with no harness"}: mail is typed, idle or mid-turn`, async () => {
      for (const state of ["idle", "working"] as const) {
        const { drive, writes } = rig(harness, state);
        await expect(drive.writeMail("b1", "mail")).resolves.toBe("written");
        expect(writes.slice(0, 1)).toEqual([encodeBracketedPaste("mail")]);
        expect(writes).toContain(CR);
      }
    });

    it(`${harness ?? "a seat with no harness"}: mail is never typed while the seat asks for attention`, async () => {
      const { drive, writes } = rig(harness, "attention");
      await expect(drive.writeMail("b1", "mail")).resolves.toBe("dialog");
      expect(writes).toEqual([]);
    });
  }
});

describe("harnesses with composer probes", () => {
  it("hold mail on an unread box", async () => {
    const probed = HARNESS_IDS.filter((id) => harnessHasComposerProbes(id));
    // Each waits out the grace for an unread box; run them side by side.
    const outcomes = await Promise.all(
      probed.map(async (harness) => {
        const { drive, writes } = rig(harness, "idle");
        return { harness, outcome: await drive.writeMail("b1", "mail"), writes };
      }),
    );
    for (const { harness, outcome, writes } of outcomes) {
      expect(outcome, harness).toBe("unreadable");
      expect(writes, harness).toEqual([]);
    }
  }, 30_000);
});
