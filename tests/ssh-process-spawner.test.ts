import * as Command from "@effect/platform/Command";
import { Effect, Layer, Stream } from "effect";
import { describe, expect, it, vi } from "vitest";
import { readFile } from "node:fs/promises";
import { ProcessSpawner, ProcessSpawnerLive } from "../src/main/vellum/ssh/process-spawner";
import { clearProcessSignalAuditLog, getProcessSignalAuditLog, probeProcessAlive } from "../src/main/vellum/process-signal";

const SpawnerLive = ProcessSpawnerLive;

describe("ProcessSpawnerLive", () => {
  it("runs through the sealed detached process-group spawner", async () => {
    const result = await Effect.runPromise(
      Effect.scoped(
        Effect.gen(function* () {
          const process = yield* (yield* ProcessSpawner).start(
            Command.make("/usr/bin/printf", "effect-process-ok"),
          );
          const completed = yield* Effect.all(
            {
              input: Stream.run(Stream.empty, process.stdin),
              stdout: Stream.runCollect(process.stdout),
              stderr: Stream.runDrain(process.stderr),
              code: process.exitCode,
            },
            { concurrency: "unbounded" },
          );
          return {
            code: completed.code,
            stdout: Buffer.concat(
              [...completed.stdout].map((chunk) => Buffer.from(chunk)),
            ).toString("utf8"),
          };
        }),
      ).pipe(Effect.provide(SpawnerLive)),
    );

    expect(result).toEqual({ code: 0, stdout: "effect-process-ok" });
  });

  it("explicitly rejects command pipelines", async () => {
    const left = Command.make("/usr/bin/printf", "x");
    const pipeline = Command.pipeTo(left, Command.make("/bin/cat"));
    const result = await Effect.runPromise(Effect.gen(function* () {
      return yield* Effect.scoped((yield* ProcessSpawner).start(pipeline));
    }).pipe(Effect.provide(SpawnerLive), Effect.either));
    expect(result._tag).toBe("Left");
  });

  it("handles async missing-executable errors without a rejection or shutdown grace", async () => {
    const unhandled = vi.fn();
    process.on("unhandledRejection", unhandled);
    const startedAt = Date.now();
    try {
      const result = await Effect.runPromise(Effect.scoped(Effect.gen(function* () {
        const child = yield* (yield* ProcessSpawner).start(Command.make("/definitely/not/a-vellum-command"));
        yield* Effect.sleep(30);
        return yield* Effect.either(child.exitCode);
      })).pipe(Effect.provide(SpawnerLive)));
      expect(result._tag).toBe("Left");
      expect(Date.now() - startedAt).toBeLessThan(500);
      await new Promise((resolve) => setTimeout(resolve, 0));
      expect(unhandled).not.toHaveBeenCalled();
    } finally {
      process.off("unhandledRejection", unhandled);
    }
  });

  it("immediately closes a missing executable scope without a signal grace", async () => {
    const unhandled = vi.fn();
    process.on("unhandledRejection", unhandled);
    const startedAt = Date.now();
    try {
      await Effect.runPromise(Effect.scoped(Effect.gen(function* () {
        const child = yield* (yield* ProcessSpawner).start(Command.make("/definitely/not-a-vellum-command-immediate"));
        // Deliberately no sleep or exitCode await: this is the finalizer race.
        yield* child.isRunning;
      })).pipe(Effect.provide(SpawnerLive)));
      expect(Date.now() - startedAt).toBeLessThan(500);
      await new Promise((resolve) => setTimeout(resolve, 0));
      expect(unhandled).not.toHaveBeenCalled();
    } finally {
      process.off("unhandledRejection", unhandled);
    }
  });

  it("uses only the central process lease and keeps errors distinct from terminal witnesses", async () => {
    const source = await readFile("src/main/vellum/ssh/process-spawner.ts", "utf8");
    expect(source).toContain("appProcessPlane.spawnGroup({");
    expect(source).toMatch(/if \(lease\.io\.pidForDiagnostics === undefined\)/u);
    expect(source).toMatch(/Later errors are diagnostic[\s\S]*must not fabricate an exit\/close witness or cancel TERM→KILL/u);
    const exitObserver = source.slice(
      source.indexOf("lease.io.onExit"),
      source.indexOf("lease.io.onClose"),
    );
    expect(exitObserver).toContain("processEnded = true");
    expect(exitObserver).not.toContain("settleClose()");
    expect(source.slice(source.indexOf("lease.io.onClose"))).toContain("settleClose()");
    expect(source).not.toMatch(/\bspawnDetachedProcessGroup\b|\bsignalOwned\b|\breleaseOwned\b|\bOwnedProcess\b/u);
    expect(source).not.toMatch(/tracked\.child|lease\.child|\.kill\s*\(/u);
  });

  it("waits for the close witness after an earlier process exit", async () => {
    const result = await Effect.runPromise(
      Effect.scoped(
        Effect.gen(function* () {
          const child = yield* (yield* ProcessSpawner).start(
            Command.make(
              process.execPath,
              "-e",
              [
                "const { spawn } = require('node:child_process');",
                "const child = spawn(process.execPath, ['-e', 'setTimeout(() => {}, 500)'], { stdio: ['ignore', 'inherit', 'inherit'] });",
                "child.unref();",
              ].join(" "),
            ),
          );
          const code = yield* child.exitCode;
          return { code, exitedAt: Date.now() };
        }),
      ).pipe(Effect.provide(SpawnerLive)),
    );

    expect(result.code).toBe(0);
    expect(Date.now() - result.exitedAt).toBeGreaterThanOrEqual(250);
  });

  it("forwards StandardCommand identity options through the central spawn spec", async () => {
    const source = await readFile("src/main/vellum/ssh/process-spawner.ts", "utf8");
    expect(source).toMatch(/cwd: Option\.getOrUndefined\(command\.cwd\)/u);
    expect(source).toMatch(/env: environment/u);
    expect(source).toMatch(/shell: command\.shell/u);
    expect(source).toMatch(/uid: Option\.getOrUndefined\(command\.uid\)/u);
    expect(source).toMatch(/gid: Option\.getOrUndefined\(command\.gid\)/u);
  });

  it("terminates a responsive owned process without waiting through the grace period", async () => {
    const startedAt = Date.now();
    await Effect.runPromise(
      Effect.scoped(
        Effect.gen(function* () {
          yield* (yield* ProcessSpawner).start(Command.make("/bin/cat"));
          yield* Effect.sleep(20);
        }),
      ).pipe(Effect.provide(SpawnerLive)),
    );

    expect(Date.now() - startedAt).toBeLessThan(1_500);
  });

  it("cancels escalation when TERM exits during the grace window", async () => {
    clearProcessSignalAuditLog();
    const startedAt = Date.now();
    let pid: number | undefined;
    await Effect.runPromise(Effect.scoped(Effect.gen(function* () {
      const child = yield* (yield* ProcessSpawner).start(Command.make(
        process.execPath,
        "-e",
        "process.on('SIGTERM', () => setTimeout(() => process.exit(0), 100)); setInterval(() => {}, 1000)",
      ));
      pid = child.pid;
      yield* Effect.sleep(20);
    })).pipe(Effect.provide(SpawnerLive)));
    expect(Date.now() - startedAt).toBeLessThan(700);
    await new Promise((resolve) => setTimeout(resolve, 25));
    expect(probeProcessAlive(pid)).toBe(false);
    expect(getProcessSignalAuditLog().some((entry) => entry.signal === "SIGKILL")).toBe(false);
  });

  it("escalates from SIGTERM to SIGKILL after a bounded grace period", async () => {
    const startedAt = Date.now();
    let pid: number | undefined;
    await Effect.runPromise(
      Effect.scoped(
        Effect.gen(function* () {
          const child = yield* (yield* ProcessSpawner).start(
            Command.make(
              "/bin/sh",
              "-c",
              "trap '' TERM; (sleep 4; kill -KILL $$) & printf ready; while :; do sleep 1; done",
            ),
          );
          pid = child.pid;
          yield* Stream.runHead(child.stdout);
        }),
      ).pipe(Effect.provide(SpawnerLive)),
    );
    const elapsed = Date.now() - startedAt;

    expect(elapsed).toBeGreaterThanOrEqual(1_500);
    expect(elapsed).toBeLessThan(4_500);
    await new Promise((resolve) => setTimeout(resolve, 25));
    expect(probeProcessAlive(pid)).toBe(false);
  });
});
