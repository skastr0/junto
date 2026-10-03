/**
 * Mail never types over the operator's draft.
 *
 * Full loop: scripted Claude TUI bytes → REAL SessionObserver → REAL
 * SeatStateRuntime composer probes → REAL ManagedTerminalDrive.writeMail.
 * The operator's draft is put on the composer the way the terminal does it
 * (bytes to the PTY, stamped on the operator interlock first), so the drive
 * sees only what production sees: the latch and the painted grid.
 */
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  BRACKETED_PASTE_END,
  BRACKETED_PASTE_START,
  CR,
  MAIL_DRAFT_RECHECK_MS,
  OPERATOR_INPUT_LATCH_MS,
  OperatorInterlock,
} from "../../../src/main/junto/term/drive";
import { DriveLoop } from "../scripted-tui";

const BINDING = "seat-b1";

const setup = () => {
  vi.useFakeTimers({ now: 1_000_000 });
  const operatorInput = new OperatorInterlock(() => Date.now());
  // The loop is built first so the drive's composer lookup can read its runtime.
  const holder: { loop?: DriveLoop } = {};
  const loop = new DriveLoop({
    now: () => Date.now(),
    stallTimeoutMs: 5_000,
    pasteToCrSettleMs: 40,
    drive: {
      operatorInput,
      composerVerdict: (bindingId) =>
        holder.loop?.runtime.composerVerdict(bindingId) ?? null,
    },
  });
  holder.loop = loop;
  const flush = async () => {
    await vi.advanceTimersByTimeAsync(1);
    await vi.advanceTimersByTimeAsync(1);
    for (let i = 0; i < 6; i += 1) await Promise.resolve();
  };
  /** Operator bytes, as LocalSessionHost.write sends them. */
  const operatorTypes = (data: string) => {
    operatorInput.noteInput(BINDING);
    loop.tui.write(data);
  };
  return { loop, flush, operatorTypes };
};

const labels = (loop: DriveLoop) => loop.writes.map((w) => loop.labelWrite(w.data));

afterEach(() => {
  vi.useRealTimers();
});

describe("mail and the operator's draft (Claude)", () => {
  it("holds mail while a draft is on the composer, then types it once the operator submits", async () => {
    const { loop, flush, operatorTypes } = setup();
    await flush();
    expect(loop.runtime.composerVerdict(BINDING)).toBe("empty");

    operatorTypes(`${BRACKETED_PASTE_START}half a thought${BRACKETED_PASTE_END}`);
    await flush();
    // Long after the keystroke latch: only the painted draft holds the mail.
    await vi.advanceTimersByTimeAsync(OPERATOR_INPUT_LATCH_MS * 5);
    expect(loop.runtime.composerVerdict(BINDING)).toBe("draft");

    const writable: string[] = [];
    loop.drive.subscribeMailWritable((bindingId) => writable.push(bindingId));
    await expect(loop.drive.writeMail(BINDING, "mail from A")).resolves.toBe("held");
    await vi.advanceTimersByTimeAsync(MAIL_DRAFT_RECHECK_MS * 20);
    await flush();
    // Nothing typed, and the draft was not submitted.
    expect(loop.writes).toEqual([]);
    expect(loop.tui.getPhase()).toBe("idle");
    expect(writable).toEqual([]);

    operatorTypes(CR);
    await flush();
    expect(loop.tui.getPhase()).toBe("working");
    await vi.advanceTimersByTimeAsync(OPERATOR_INPUT_LATCH_MS + MAIL_DRAFT_RECHECK_MS);
    await flush();
    expect(writable).toEqual([BINDING]);

    // The seat is mid-turn; mail types into it anyway, as before.
    const mail = loop.drive.writeMail(BINDING, "mail from A");
    await vi.advanceTimersByTimeAsync(200);
    await flush();
    await expect(mail).resolves.toBe("written");
    expect(labels(loop)).toEqual(["paste", "cr"]);
    loop.dispose();
  });

  it("types mail at once into an empty composer the operator is not touching", async () => {
    const { loop, flush } = setup();
    await flush();
    const mail = loop.drive.writeMail(BINDING, "mail from A");
    await vi.advanceTimersByTimeAsync(200);
    await flush();
    await expect(mail).resolves.toBe("written");
    expect(labels(loop)).toEqual(["paste", "cr"]);
    loop.dispose();
  });
});
