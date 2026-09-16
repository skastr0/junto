import { join } from "node:path";
import { tmpdir } from "node:os";
import { mkdtemp, rm } from "node:fs/promises";
import { PassThrough } from "node:stream";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  createAppProcessPlane,
  type AppProcessLease,
  type AppProcessPlane,
} from "../src/main/junto/app-process-plane";
import {
  runBoundedWorkCliCommand,
  WorkCliCommandFailure,
} from "../scripts/work-cli-acceptance";

const planes: AppProcessPlane[] = [];

const makePlane = (): AppProcessPlane => {
  const plane = createAppProcessPlane({ termGraceMs: 20, killGraceMs: 250 });
  planes.push(plane);
  return plane;
};

const runSnippet = (
  plane: AppProcessPlane,
  source: string,
  overrides: Partial<{
    readonly timeoutMs: number;
    readonly outputLimitBytes: number;
    readonly termGraceMs: number;
    readonly killCloseGraceMs: number;
  }> = {},
) =>
  runBoundedWorkCliCommand(plane, {
    command: process.execPath,
    args: ["-e", source],
    cwd: process.cwd(),
    env: { ...process.env },
    ...overrides,
  });

const makeFakeLeasePlane = () => {
  const stdin = new PassThrough();
  const stdout = new PassThrough();
  const stderr = new PassThrough();
  let resolveClose!: (event: { code: number | null; signal: NodeJS.Signals | null }) => void;
  const closed = new Promise<{ code: number | null; signal: NodeJS.Signals | null }>(
    (resolve) => {
      resolveClose = resolve;
    },
  );
  const lease = {
    mode: "child",
    io: {
      stdin,
      stdout,
      stderr,
      closed,
      exited: closed,
      pidForDiagnostics: undefined,
      onExit: () => () => undefined,
      onClose: () => () => undefined,
      onError: () => () => undefined,
    },
  } as unknown as AppProcessLease;
  const terminate = vi.fn(() => ({ attempted: true }));
  const forceTerminate = vi.fn(() => ({ attempted: true }));
  const plane = {
    spawnChild: () => lease,
    terminate,
    forceTerminate,
  } as unknown as AppProcessPlane;
  return { plane, stdin, stdout, stderr, resolveClose, terminate, forceTerminate };
};

afterEach(async () => {
  while (planes.length > 0) {
    const plane = planes.pop();
    if (plane === undefined) continue;
    plane.beginShutdown();
    await expect(plane.drainOnQuit()).resolves.toEqual({
      clean: true,
      stragglers: [],
    });
  }
});

describe("work CLI acceptance process safety", () => {
  it("allows test bounds to shrink but never expand the production budgets", () => {
    const plane = makePlane();
    expect(() =>
      runBoundedWorkCliCommand(plane, {
        command: process.execPath,
        args: ["-e", "process.exit(0)"],
        cwd: process.cwd(),
        env: { ...process.env },
        timeoutMs: 10_001,
      })
    ).toThrow(/no greater than 10000/);
  });

  it("returns only after exact close while retaining bounded stdout and stderr", async () => {
    const result = await runSnippet(
      makePlane(),
      'process.stdout.write("ok"); process.stderr.write("warning"); process.exit(3);',
      { timeoutMs: 1_000, outputLimitBytes: 64 },
    );

    expect(result).toEqual({
      code: 3,
      signal: null,
      stdout: "ok",
      stderr: "warning",
    });
  });

  it("fails loudly at the stdout byte bound and retains only the bounded prefix", async () => {
    const fake = makeFakeLeasePlane();
    const command = runBoundedWorkCliCommand(fake.plane, {
      command: "unused-stdout-overflow-child",
      args: [],
      cwd: process.cwd(),
      env: { ...process.env },
      timeoutMs: 1_000,
      outputLimitBytes: 64,
      termGraceMs: 20,
      killCloseGraceMs: 250,
    });
    fake.stdout.write("x".repeat(4096));
    fake.resolveClose({ code: null, signal: "SIGTERM" });

    await expect(command).rejects.toMatchObject({
      name: "WorkCliCommandFailure",
      kind: "stdout-overflow",
      stdout: "x".repeat(64),
      stderr: "",
    });
    expect(fake.terminate).toHaveBeenCalledTimes(1);
    expect(fake.forceTerminate).not.toHaveBeenCalled();
  });

  it("independently bounds stderr and retains only its bounded prefix", async () => {
    const fake = makeFakeLeasePlane();
    const command = runBoundedWorkCliCommand(fake.plane, {
      command: "unused-stderr-overflow-child",
      args: [],
      cwd: process.cwd(),
      env: { ...process.env },
      timeoutMs: 1_000,
      outputLimitBytes: 48,
      termGraceMs: 20,
      killCloseGraceMs: 250,
    });
    fake.stderr.write("e".repeat(4096));
    fake.resolveClose({ code: null, signal: "SIGTERM" });

    await expect(command).rejects.toMatchObject({
      name: "WorkCliCommandFailure",
      kind: "stderr-overflow",
      stdout: "",
      stderr: "e".repeat(48),
    });
    expect(fake.terminate).toHaveBeenCalledTimes(1);
    expect(fake.forceTerminate).not.toHaveBeenCalled();
  });

  it("absorbs stdio errors into typed teardown instead of throwing outside the promise", async () => {
    const fake = makeFakeLeasePlane();

    const command = runBoundedWorkCliCommand(fake.plane, {
      command: "unused-fake-child",
      args: [],
      cwd: process.cwd(),
      env: { ...process.env },
      timeoutMs: 1_000,
      outputLimitBytes: 64,
      termGraceMs: 20,
      killCloseGraceMs: 250,
    });
    expect(() => fake.stdout.emit("error", new Error("stdout-broken"))).not.toThrow();
    fake.resolveClose({ code: 0, signal: null });

    await expect(command).rejects.toMatchObject({
      name: "WorkCliCommandFailure",
      kind: "stdio-error",
    });
    expect(fake.terminate).toHaveBeenCalledTimes(1);
    expect(fake.forceTerminate).not.toHaveBeenCalled();
  });

  it("keeps harmless stdio error sinks after an unobserved close receipt", async () => {
    const fake = makeFakeLeasePlane();
    const command = runBoundedWorkCliCommand(fake.plane, {
      command: "unused-non-closing-child",
      args: [],
      cwd: process.cwd(),
      env: { ...process.env },
      timeoutMs: 20,
      outputLimitBytes: 64,
      termGraceMs: 10,
      killCloseGraceMs: 20,
    });

    await expect(command).rejects.toMatchObject({
      name: "WorkCliCommandFailure",
      kind: "close-timeout",
    });
    expect(fake.terminate).toHaveBeenCalledTimes(1);
    expect(fake.forceTerminate).toHaveBeenCalledTimes(1);
    expect(() => fake.stderr.emit("error", new Error("late-stderr-error"))).not.toThrow();
  });

  it("escalates a deadline through TERM then KILL and still observes close", async () => {
    const fake = makeFakeLeasePlane();
    fake.forceTerminate.mockImplementation(() => {
      fake.resolveClose({ code: null, signal: "SIGKILL" });
      return { attempted: true };
    });
    const command = runBoundedWorkCliCommand(fake.plane, {
      command: "unused-deadline-child",
      args: [],
      cwd: process.cwd(),
      env: { ...process.env },
      timeoutMs: 20,
      outputLimitBytes: 64,
      termGraceMs: 10,
      killCloseGraceMs: 250,
    });
    fake.stdout.write("ready");

    await expect(command).rejects.toMatchObject({
      name: "WorkCliCommandFailure",
      kind: "timeout",
      stdout: "ready",
    });
    expect(fake.terminate).toHaveBeenCalledTimes(1);
    expect(fake.forceTerminate).toHaveBeenCalledTimes(1);
  });

  it("turns spawn failure into a typed failure instead of an apparent exit", async () => {
    const plane = makePlane();
    const root = await mkdtemp(join(tmpdir(), "junto-work-cli-missing-"));
    try {
      const command = runBoundedWorkCliCommand(plane, {
        command: join(root, "missing-child"),
        args: [],
        cwd: process.cwd(),
        env: { ...process.env },
        timeoutMs: 1_000,
        outputLimitBytes: 64,
        termGraceMs: 20,
        killCloseGraceMs: 250,
      });

      const failure = await command.catch((error: unknown) => error);
      expect(failure).toBeInstanceOf(WorkCliCommandFailure);
      expect(failure).toMatchObject({ kind: "spawn-error" });
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});
