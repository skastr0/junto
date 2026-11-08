import { type ChildProcess, spawn } from "node:child_process";
import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { Effect, Layer, ManagedRuntime } from "effect";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { createSandbox, destroySandbox, type Sandbox, writeFixtureModel } from "../e2e/harness/sandbox";
import { modelFixture, modelSeat } from "../e2e/harness/model";
import { ModelService } from "../src/core/model/service";
import { ModelDependents } from "../src/core/model/dependents";
import { makeStateEngineLive } from "../src/core/state/engine";
import { makeMachineRepositoryLive } from "../src/core/machines/repository";
import { makeSeatSessionRepositoryLive, SeatSessionRepository } from "../src/core/seat-sessions/repository";
import { THIS_MACHINE } from "./support/machines";

const app = vi.hoisted(() => ({ runPromise: vi.fn() }));
// Spread the real module: a later export must not break this file at load.
vi.mock("../src/core/core-runner", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../src/core/core-runner")>()),
  coreRunner: app,
}));
import { SeatSessionCapture } from "../src/core/term/seat-session-capture";

/**
 * Codex 0.166 [fixture]: two seats in one folder, each a real process that
 * holds its own rollout open the way codex does. The thread is minted when
 * the TUI starts and the rollout is written only when the first turn starts,
 * so a seat's file can appear after its sibling's, stamped earlier than it.
 */
const A = "01a19e22-ce4c-7f73-8a02-2c8bdc5abf8a";
const B = "01a19e22-e07d-76a0-845f-47b748e059ea";

// A codex stand-in: opens its rollout for append, writes session_meta, and
// keeps the descriptor for as long as it runs.
const HOLDER = `const fs = require("fs");
const [path, line] = process.argv.slice(2);
let fd;
process.stdin.on("data", () => {
  if (fd !== undefined) return;
  fd = fs.openSync(path, "a");
  fs.writeSync(fd, line);
  process.stdout.write("held\\n");
});
process.stdout.write("up\\n");
setInterval(() => {}, 60_000);
`;

type Holder = { readonly pid: number; readonly write: () => Promise<void> };

let sandbox: Sandbox;
let runtime: ManagedRuntime.ManagedRuntime<SeatSessionRepository | ModelService, unknown>;
const children: ChildProcess[] = [];

const untilLine = (child: ChildProcess, text: string): Promise<void> =>
  new Promise((resolve, reject) => {
    let seen = "";
    const onData = (chunk: Buffer) => {
      seen += String(chunk);
      if (seen.split("\n").includes(text)) {
        child.stdout!.off("data", onData);
        resolve();
      }
    };
    child.stdout!.on("data", onData);
    child.once("exit", (code) => reject(new Error(`holder exited ${code} before "${text}"`)));
  });

const dayDir = (at: Date): string => {
  const pad = (n: number) => String(n).padStart(2, "0");
  return join(sandbox.homeDir, ".codex", "sessions", String(at.getFullYear()), pad(at.getMonth() + 1), pad(at.getDate()));
};

/** A seat's codex: running now, its thread minted at `mintedAt`, its rollout written on `write()`. */
const codexSeat = async (id: string, mintedAt: Date): Promise<Holder> => {
  const dir = dayDir(mintedAt);
  await mkdir(dir, { recursive: true });
  const script = join(sandbox.root, "codex-holder.cjs");
  await writeFile(script, HOLDER);
  const line = `${JSON.stringify({ type: "session_meta", payload: { id, timestamp: mintedAt.toISOString(), cwd: sandbox.root, source: "cli", thread_source: "user" } })}\n`;
  const child = spawn(process.execPath, [script, join(dir, `rollout-${mintedAt.getTime()}-${id}.jsonl`), line], {
    stdio: ["pipe", "pipe", "inherit"],
  });
  children.push(child);
  await untilLine(child, "up");
  return {
    pid: child.pid!,
    write: async () => {
      const held = untilLine(child, "held");
      child.stdin!.write("go\n");
      await held;
    },
  };
};

const seatA = { id: "seat-a", bindingId: "local:seat-a" };
const seatB = { id: "seat-b", bindingId: "local:seat-b" };

const current = (seatId: string, bindingId: string) =>
  runtime.runPromise(Effect.flatMap(SeatSessionRepository, (repo) => repo.current(seatId, bindingId)));

beforeEach(async () => {
  sandbox = await createSandbox();
  await writeFixtureModel(sandbox, "proof", modelFixture([
    modelSeat({ id: seatA.id, key: `local:${seatA.id}`, label: "A", cwd: sandbox.root }),
    modelSeat({ id: seatB.id, key: `local:${seatB.id}`, label: "B", cwd: sandbox.root }),
  ]));
  runtime = ManagedRuntime.make(Layer.provideMerge(
    Layer.provide(ModelService.layer, ModelDependents.empty),
    Layer.provideMerge(Layer.mergeAll(
      makeMachineRepositoryLive({ defaultName: () => THIS_MACHINE }),
      makeSeatSessionRepositoryLive(),
    ), makeStateEngineLive(join(sandbox.homeDir, ".junto", "state", "junto.db"))),
  )) as typeof runtime;
  app.runPromise.mockImplementation((effect) => runtime.runPromise(effect));
  await runtime.runPromise(Effect.flatMap(ModelService, (model) => model.open("proof")));
});

afterEach(async () => {
  // Only the holders this file started.
  for (const child of children.splice(0)) if (child.exitCode === null) child.kill("SIGTERM");
  app.runPromise.mockReset();
  await runtime.dispose();
  await destroySandbox(sandbox);
});

const watchBoth = (capture: SeatSessionCapture, t0: number, pids: { a?: number; b?: number }) => {
  capture.watch({ bindingId: seatA.bindingId, harness: "codex", canvasName: "proof", nodeId: seatA.id, cwd: sandbox.root, spawnedAtMs: t0, ...(pids.a ? { pid: () => pids.a } : {}) });
  capture.watch({ bindingId: seatB.bindingId, harness: "codex", canvasName: "proof", nodeId: seatB.id, cwd: sandbox.root, spawnedAtMs: t0 + 500, ...(pids.b ? { pid: () => pids.b } : {}) });
};

it("each seat binds the rollout its own process holds, whichever is written first", { timeout: 30_000 }, async () => {
  const t0 = Date.now() - 5_000;
  const a = await codexSeat(A, new Date(t0 + 300));
  const b = await codexSeat(B, new Date(t0 + 800));
  const capture = new SeatSessionCapture(() => sandbox.homeDir);
  watchBoth(capture, t0, { a: a.pid, b: b.pid });

  // B's first turn starts first. A's process holds nothing yet, so A takes
  // nothing, though B's rollout is the earliest in the folder since A spawned.
  await b.write();
  expect(await capture.attempt(seatA.bindingId)).toBeUndefined();
  expect(await capture.attempt(seatB.bindingId)).toBe(B);

  // A's rollout lands, stamped before B's: it is A's alone.
  await a.write();
  expect(await capture.attempt(seatA.bindingId)).toBe(A);

  // Offboard reads the seat's current session: each has its own id.
  expect(await current(seatA.id, seatA.bindingId)).toMatchObject({ sessionId: A });
  expect(await current(seatB.id, seatB.bindingId)).toMatchObject({ sessionId: B });
  expect(capture.pending()).toEqual([]);
});

it("the later seat never takes the first seat's rollout while its own is unwritten", { timeout: 30_000 }, async () => {
  const t0 = Date.now() - 5_000;
  const a = await codexSeat(A, new Date(t0 + 300));
  const b = await codexSeat(B, new Date(t0 + 800));
  const capture = new SeatSessionCapture(() => sandbox.homeDir);
  watchBoth(capture, t0, { a: a.pid, b: b.pid });

  // A's rollout sits inside B's start window: by folder and time alone it is B's earliest.
  await a.write();
  expect(await capture.attempt(seatB.bindingId)).toBeUndefined();
  expect(await capture.attempt(seatA.bindingId)).toBe(A);
  expect(await capture.attempt(seatB.bindingId)).toBeUndefined();

  await b.write();
  expect(await capture.attempt(seatB.bindingId)).toBe(B);
  expect(await current(seatA.id, seatA.bindingId)).toMatchObject({ sessionId: A });
  expect(await current(seatB.id, seatB.bindingId)).toMatchObject({ sessionId: B });
});

it("a pid named after the spawn is read at the look, not at the watch", { timeout: 30_000 }, async () => {
  const t0 = Date.now() - 5_000;
  const a = await codexSeat(A, new Date(t0 + 300));
  const b = await codexSeat(B, new Date(t0 + 800));
  // The terminal process names a PTY's pid a turn after the spawn is announced.
  const named: { a?: number; b?: number } = {};
  const capture = new SeatSessionCapture(() => sandbox.homeDir);
  capture.watch({ bindingId: seatA.bindingId, harness: "codex", canvasName: "proof", nodeId: seatA.id, cwd: sandbox.root, spawnedAtMs: t0, pid: () => named.a });
  capture.watch({ bindingId: seatB.bindingId, harness: "codex", canvasName: "proof", nodeId: seatB.id, cwd: sandbox.root, spawnedAtMs: t0 + 500, pid: () => named.b });
  named.a = a.pid;
  named.b = b.pid;

  await b.write();
  expect(await capture.attempt(seatA.bindingId)).toBeUndefined();
  expect(await capture.attempt(seatB.bindingId)).toBe(B);
  await a.write();
  expect(await capture.attempt(seatA.bindingId)).toBe(A);
});

it("without a process to ask, a claimed rollout no longer blocks the sibling's own", { timeout: 30_000 }, async () => {
  const t0 = Date.now() - 5_000;
  const a = await codexSeat(A, new Date(t0 + 300));
  const b = await codexSeat(B, new Date(t0 + 800));
  const capture = new SeatSessionCapture(() => sandbox.homeDir);
  watchBoth(capture, t0, {});

  await a.write();
  // Both seats could claim A's rollout by folder and time, so neither does yet.
  expect(await capture.attempt(seatB.bindingId)).toBeUndefined();
  capture.forget(seatB.bindingId);
  expect(await capture.attempt(seatA.bindingId)).toBe(A);

  // B is watched again (a fresh boundary after a replay) and its rollout lands.
  capture.watch({ bindingId: seatB.bindingId, harness: "codex", canvasName: "proof", nodeId: seatB.id, cwd: sandbox.root, spawnedAtMs: t0 + 500 });
  await b.write();
  // The earliest rollout in its window is A's, which A has claimed: B takes its own.
  expect(await capture.attempt(seatB.bindingId)).toBe(B);
  expect(await current(seatB.id, seatB.bindingId)).toMatchObject({ sessionId: B });
});

it("a seat whose process holds no rollout still takes one no sibling holds", { timeout: 30_000 }, async () => {
  const t0 = Date.now() - 5_000;
  const a = await codexSeat(A, new Date(t0 + 300));
  const capture = new SeatSessionCapture(() => sandbox.homeDir);
  capture.watch({ bindingId: seatA.bindingId, harness: "codex", canvasName: "proof", nodeId: seatA.id, cwd: sandbox.root, spawnedAtMs: t0, pid: () => a.pid });
  // A Codex that closes its rollout between writes: the file is there, held by no one.
  const minted = new Date(t0 + 300);
  await writeFile(join(dayDir(minted), `rollout-${minted.getTime()}-${A}.jsonl`), `${JSON.stringify({ type: "session_meta", payload: { id: A, timestamp: minted.toISOString(), cwd: sandbox.root, source: "cli", thread_source: "user" } })}\n`);
  expect(await capture.attempt(seatA.bindingId)).toBe(A);
});

it("one look at a time: boundaries arriving together share one answer", { timeout: 30_000 }, async () => {
  const t0 = Date.now() - 5_000;
  const a = await codexSeat(A, new Date(t0 + 300));
  let looks = 0;
  const capture = new SeatSessionCapture(() => sandbox.homeDir, async (pid) => {
    looks += 1;
    const { openFilesOfProcessTree } = await import("../src/core/term/process-open-files");
    return openFilesOfProcessTree(pid);
  });
  capture.watch({ bindingId: seatA.bindingId, harness: "codex", canvasName: "proof", nodeId: seatA.id, cwd: sandbox.root, spawnedAtMs: t0, pid: () => a.pid });
  await a.write();
  const answers = await Promise.all([1, 2, 3].map(() => capture.attempt(seatA.bindingId)));
  expect(answers).toEqual([A, A, A]);
  expect(looks).toBe(1);
});
