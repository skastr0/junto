/** Actual generated fake PTYs, not native provider or Electron qualification. */
import { createHash } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawn } from "node-pty";
import { expect, it } from "vitest";
import { CrewSeat, installCrewSeatHarness } from "../e2e/harness/crew-fixture";
import type { Sandbox } from "../e2e/harness/sandbox";
import { SeatStateRuntime } from "../src/main/vellum-command/term/agent-state/runtime";
import { createManagedTerminalDrive } from "../src/main/vellum-command/term/drive/managed-drive-factory";
import { promptStillPending } from "../src/main/vellum-command/term/drive/prompt-evidence";
import { isManagedTerminalReady } from "../src/main/vellum-command/term/drive/readiness";
import { SessionObserver } from "../src/main/vellum-command/term/observer";
import type { ObserverGridSnapshot } from "../src/main/vellum-command/term/observer/types";

const bindingId = "crew-control-probe";
const delay = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));
const bracket = (text: string) => `\x1b[200~${text}\x1b[201~`;

const launch = async () => {
  const root = await mkdtemp(join(tmpdir(), "vellum-command-crew-control-"));
  await installCrewSeatHarness({ homeDir: root } as Sandbox);
  const seat = new CrewSeat(join(root, ".vellum-command", "crew-seats", "probe--seat"));
  const epoch = "fake-control-generation";
  const observer = new SessionObserver({ bindingId, epoch, cols: 120, rows: 32 });
  const runtime = new SeatStateRuntime({ turnProgressWatch: false });
  runtime.bindHarness(bindingId, "codex", epoch);
  let snapshot: ObserverGridSnapshot | undefined;
  let seq = 0n;
  let onWorking = () => {};
  const unsubscribe = observer.subscribe((next) => {
    snapshot = next;
    if (runtime.observe(next)?.state === "working") onWorking();
  });
  const pty = spawn(process.execPath, [join(root, ".local", "bin", "codex")], {
    cwd: root, cols: 120, rows: 32, name: "xterm-256color",
    env: { PATH: process.env.PATH!, HOME: root, VELLUM_COMMAND_NODE_REF: "probe:seat", TERM: "xterm-256color" },
  });
  const exited = new Promise<void>((resolve) => pty.onExit(() => resolve()));
  pty.onData((data) => observer.feed(data, ++seq));
  return {
    seat, pty, runtime,
    snapshot: () => snapshot,
    onWorking: (callback: () => void) => { onWorking = callback; },
    ready: async () => {
      await seat.ready(3000);
      await expect.poll(() => runtime.isSeatIdle(bindingId) && runtime.composerVerdict(bindingId) === "empty", { timeout: 3000 }).toBe(true);
    },
    close: async () => {
      await seat.control({ exit: 0 });
      await exited;
      unsubscribe(); runtime.stop(); observer.dispose();
      await rm(root, { recursive: true, force: true });
    },
  };
};

it("an idle reset cannot erase the shared drive's next paste before its CR", async () => {
  const probe = await launch();
  const payload = Array.from({ length: 15 }, (_, i) => `CONTROL_LINE_${String(i).padStart(2, "0")}`).join("\n");
  const writes: string[] = [];
  const attention: string[] = [];
  let pendingBeforeCr = false;
  const drive = createManagedTerminalDrive({
    write: async (_id, data) => {
      if (data === "\r") pendingBeforeCr = promptStillPending(probe.snapshot()!, payload);
      writes.push(data);
      probe.pty.write(data);
      // Cross several real control polls while the physical paste is pending.
      if (data === bracket(payload)) await delay(200);
      return true;
    },
    snapshot: probe.snapshot,
    isSeatIdle: (id) => probe.runtime.isSeatIdle(id),
    seatState: (id) => probe.runtime.getState(id),
    composerVerdict: (id) => probe.runtime.composerVerdict(id),
    harnessFor: () => "codex",
    onAttention: (_id, reason) => attention.push(reason),
  });
  probe.onWorking(() => drive.onTurnStart(bindingId));
  try {
    await probe.ready();
    await probe.seat.control({ screen: { mode: "idle" } });
    const outcome = await drive.writePrompt(bindingId, payload, {
      queueIfBusy: false, awaitTurnStart: true,
      ready: isManagedTerminalReady({ harness: "codex", seatState: probe.runtime.getState(bindingId), snapshot: probe.snapshot() }),
    });
    expect(pendingBeforeCr).toBe(true);
    expect(outcome).toMatchObject({ status: "submitted", pasteWrites: 1 });
    expect(writes).toEqual([bracket(payload), "\r"]);
    expect(attention).toEqual([]);
    const submits = (await probe.seat.events()).filter((event) => event.event === "submit");
    expect(submits).toHaveLength(1);
    expect(submits[0]).toMatchObject({ textLength: payload.length, textSha256: createHash("sha256").update(payload).digest("hex") });
    expect(await probe.seat.stdinLog()).toBe(bracket(payload) + "\r");
    await delay(200);
    expect(probe.runtime.getState(bindingId)).toBe("working");
    expect(promptStillPending(probe.snapshot()!, payload)).toBe(false);
  } finally {
    drive.resetForTest();
    await probe.close();
  }
}, 15_000);

it("identical explicit screen requests rearm once, while submit-only patches preserve the draft", async () => {
  const probe = await launch();
  const payload = "draft must survive a submit-only control patch";
  try {
    await probe.ready();
    await probe.seat.control({ screen: { mode: "idle" } });
    probe.pty.write(bracket(payload));
    await expect.poll(() => promptStillPending(probe.snapshot()!, payload), { timeout: 3000 }).toBe(true);
    await probe.seat.control({ submit: "hold", paste: "echo" });
    await delay(200);
    expect(promptStillPending(probe.snapshot()!, payload)).toBe(true);
    probe.pty.write("\r");
    await expect.poll(async () => (await probe.seat.events()).filter((event) => event.event === "submit").length).toBe(1);
    expect(promptStillPending(probe.snapshot()!, payload)).toBe(true);
    await probe.seat.control({ screen: { mode: "idle" } });
    await expect.poll(() => promptStillPending(probe.snapshot()!, payload)).toBe(false);
    probe.pty.write(bracket(payload));
    await expect.poll(() => promptStillPending(probe.snapshot()!, payload)).toBe(true);
    await delay(200);
    expect(promptStillPending(probe.snapshot()!, payload)).toBe(true);
    const screens = (await probe.seat.events()).filter((event) => event.event === "screen");
    expect(screens).toHaveLength(2);
    expect(new Set(screens.map((event) => event.requestId)).size).toBe(2);
    const submits = (await probe.seat.events()).filter((event) => event.event === "submit");
    expect(submits[0]).toMatchObject({ textLength: payload.length, textSha256: createHash("sha256").update(payload).digest("hex") });
  } finally {
    await probe.close();
  }
}, 15_000);
