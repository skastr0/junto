import { readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PassThrough } from "node:stream";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  createProbeSandbox,
  createProbeProcessSupervisor,
  removeProbeSandboxIfClean,
  retainProbeSandbox,
  type ProbeProcessDrainReceipt,
  type ProbeSandbox,
} from "../scripts/probe-process-supervisor";
import type {
  AppChildIo,
  AppProcessDrainResult,
  AppProcessLease,
  AppProcessPlane,
  AppProcessSignalReceipt,
  AppTerminalLease,
} from "../src/main/junto/app-process-plane";

const tempSandboxes = new Set<ProbeSandbox>();
const cleanDrainReceipt: ProbeProcessDrainReceipt = {
  clean: true,
  groupDrain: { clean: true, stragglers: [] },
  refusedSignals: [],
  active: [],
};

interface Deferred<Value> {
  readonly promise: Promise<Value>;
  readonly resolve: (value: Value) => void;
}

const deferred = <Value>(): Deferred<Value> => {
  let resolve!: (value: Value) => void;
  const promise = new Promise<Value>((accept) => {
    resolve = accept;
  });
  return { promise, resolve };
};

interface FakeLeaseControl {
  readonly lease: AppProcessLease;
  readonly stdout: PassThrough;
  readonly stderr: PassThrough;
  readonly emitExit: (code?: number | null, signal?: NodeJS.Signals | null) => void;
  readonly emitClose: (code?: number | null, signal?: NodeJS.Signals | null) => void;
  readonly emitError: (error: Error) => void;
}

const makeLease = (generation: number): FakeLeaseControl => {
  const stdout = new PassThrough();
  const stderr = new PassThrough();
  const closed = deferred<{ readonly code: number | null; readonly signal: NodeJS.Signals | null }>();
  const exited = deferred<{ readonly code: number | null; readonly signal: NodeJS.Signals | null }>();
  const exitListeners = new Set<(event: { readonly code: number | null; readonly signal: NodeJS.Signals | null }) => void>();
  const closeListeners = new Set<(event: { readonly code: number | null; readonly signal: NodeJS.Signals | null }) => void>();
  const errorListeners = new Set<(error: Error) => void>();
  const io: AppChildIo = {
    stdin: new PassThrough(),
    stdout,
    stderr,
    pidForDiagnostics: 40_000 + generation,
    exited: exited.promise,
    closed: closed.promise,
    onExit: (listener) => {
      exitListeners.add(listener);
      return () => exitListeners.delete(listener);
    },
    onClose: (listener) => {
      closeListeners.add(listener);
      return () => closeListeners.delete(listener);
    },
    onError: (listener) => {
      errorListeners.add(listener);
      return () => errorListeners.delete(listener);
    },
  };
  const lease = {
    generation,
    source: `test:${generation}`,
    purpose: `fixture ${generation}`,
    mode: "group",
    io,
  } as unknown as AppProcessLease;
  return {
    lease,
    stdout,
    stderr,
    emitExit: (code = 0, signal = null) => {
      const event = { code, signal };
      exited.resolve(event);
      for (const listener of exitListeners) listener(event);
    },
    emitClose: (code = 0, signal = null) => {
      const event = { code, signal };
      closed.resolve(event);
      for (const listener of closeListeners) listener(event);
    },
    emitError: (error) => {
      for (const listener of errorListeners) listener(error);
    },
  };
};

const attempted = (
  signal: "SIGTERM" | "SIGKILL",
  reason: string,
): AppProcessSignalReceipt => ({
  attempted: true,
  decision: { ok: true, mode: "group" },
  via: "process.kill-group",
  signal,
  reason,
});

const refused = (
  signal: "SIGTERM" | "SIGKILL",
  reason: string,
): AppProcessSignalReceipt => ({
  attempted: false,
  decision: { ok: false, reason: "epoch-mismatch" },
  via: "none",
  signal,
  reason,
});

const makePlane = (controls: readonly FakeLeaseControl[], options: {
  readonly drain?: AppProcessDrainResult | Promise<AppProcessDrainResult>;
  readonly refuseGeneration?: number;
} = {}) => {
  let cursor = 0;
  let quiescing = false;
  const terminate = vi.fn((lease: AppProcessLease | AppTerminalLease, reason: string) => {
    const receipt = lease.generation === options.refuseGeneration
      ? refused("SIGTERM", reason)
      : attempted("SIGTERM", reason);
    return receipt;
  });
  const forceTerminate = vi.fn((lease: AppProcessLease | AppTerminalLease, reason: string) =>
    attempted("SIGKILL", `${reason}:${lease.generation}`));
  const plane: AppProcessPlane = {
    spawnChild: vi.fn(() => {
      throw new Error("unexpected spawnChild");
    }),
    spawnGroup: vi.fn(() => controls[cursor++]!.lease),
    spawnTerminal: vi.fn(() => {
      throw new Error("unexpected spawnTerminal");
    }),
    spawnOutlivingDaemon: vi.fn(() => {
      throw new Error("unexpected daemon");
    }),
    terminate,
    forceTerminate,
    beginShutdown: vi.fn(() => {
      quiescing = true;
    }),
    drainOnQuit: vi.fn(async (): Promise<AppProcessDrainResult> =>
      await (options.drain ?? { clean: true, stragglers: [] as const })),
    isQuiescing: () => quiescing,
  };
  return { plane, terminate, forceTerminate };
};

const spec = (purpose: string) => ({
  source: "probe-process-supervisor.test",
  purpose,
  command: "/usr/bin/true",
});

beforeEach(() => {
  vi.useRealTimers();
});

afterEach(async () => {
  vi.restoreAllMocks();
  await Promise.all([...tempSandboxes].map(async (sandbox) => {
    await removeProbeSandboxIfClean({
      sandbox,
      receipt: cleanDrainReceipt,
      label: "probe supervisor test cleanup",
    });
    tempSandboxes.delete(sandbox);
  }));
});

describe("probe process supervisor", () => {
  it("bounds logs and treats generic errors as diagnostics, never close", async () => {
    const child = makeLease(1);
    const { plane } = makePlane([child]);
    const supervisor = createProbeProcessSupervisor({
      processPlane: plane,
      maxLogBytes: 8,
      termGraceMs: 10,
      killGraceMs: 10,
    });
    const handle = supervisor.spawnGroup(spec("bounded output"));
    let didClose = false;
    void handle.closed.then(() => {
      didClose = true;
    });

    child.stdout.write("0123456789");
    child.stderr.write("abcdefghij");
    child.emitError(new Error("diagnostic-only"));
    child.emitExit(0, null);
    await Promise.resolve();

    expect(handle.exited()).toBe(true);
    expect(didClose).toBe(false);
    expect(handle.output()).toEqual({
      stdout: "23456789",
      stderr: "cdefghij",
      diagnostics: ["diagnostic-only"],
    });

    child.emitClose(0, null);
    await expect(handle.closed).resolves.toMatchObject({
      exitCode: 0,
      signal: null,
      diagnostics: ["diagnostic-only"],
    });
    const receipt = await supervisor.shutdown("test-complete");
    expect(receipt.clean).toBe(true);
  });

  it("escalates a live group and still waits for exact close", async () => {
    vi.useFakeTimers();
    const child = makeLease(2);
    const { plane, terminate, forceTerminate } = makePlane([child]);
    const supervisor = createProbeProcessSupervisor({
      processPlane: plane,
      termGraceMs: 10,
      killGraceMs: 20,
    });
    const handle = supervisor.spawnGroup(spec("escalation"));
    const stopping = supervisor.stop(handle, "fixture-stop");

    expect(terminate).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(10);
    expect(forceTerminate).toHaveBeenCalledTimes(1);
    child.emitError(new Error("kill transport diagnostic"));
    await vi.advanceTimersByTimeAsync(5);
    child.emitClose(null, "SIGKILL");

    await expect(stopping).resolves.toMatchObject({
      closed: true,
      close: { signal: "SIGKILL" },
      term: { attempted: true },
      kill: { attempted: true },
    });
  });

  it("cuts admissions synchronously and drains every active lease", async () => {
    vi.useFakeTimers();
    const first = makeLease(3);
    const second = makeLease(4);
    const { plane, terminate } = makePlane([first, second]);
    const supervisor = createProbeProcessSupervisor({
      processPlane: plane,
      termGraceMs: 10,
      killGraceMs: 10,
    });
    supervisor.spawnGroup(spec("first"));
    supervisor.spawnGroup(spec("second"));

    const draining = supervisor.shutdown("watchdog");
    expect(supervisor.isQuiescing()).toBe(true);
    expect(terminate).toHaveBeenCalledTimes(2);
    first.emitClose(null, "SIGTERM");
    second.emitClose(null, "SIGTERM");
    await vi.runAllTimersAsync();

    await expect(draining).resolves.toMatchObject({
      clean: true,
      active: [],
      refusedSignals: [],
      groupDrain: { clean: true },
    });
  });

  it("publishes one shutdown flight before a signal callback can re-enter", async () => {
    const child = makeLease(8);
    const { plane, terminate } = makePlane([child]);
    const supervisor = createProbeProcessSupervisor({
      processPlane: plane,
      termGraceMs: 10,
      killGraceMs: 10,
    });
    supervisor.spawnGroup(spec("reentrant shutdown"));
    let reentrant: Promise<ProbeProcessDrainReceipt> | undefined;
    terminate.mockImplementation((_lease, reason) => {
      reentrant = supervisor.shutdown("signal-callback-reentry");
      return attempted("SIGTERM", reason);
    });

    const outer = supervisor.shutdown("outer-shutdown");
    expect(reentrant).toBe(outer);
    child.emitClose(null, "SIGTERM");

    await expect(outer).resolves.toMatchObject({ clean: true });
    expect(plane.drainOnQuit).toHaveBeenCalledTimes(1);
    expect(terminate).toHaveBeenCalledTimes(1);
  });

  it("retains the sandbox when any signal is refused despite a clean group drain", async () => {
    vi.useFakeTimers();
    const first = makeLease(5);
    const second = makeLease(6);
    const { plane } = makePlane([first, second], { refuseGeneration: 5 });
    const supervisor = createProbeProcessSupervisor({
      processPlane: plane,
      termGraceMs: 10,
      killGraceMs: 10,
    });
    supervisor.spawnGroup(spec("refused"));
    supervisor.spawnGroup(spec("accepted"));
    const draining = supervisor.shutdown("watchdog");
    first.emitClose(0, null);
    second.emitClose(0, null);
    await vi.runAllTimersAsync();

    const receipt = await draining;
    expect(receipt.clean).toBe(false);
    expect(receipt.refusedSignals).toHaveLength(1);
    expect(receipt.groupDrain.clean).toBe(true);
    expect(retainProbeSandbox(receipt)).toBe(true);
  });

  it("does not confuse exact leader close with verified group drainage", async () => {
    const child = makeLease(7);
    const { plane } = makePlane([child], {
      drain: {
        clean: false,
        stragglers: [{
          generation: 7,
          source: "test:7",
          purpose: "fixture 7",
          mode: "group",
          state: "leaderless-group",
        }],
      },
    });
    const supervisor = createProbeProcessSupervisor({
      processPlane: plane,
      termGraceMs: 10,
      killGraceMs: 10,
    });
    const handle = supervisor.spawnGroup(spec("leaderless descendant"));
    child.emitClose(0, null);
    await handle.closed;

    const receipt = await supervisor.shutdown("test-complete");
    expect(receipt.active).toEqual([]);
    expect(receipt.clean).toBe(false);
    expect(receipt.groupDrain).toMatchObject({
      clean: false,
      stragglers: [{ state: "leaderless-group" }],
    });
    expect(retainProbeSandbox(receipt)).toBe(true);
  });

  it("retains an unclean sandbox and emits its path plus drain receipt", async () => {
    const prefix = join(tmpdir(), "vellum-probe-supervisor-test-");
    const sandbox = await createProbeSandbox(prefix);
    tempSandboxes.add(sandbox);
    const root = sandbox.root;
    const marker = join(root, "retained.txt");
    await writeFile(marker, "still here\n", "utf8");
    const receipt: ProbeProcessDrainReceipt = {
      clean: false,
      groupDrain: { clean: false, stragglers: [] },
      refusedSignals: [refused("SIGTERM", "cleanup-test")],
      active: [],
    };
    const stderr = vi.spyOn(process.stderr, "write").mockImplementation(() => true);

    await expect(removeProbeSandboxIfClean({
      sandbox,
      receipt,
      label: "test probe",
    })).resolves.toBe(false);

    await expect(readFile(marker, "utf8")).resolves.toBe("still here\n");
    const emitted = stderr.mock.calls.map(([chunk]) => String(chunk)).join("");
    expect(emitted).toContain(root);
    expect(emitted).toContain('"processDrain"');
    expect(emitted).toContain('"attempted":false');
  });

  it("rejects a structural sandbox forgery without touching the minted root", async () => {
    const prefix = join(tmpdir(), "vellum-probe-supervisor-test-");
    const sandbox = await createProbeSandbox(prefix);
    tempSandboxes.add(sandbox);
    const marker = join(sandbox.root, "owned.txt");
    await writeFile(marker, "owned\n", "utf8");
    const forged = Object.freeze({ root: sandbox.root }) as unknown as ProbeSandbox;

    await expect(removeProbeSandboxIfClean({
      sandbox: forged,
      receipt: cleanDrainReceipt,
      label: "forged test probe",
    })).rejects.toThrow("probe sandbox is not registered");
    await expect(readFile(marker, "utf8")).resolves.toBe("owned\n");
  });
});
