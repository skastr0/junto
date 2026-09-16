import { createHash } from "node:crypto";
import { chmodSync, existsSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { __resetVellumCommandHomeCache } from "../src/shared/vellum-home";
import { CR, ManagedTerminalDrive, OperatorInterlock, encodeBracketedPaste } from "../src/main/vellum-command/term/drive";
import type { ManagedPromptOutcome } from "../src/shared/managed-prompt";
import {
  createPtyDeliveryTracer,
  makePtyDeliveryTraceJournal,
  ptyDeliveryTracePath,
  type PtyDeliveryTraceEvent,
  type PtyDeliveryTraceSink,
} from "../src/main/vellum-command/term/drive/pty-delivery-trace";

const digest = (text: string): string => createHash("sha256").update(text).digest("hex");
const submittedOutcome = (writesBefore = 0): ManagedPromptOutcome => ({
  status: "submitted", bindingGeneration: 0,
  writesBefore, writesAfter: writesBefore + 1, pasteWrites: 1, wrotePhysicalBytes: true,
});
const microtasks = async (): Promise<void> => {
  for (let i = 0; i < 30; i += 1) await Promise.resolve();
};

describe("PTY delivery trace", () => {
  const roots: string[] = [];
  const drives: ManagedTerminalDrive[] = [];
  const freshRoot = (): string => {
    const root = mkdtempSync(join(tmpdir(), "vellum-command-pty-trace-"));
    roots.push(root);
    return root;
  };
  const makeDrive = (
    options: Partial<ConstructorParameters<typeof ManagedTerminalDrive>[0]> = {},
  ): ManagedTerminalDrive => {
    const drive = new ManagedTerminalDrive({
      // The trace fixture's default transport acknowledges a submitted turn.
      write: (bindingId, data) => {
        if (data === CR) drive.onTurnStart(bindingId);
        return true;
      },
      isSeatIdle: () => true,
      harnessFor: () => "devin",
      pasteToCrSettleMs: 0,
      stallWatch: false,
      operatorInput: new OperatorInterlock(),
      ...options,
    });
    drives.push(drive);
    return drive;
  };

  afterEach(() => {
    for (const drive of drives.splice(0)) drive.resetForTest();
    vi.unstubAllEnvs();
    __resetVellumCommandHomeCache();
    for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
  });

  it("records prompt length and digest without prompt or held operator bytes", async () => {
    const events: PtyDeliveryTraceEvent[] = [];
    const prompt = "private task: investigate token SECRET-QA-184";
    const operatorBytes = "private operator draft SECRET-KEYS-527";
    const interlock = new OperatorInterlock();
    const writes: string[] = [];
    const drive = makeDrive({
      onTrace: (event) => events.push(event),
      operatorInput: interlock,
      write: (bindingId, data) => {
        writes.push(data);
        if (data === encodeBracketedPaste(prompt)) {
          expect(interlock.holdWrite(bindingId, { replay: () => writes.push(operatorBytes) })).toBe(true);
        }
        if (data === CR) drive.onTurnStart(bindingId);
        return true;
      },
    });

    expect(await drive.writePrompt("binding-1", prompt)).toEqual(submittedOutcome());
    expect(writes).toEqual([encodeBracketedPaste(prompt), CR, operatorBytes]);
    expect(events.find((event) => event.event === "delivery.begin")).toMatchObject({
      bindingId: "binding-1",
      harness: "devin",
      fields: { textLength: prompt.length, textSha256: digest(prompt) },
    });
    expect(events.find((event) => event.event === "delivery.end")?.fields).toEqual({ ok: true });
    const serialized = JSON.stringify(events);
    for (const secret of [prompt, "SECRET-QA-184", operatorBytes, "SECRET-KEYS-527"]) {
      expect(serialized).not.toContain(secret);
    }
  });

  it("keeps queued prompts and external turn acknowledgements on their own delivery IDs", async () => {
    const events: PtyDeliveryTraceEvent[] = [];
    const writes: string[] = [];
    let idle = false;
    const drive = makeDrive({
      onTrace: (event) => events.push(event),
      write: (_bindingId, data) => { writes.push(data); return true; },
      isSeatIdle: () => idle,
      stallWatch: true,
    });
    const first = drive.writePrompt("binding-1", "first queued prompt");
    const second = drive.writePrompt("binding-1", "second queued prompt");
    const starts = events.filter((event) => event.event === "delivery.begin");
    expect(starts).toHaveLength(2);
    const firstId = starts[0]!.deliveryId;
    const secondId = starts[1]!.deliveryId;
    expect(firstId).toEqual(expect.any(String));
    expect(secondId).toEqual(expect.any(String));
    expect(firstId).not.toBe(secondId);
    expect(writes).toEqual([]);

    idle = true;
    drive.onSeatIdle("binding-1");
    await microtasks();
    expect(writes).toEqual([encodeBracketedPaste("first queued prompt"), CR]);
    drive.onTurnStart("binding-1");
    expect(await first).toEqual(submittedOutcome());
    expect(drive.queuedCount("binding-1")).toBe(1);
    expect(events.filter((event) => event.event === "delivery.end").map((event) => event.deliveryId)).toEqual([firstId]);

    drive.onSeatIdle("binding-1");
    await microtasks();
    drive.onTurnStart("binding-1");
    expect(await second).toEqual(submittedOutcome(1));
    expect(writes).toEqual([
      encodeBracketedPaste("first queued prompt"), CR,
      encodeBracketedPaste("second queued prompt"), CR,
    ]);
    const writeStarts = events.filter((event) => event.event === "write.begin");
    const writeEnds = events.filter((event) => event.event === "write.end");
    expect(writeStarts.map((event) => event.deliveryId)).toEqual([firstId, firstId, secondId, secondId]);
    expect(writeEnds.map((event) => event.deliveryId)).toEqual([firstId, firstId, secondId, secondId]);
    expect(writeEnds.map(({ fields: { stage, ok } }) => ({ stage, ok }))).toEqual([
      { stage: "paste", ok: true }, { stage: "submit-cr", ok: true },
      { stage: "paste", ok: true }, { stage: "submit-cr", ok: true },
    ]);
    expect(events.filter((event) => event.event === "turn.start").map((event) => event.deliveryId)).toEqual([firstId, secondId]);
    expect(events.filter((event) => event.event === "turn.start.accepted").map((event) => event.deliveryId)).toEqual([firstId, secondId]);
    expect(events.filter((event) => event.event === "delivery.end").map((event) => [event.deliveryId, event.fields.ok])).toEqual([
      [firstId, true], [secondId, true],
    ]);
  });

  it.each([true, false])("a throwing sink preserves physical writes and result when accepted=%s", async (accepted) => {
    vi.stubEnv("VELLUM_COMMAND_PTY_TRACE", "0");
    const run = async (onTrace?: PtyDeliveryTraceSink) => {
      const writes: string[] = [];
      const drive = makeDrive({
        onTrace,
        write: (bindingId, data) => {
          writes.push(data);
          if (accepted && data === CR) drive.onTurnStart(bindingId);
          return accepted;
        },
      });
      const outcome = await drive.writePrompt("binding-1", "same delivery");
      return { writes, outcome };
    };
    const baseline = await run();
    let observed = 0;
    const traced = await run(() => { observed += 1; throw new Error("broken diagnostic sink"); });
    expect(observed).toBeGreaterThan(0);
    expect(traced).toEqual(baseline);
    expect(traced.outcome).toEqual(accepted ? submittedOutcome() : {
      status: "refused", reason: "not-ready", bindingGeneration: 0,
      writesBefore: 0, writesAfter: 0, pasteWrites: 0, wrotePhysicalBytes: false,
    });
    expect(traced.writes).toEqual(accepted ? [encodeBracketedPaste("same delivery"), CR] : [encodeBracketedPaste("same delivery")]);
  });

  it("names the composer gate that refused delivery without writing bytes", async () => {
    const events: PtyDeliveryTraceEvent[] = [];
    const write = vi.fn(() => true);
    const drive = makeDrive({
      onTrace: (event) => events.push(event),
      write,
      composerVerdict: () => "draft",
    });
    expect(await drive.writePrompt("binding-1", "blocked delivery", { queueIfBusy: false })).toEqual({
      status: "refused", reason: "composer-not-empty", bindingGeneration: 0,
      writesBefore: 0, writesAfter: 0, pasteWrites: 0, wrotePhysicalBytes: false,
    });
    expect(write).not.toHaveBeenCalled();
    expect(events).toContainEqual(expect.objectContaining({ event: "evidence", fields: { probe: "composer", value: "draft" } }));
    expect(events).toContainEqual(expect.objectContaining({ event: "gate", fields: expect.objectContaining({ gate: "must-wait", waiting: true }) }));
    expect(events).toContainEqual(expect.objectContaining({ event: "delivery.end", fields: { ok: false } }));
  });

  it("records pending-text refusal before accepting a later turn acknowledgement", async () => {
    const events: PtyDeliveryTraceEvent[] = [];
    let pending = true;
    const drive = makeDrive({
      onTrace: (event) => events.push(event),
      stallWatch: true,
      pendingText: () => pending,
    });
    const delivery = drive.writePrompt("binding-1", "pending prompt");
    await microtasks();
    drive.onTurnStart("binding-1");
    expect(events).toContainEqual(expect.objectContaining({ event: "evidence", fields: { probe: "pending-text", value: true } }));
    expect(events).toContainEqual(expect.objectContaining({ event: "turn.start.refused", fields: expect.objectContaining({ reason: "text-pending" }) }));
    expect(events.filter((event) => event.event === "delivery.end")).toEqual([]);
    pending = false;
    drive.onTurnStart("binding-1");
    expect(await delivery).toEqual(submittedOutcome());
    expect(events).toContainEqual(expect.objectContaining({ event: "evidence", fields: { probe: "pending-text", value: false } }));
    expect(events).toContainEqual(expect.objectContaining({ event: "turn.start.accepted" }));
  });

  it("bounds its pending journal, reports dropped rows, and flushes owner-only files", () => {
    const root = freshRoot();
    chmodSync(root, 0o750);
    const path = join(root, "logs", "pty-delivery.jsonl");
    const journal = makePtyDeliveryTraceJournal(path);
    const event: PtyDeliveryTraceEvent = {
      ts: "2026-09-13T00:00:00.000Z",
      bindingId: "binding-1",
      deliveryId: "delivery-1",
      harness: "devin",
      event: "write.end",
      fields: { stage: "paste", ok: true },
    };
    for (let i = 0; i < 2_051; i += 1) journal.append(event);
    expect(existsSync(path)).toBe(false);
    journal.flush();
    expect(readFileSync(path, "utf8").trim().split("\n")).toHaveLength(2_048);
    journal.append(event);
    journal.flush();
    const rows = readFileSync(path, "utf8").trim().split("\n").map((line) => JSON.parse(line));
    expect(rows).toHaveLength(2_049);
    expect(rows.at(-1)).toEqual({ ...event, dropped: 3 });
    expect(statSync(path).mode & 0o777).toBe(0o600);
    expect(statSync(join(root, "logs")).mode & 0o777).toBe(0o700);
    expect(statSync(root).mode & 0o777).toBe(0o750);

    writeFileSync(path, Buffer.alloc(8 * 1024 * 1024, 0x61));
    journal.append(event);
    journal.flush();
    expect(statSync(`${path}.1`).size).toBe(8 * 1024 * 1024);
    expect(statSync(`${path}.1`).mode & 0o777).toBe(0o600);
    expect(readFileSync(path, "utf8")).toBe(`${JSON.stringify(event)}\n`);
  });

  it.each([undefined, "0"])("creates no journal when the trace setting is %s", async (setting) => {
    const root = freshRoot();
    vi.stubEnv("VELLUM_COMMAND_HOME", root);
    vi.stubEnv("VELLUM_COMMAND_PTY_TRACE", setting);
    __resetVellumCommandHomeCache();
    expect(createPtyDeliveryTracer()).toBeUndefined();
    expect(await makeDrive().writePrompt("binding-1", "ordinary delivery")).toEqual(submittedOutcome());
    expect(existsSync(ptyDeliveryTracePath())).toBe(false);
  });

  it("enables the actual default sink only in the configured installation home", async () => {
    const root = freshRoot();
    vi.stubEnv("VELLUM_COMMAND_HOME", root);
    vi.stubEnv("VELLUM_COMMAND_PTY_TRACE", "1");
    __resetVellumCommandHomeCache();
    expect(await makeDrive().writePrompt("binding-1", "private opt-in prompt")).toEqual(submittedOutcome());
    await new Promise<void>((resolve) => setTimeout(resolve, 50));
    const path = join(root, ".vellum-command", "logs", "pty-delivery.jsonl");
    expect(ptyDeliveryTracePath()).toBe(path);
    const text = readFileSync(path, "utf8");
    expect(text).toContain('"event":"delivery.end","fields":{"ok":true}');
    expect(text).not.toContain("private opt-in prompt");
    expect(statSync(path).mode & 0o777).toBe(0o600);
  });
});
