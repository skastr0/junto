import { Schema } from "effect";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  CR,
  MAIL_DRAFT_RECHECK_MS,
  ManagedTerminalDrive,
  encodeBracketedPaste,
} from "../src/main/junto/term/drive";
import {
  admitMail,
  MAIL_MODE_ASKED,
  mailModeFor,
  mailSubmits,
  type MailAdmission,
} from "../src/main/junto/term/drive/mail-admission";
import {
  COMMAND_CAPABILITIES,
  HARNESS_SIGNAL_KINDS,
  initialSnapshot,
  NO_COMMAND,
  NO_SIGNAL,
  type CommandCapability,
  type CommandSupport,
  type HarnessCapabilities,
  type SeatSnapshot,
  type SeatStatus,
} from "../src/shared/harness-domain";
import { HARNESS_CAPABILITIES } from "../src/shared/harness-capabilities";
import {
  HARNESS_FOLLOW_UP,
  HARNESS_IDS,
  mailSteeringSubmits,
} from "../src/shared/managed-terminal-templates";
import { BindingId } from "../src/shared/terminal-session-domain";

const seat = Schema.decodeSync(BindingId)("b1");
const TYPED: CommandSupport = { level: "typed", channel: "pty" };

const capabilities = (
  commands: Partial<Record<CommandCapability, CommandSupport>> = { mailSteer: TYPED },
): HarnessCapabilities => ({
  signals: Object.fromEntries(HARNESS_SIGNAL_KINDS.map((kind) => [kind, NO_SIGNAL])) as HarnessCapabilities["signals"],
  commands: {
    ...(Object.fromEntries(COMMAND_CAPABILITIES.map((key) => [key, NO_COMMAND])) as HarnessCapabilities["commands"]),
    ...commands,
  },
});

const snapshotOf = (status: SeatStatus): SeatSnapshot => ({ ...initialSnapshot(seat, 1_000), status });

describe("admitMail", () => {
  it("asks for steer, the mode mail follows up in", () => {
    expect(MAIL_MODE_ASKED).toBe("steer");
  });

  it("gives no verdict without a snapshot or without capabilities", () => {
    expect(admitMail(undefined, capabilities())).toBeUndefined();
    expect(admitMail(snapshotOf({ _tag: "Idle" }), undefined)).toBeUndefined();
  });

  it("admits a seat of unknown status, leaving the hold to its composer as before", () => {
    expect(admitMail(snapshotOf({ _tag: "Unknown" }), capabilities())).toEqual({
      _tag: "Admitted",
      support: TYPED,
      mode: "steer",
    });
  });

  it("holds a starting seat as busy", () => {
    expect(admitMail(snapshotOf({ _tag: "Starting" }), capabilities())).toEqual({
      _tag: "Held",
      reason: "busy",
    });
  });

  it("admits an idle seat, and a working one through typed steering", () => {
    const admitted = { _tag: "Admitted", support: TYPED, mode: "steer" };
    expect(admitMail(snapshotOf({ _tag: "Idle" }), capabilities())).toEqual(admitted);
    for (const phase of ["thinking", "tool"] as const) {
      expect(admitMail(snapshotOf({ _tag: "Working", phase }), capabilities())).toEqual(admitted);
    }
  });

  it("queues into a working seat whose harness declares a queue but no steering", () => {
    const queueOnly = capabilities({ mailQueue: TYPED });
    expect(mailModeFor(queueOnly)).toBe("queue");
    expect(admitMail(snapshotOf({ _tag: "Working", phase: "thinking" }), queueOnly)).toEqual({
      _tag: "Admitted",
      support: TYPED,
      mode: "queue",
    });
  });

  it("holds a working seat whose harness declares neither, and lets it in once idle", () => {
    const interruptOnly = capabilities({ mailInterrupt: TYPED });
    expect(admitMail(snapshotOf({ _tag: "Working", phase: "thinking" }), interruptOnly)).toEqual({
      _tag: "Held",
      reason: "unsupported",
    });
    expect(admitMail(snapshotOf({ _tag: "Idle" }), interruptOnly)?._tag).toBe("Admitted");
  });

  it("holds a seat that compacts or retries as busy", () => {
    for (const phase of ["compacting", "retrying"] as const) {
      expect(admitMail(snapshotOf({ _tag: "Working", phase }), capabilities())).toEqual({
        _tag: "Held",
        reason: "busy",
      });
    }
  });

  it("holds a blocked seat: a dialog for the operator's questions, stopped for a limit or an error", () => {
    const held = (status: SeatStatus) => admitMail(snapshotOf(status), capabilities());
    for (const reason of [
      { _tag: "Permission" },
      { _tag: "Question" },
      { _tag: "Dialog", kind: "trust" },
    ] as const) {
      expect(held({ _tag: "Blocked", reason })).toEqual({ _tag: "Held", reason: "dialog" });
    }
    expect(held({ _tag: "Blocked", reason: { _tag: "UsageLimit", scope: "5h" } })).toEqual({
      _tag: "Held",
      reason: "stopped",
    });
    expect(
      held({ _tag: "Blocked", reason: { _tag: "Error", kind: "auth", message: "expired" } }),
    ).toEqual({ _tag: "Held", reason: "stopped" });
  });

  it("calls an exited seat lost", () => {
    expect(admitMail(snapshotOf({ _tag: "Exited", expected: false }), capabilities())).toEqual({
      _tag: "Lost",
    });
  });
});

describe("admitMail on the declared harness records", () => {
  it("picks the same Enters for every harness as before the records, idle and mid-turn", () => {
    for (const harness of HARNESS_IDS) {
      const declared = HARNESS_CAPABILITIES[harness];
      for (const [status, idle] of [
        [{ _tag: "Idle" }, true],
        [{ _tag: "Working", phase: "thinking" }, false],
        [{ _tag: "Unknown" }, false],
      ] as const) {
        const admission = admitMail(snapshotOf(status), declared);
        if (admission?._tag !== "Admitted") throw new Error(`${harness} ${status._tag} not admitted`);
        expect(admission.mode, harness).toBe(mailModeFor(declared));
        expect(mailSubmits(harness, admission.mode, idle), `${harness} ${status._tag}`).toBe(
          mailSteeringSubmits(harness, idle),
        );
      }
    }
  });

  it("gives a queue its own submit where the harness has one, and the steering key where not", () => {
    expect(mailSubmits("devin", "queue", false)).toBe(1);
    expect(mailSubmits("cursor", "queue", false)).toBe(1);
    expect(mailSubmits("devin", "steer", false)).toBe(2);
    expect(mailSubmits("claude", "queue", false)).toBe(1);
    expect(mailSubmits("devin", "steer", true)).toBe(1);
    expect(mailSubmits(undefined, "steer", false)).toBe(1);
  });

  it("admits mail into every harness idle and mid-turn, as delivery types it today", () => {
    for (const [harness, declared] of Object.entries(HARNESS_CAPABILITIES)) {
      expect(HARNESS_FOLLOW_UP[harness as keyof typeof HARNESS_FOLLOW_UP].steering.mode, harness).toBe("steering");
      for (const status of [
        { _tag: "Idle" },
        { _tag: "Unknown" },
        { _tag: "Working", phase: "thinking" },
        { _tag: "Working", phase: "tool" },
      ] as const) {
        expect(admitMail(snapshotOf(status), declared)?._tag, `${harness} ${status._tag}`).toBe("Admitted");
      }
    }
  });
});

describe("ManagedTerminalDrive mail admission", () => {
  const writes: string[] = [];
  let drive: ManagedTerminalDrive;
  const makeDrive = (
    admission: () => MailAdmission | undefined,
    over: Partial<ConstructorParameters<typeof ManagedTerminalDrive>[0]> = {},
  ) =>
    new ManagedTerminalDrive({
      write: (_bindingId, data) => {
        writes.push(data);
        return true;
      },
      isSeatIdle: () => true,
      now: () => 10_000,
      stallWatch: false,
      pasteToCrSettleMs: 0,
      mailUnreadableGraceMs: 0,
      composerVerdict: () => "empty",
      mailAdmission: admission,
      ...over,
    });

  afterEach(() => {
    drive?.resetForTest();
    writes.length = 0;
    vi.useRealTimers();
  });

  it("types as before when admission gives no verdict", async () => {
    drive = makeDrive(() => undefined);
    await expect(drive.writeMail("b1", "mail")).resolves.toBe("written");
    expect(writes).toEqual([encodeBracketedPaste("mail"), CR]);
  });

  it("holds on the seat's status over an empty box, and frees the mail when the status lets it in", async () => {
    vi.useFakeTimers();
    let verdict: MailAdmission = { _tag: "Held", reason: "busy" };
    drive = makeDrive(() => verdict);
    const writable: string[] = [];
    drive.subscribeMailWritable((bindingId) => writable.push(bindingId));
    await expect(drive.writeMail("b1", "mail")).resolves.toBe("busy");
    await expect(drive.writeMail("b1", "next")).resolves.toBe("busy");
    await vi.advanceTimersByTimeAsync(MAIL_DRAFT_RECHECK_MS * 4);
    expect(writes).toEqual([]);
    expect(writable).toEqual([]);
    verdict = { _tag: "Admitted", support: TYPED, mode: "steer" };
    await vi.advanceTimersByTimeAsync(MAIL_DRAFT_RECHECK_MS);
    expect(writable).toEqual(["b1"]);
    await expect(drive.writeMail("b1", "mail")).resolves.toBe("written");
  });

  it("still holds an admitted seat on its composer", async () => {
    vi.useFakeTimers();
    drive = makeDrive(() => ({ _tag: "Admitted", support: TYPED, mode: "steer" }), {
      composerVerdict: () => null,
    });
    await expect(drive.writeMail("b1", "mail")).resolves.toBe("unreadable");
    expect(writes).toEqual([]);
  });

  it("types the declared mode's Enters into a running turn", async () => {
    for (const [mode, expected] of [
      ["steer", [encodeBracketedPaste("mail"), CR, CR]],
      ["queue", [encodeBracketedPaste("mail"), CR]],
    ] as const) {
      drive?.resetForTest();
      writes.length = 0;
      drive = makeDrive(() => ({ _tag: "Admitted", support: TYPED, mode }), {
        isSeatIdle: () => false,
        harnessFor: () => "devin",
      });
      await expect(drive.writeMail("b1", "mail")).resolves.toBe("written");
      expect(writes, mode).toEqual(expected);
    }
  });

  it("writes nothing into an exited seat", async () => {
    drive = makeDrive(() => ({ _tag: "Lost" }));
    await expect(drive.writeMail("b1", "mail")).resolves.toBe("lost");
    expect(writes).toEqual([]);
  });
});
