/**
 * The bounds of putting Junto on another machine nest (docs/machines.md,
 * "Every wait is bounded"): the window outwaits the core, the core's install
 * bound outwaits every step it runs, and the step that runs out of time is
 * the one that says so, by name and limit. remote-verify's Send on a loaded
 * Mac (load 394, 2026-11-23) failed after 2 min 34 s saying only "Command
 * failed: tar -czf ...": the archive had a 120 s bound, sized for an idle
 * machine, and its failure named the command, not the step.
 */
import { execFile } from "node:child_process";
import { readFileSync } from "node:fs";
import { promisify } from "node:util";
import { Effect, Fiber } from "effect";
import { TestClock } from "effect/testing";
import { expect, it } from "vitest";
import {
  MACHINE_ARCHIVE_TIMEOUT_MS,
  MACHINE_BOAT_ASLEEP_WAIT_MS,
  MACHINE_BOAT_AWAKE_WAIT_MS,
  MACHINE_BUNDLE_DOWNLOAD_TIMEOUT_MS,
  MACHINE_COMMAND_WINDOW_TIMEOUT_MS,
  MACHINE_INSTALL_COMMAND_TIMEOUT_MS,
  MACHINE_INSTALL_COMMANDS,
  MACHINE_TRANSFER_TIMEOUT_MS,
} from "../src/shared/machine-command-bounds";
import { OPERATOR_MAX_TIMEOUT_MS, OPERATOR_PROTOCOL_VERSION } from "../src/shared/operator-control";
import { dispatchMachineIpcCommand } from "../src/core/hosts/machine-ipc-command";
import { archiveFailure } from "../src/core/hosts/send";

const run = promisify(execFile);

it("the window outwaits the install bound, and the install bound every step it runs", () => {
  const steps = MACHINE_BOAT_ASLEEP_WAIT_MS + MACHINE_BOAT_AWAKE_WAIT_MS + MACHINE_BUNDLE_DOWNLOAD_TIMEOUT_MS +
    MACHINE_ARCHIVE_TIMEOUT_MS + MACHINE_TRANSFER_TIMEOUT_MS;
  expect(MACHINE_INSTALL_COMMAND_TIMEOUT_MS).toBeGreaterThan(steps);
  expect(MACHINE_COMMAND_WINDOW_TIMEOUT_MS).toBeGreaterThan(MACHINE_INSTALL_COMMAND_TIMEOUT_MS);
  expect(MACHINE_COMMAND_WINDOW_TIMEOUT_MS).toBeGreaterThan(OPERATOR_MAX_TIMEOUT_MS);
  expect([...MACHINE_INSTALL_COMMANDS]).toEqual(["machine.send", "machine.update", "machine.boat-add"]);
});

it("the archive is sized for a loaded machine: many times the 1 min 47 s it took at load 394", () => {
  expect(MACHINE_ARCHIVE_TIMEOUT_MS).toBeGreaterThanOrEqual(5 * 107_000);
});

it("each step reads its bound from the one file", () => {
  const send = readFileSync("src/core/hosts/send.ts", "utf8");
  expect(send).toContain("timeout:MACHINE_ARCHIVE_TIMEOUT_MS");
  expect(send).toContain("MACHINE_TRANSFER_TIMEOUT_MS,observe");
  expect(send).not.toMatch(/timeout:120_000|20\*60_000/u);
  expect(readFileSync("src/core/hosts/machine-bundle-download.ts", "utf8")).toContain("AbortSignal.timeout(MACHINE_BUNDLE_DOWNLOAD_TIMEOUT_MS)");
  const boat = readFileSync("src/core/boat/machines.ts", "utf8");
  expect(boat).not.toMatch(/\b(AWAKE|ASLEEP|CORE)_WAIT_MS = /u);
});

it("an install command waits past the operator bound and still answers when its own runs out", async () => {
  for (const op of MACHINE_INSTALL_COMMANDS) {
    const actions = { dispatch: () => Effect.never };
    const answer = await Effect.runPromise(Effect.gen(function* () {
      const fiber = yield* Effect.forkChild(dispatchMachineIpcCommand(actions, { protocol: OPERATOR_PROTOCOL_VERSION, id: "send-1", op, args: { name: "mini" } }, () => {}));
      yield* TestClock.adjust(OPERATOR_MAX_TIMEOUT_MS + 1);
      expect(fiber.pollUnsafe(), `${op} answered at the operator bound`).toBeUndefined();
      yield* TestClock.adjust(MACHINE_INSTALL_COMMAND_TIMEOUT_MS);
      return yield* Fiber.join(fiber);
    }).pipe(Effect.provide(TestClock.layer())));
    expect(answer.ok, op).toBe(false);
    if (answer.ok) continue;
    expect(answer.error.details).toMatchObject({ disposition: "uncertain" });
  }
});

it("any other machine command keeps the operator bound", async () => {
  const actions = { dispatch: () => Effect.never };
  const answer = await Effect.runPromise(Effect.gen(function* () {
    const fiber = yield* Effect.forkChild(dispatchMachineIpcCommand(actions, { protocol: OPERATOR_PROTOCOL_VERSION, id: "list-1", op: "machine.list", args: {} }, () => {}));
    yield* TestClock.adjust(OPERATOR_MAX_TIMEOUT_MS + 1);
    return yield* Fiber.join(fiber);
  }).pipe(Effect.provide(TestClock.layer())));
  expect(answer.ok).toBe(false);
});

it("an archive that runs out of time says so by name and limit, never the command", async () => {
  const cause = await run("sleep", ["5"], { timeout: 50 }).then(() => undefined, (failed: unknown) => failed);
  const failure = archiveFailure(cause, "macbookpro", 10 * 60_000);
  expect(failure.timedOut).toBe(true);
  expect(failure.message).toBe("Packing Junto on macbookpro took longer than its 10 minute limit, so nothing was sent. macbookpro may be busy; send Junto again when it is quieter");
  expect(failure.message).not.toMatch(/Command failed|tar |sleep/u);
});

it("an archive that fails says how, never the command", async () => {
  const cause = await run("tar", ["-czf", "/nonexistent-dir/package.tgz", "-C", "/nonexistent-bundle", "."]).then(() => undefined, (failed: unknown) => failed);
  const failure = archiveFailure(cause, "macbookpro");
  expect(failure.timedOut).toBe(false);
  expect(failure.message).toMatch(/^Packing Junto on macbookpro failed, so nothing was sent: it exited \d+/u);
  expect(failure.message).not.toMatch(/Command failed|tar -czf/u);
});
