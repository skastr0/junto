import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type {
  AppProcessSignalReceipt,
  AppTerminalLease,
} from "../src/main/vellum/app-process-plane";
import {
  LocalSessionHost,
  resolveLaunch,
  TerminalLaunchError,
  type LocalTerminalProcessAuthority,
} from "../src/main/vellum/term/local-host";
import {
  makeProcessIdentityMap,
  setProcessIdentityMapForTests,
} from "../src/main/vellum/process-identity";
import { setProcessEpochReaderForTests } from "../src/main/vellum/process-epoch";
import {
  makeFakeTerminalProcessAuthority,
  type FakeTerminalProcessAuthority,
} from "./helpers/fake-terminal-process-authority";

const hosts: LocalSessionHost[] = [];
const syntheticEpochs = new Map<number, string>();

const trackSyntheticPid = (pid: number): number => {
  syntheticEpochs.set(pid, `synthetic-${pid}`);
  return pid;
};

beforeEach(() => {
  syntheticEpochs.clear();
  setProcessEpochReaderForTests({
    snapshot: () => [...syntheticEpochs].map(([pid, startKey]) => ({
      pid,
      processGroupId: Math.max(2, pid - 1),
      sessionId: 7,
      startKey,
    })),
  });
});

afterEach(async () => {
  vi.useRealTimers();
  for (const host of hosts.splice(0)) {
    await host.shutdownAll("test_cleanup");
  }
  setProcessEpochReaderForTests(undefined);
  setProcessIdentityMapForTests(undefined);
  vi.restoreAllMocks();
});

const hostWith = (
  fake: FakeTerminalProcessAuthority,
  options: ConstructorParameters<typeof LocalSessionHost>[1] = {},
): LocalSessionHost => {
  const host = new LocalSessionHost(fake.authority, options);
  hosts.push(host);
  return host;
};

describe("LocalSessionHost", () => {
  it("uses the explicit shell argv before the ambient user shell", () => {
    const launch = resolveLaunch({ kind: "shell", argv: ["/bin/sh", "-l"] });
    expect(launch.file).toBe("/bin/sh");
    expect(launch.args).toEqual(["-l"]);
  });

  it("rejects a missing or non-absolute shell before process spawn", () => {
    expect(() => resolveLaunch({ kind: "shell", argv: ["sh"] })).toThrow(
      TerminalLaunchError,
    );
    expect(() => resolveLaunch({ kind: "shell", argv: ["/no/such/shell"] })).toThrow(
      TerminalLaunchError,
    );
  });

  it("delegates terminal spawn to the central authority and observes its exact witness", async () => {
    const fake = makeFakeTerminalProcessAuthority((_spec, index) => ({
      pid: trackSyntheticPid(42_420 + index),
      output: "vellum-pty-ok\n",
      autoExitMs: 10,
    }));
    const host = hostWith(fake);
    const outputs: string[] = [];
    host.on("event", (event) => {
      if (event.type === "output") outputs.push(event.data);
    });

    const summary = host.create({
      bindingId: "bind-test-1",
      launch: { kind: "command", argv: ["/bin/echo", "vellum-pty-ok"] },
      cols: 80,
      rows: 24,
      canvasName: "main",
      nodeId: "n1",
    });

    expect(summary).toMatchObject({
      bindingId: "bind-test-1",
      detached: false,
      pid: 42_420,
      status: "running",
    });
    expect(fake.controllers[0]?.spec).toMatchObject({
      source: "term:bind-test-1",
      command: "/bin/echo",
      args: ["vellum-pty-ok"],
      cols: 80,
      rows: 24,
    });
    expect("kill" in (fake.controllers[0]?.lease.io ?? {})).toBe(false);

    await vi.waitFor(() => expect(host.get("bind-test-1")?.status).toBe("exited"));
    expect(outputs.join("")).toContain("vellum-pty-ok");
    expect(host.runningCount()).toBe(0);
  });

  it("enforces control leases and routes IO only through the lease facade", () => {
    const fake = makeFakeTerminalProcessAuthority(() => ({
      pid: trackSyntheticPid(42_500),
      exitOnSignal: "SIGTERM",
    }));
    const host = hostWith(fake);
    host.create({ bindingId: "lease-io" });

    const observer = host.attach({ bindingId: "lease-io", mode: "observe" });
    expect(observer.ok).toBe(true);
    if (observer.ok) expect(host.write(observer.lease, "blocked")).toBe(false);

    const first = host.attach({ bindingId: "lease-io", mode: "control" });
    expect(first.ok).toBe(true);
    expect(host.attach({ bindingId: "lease-io", mode: "control" })).toEqual({
      ok: false,
      message: "control lease held (pass takeover)",
    });
    const takeover = host.attach({ bindingId: "lease-io", mode: "control", takeover: true });
    expect(takeover.ok).toBe(true);
    if (!takeover.ok) return;

    expect(host.write(takeover.lease, "yes\n")).toBe(true);
    expect(host.resize(takeover.lease, 100, 40)).toBe(true);
    expect(fake.controllers[0]?.writes).toEqual(["yes\n"]);
    expect(fake.controllers[0]?.resizes).toEqual([{ cols: 100, rows: 40 }]);
  });

  it("binds anchored terminal identity and never lets an old generation erase its replacement", async () => {
    const identities = makeProcessIdentityMap();
    setProcessIdentityMapForTests(identities);
    const fake = makeFakeTerminalProcessAuthority(() => ({
      // One real pid lets ProcessIdentityMap bind; both opaque lease
      // generations deliberately share it to exercise late-exit safety.
      pid: process.pid,
      exitOnSignal: false,
    }));
    const host = hostWith(fake, { killGraceMs: 2 });

    const old = host.create({ bindingId: "replace", canvasName: "main", nodeId: "term" });
    const replacement = host.create({
      bindingId: "replace",
      canvasName: "main",
      nodeId: "term",
    });
    expect(host.runningCount()).toBe(2);
    expect(identities.resolve(process.pid)).toMatchObject({ bindingId: "replace" });

    fake.controllers[0]?.exit();
    await Promise.resolve();
    expect(host.get("replace")).toMatchObject({
      epoch: replacement.epoch,
      status: "running",
    });
    expect(old.epoch).not.toBe(replacement.epoch);
    expect(identities.resolve(process.pid)).toMatchObject({ bindingId: "replace" });
    fake.controllers[1]?.exit();
    await Promise.resolve();
    expect(host.runningCount()).toBe(0);
  });

  it("closes create admission synchronously and coalesces concurrent shutdown callers", async () => {
    vi.useFakeTimers();
    const fake = makeFakeTerminalProcessAuthority(() => ({
      pid: trackSyntheticPid(44_000),
      exitOnSignal: false,
    }));
    const host = hostWith(fake, {
      killGraceMs: 2,
      shutdownGraceMs: 8,
      lateExitGraceMs: 8,
    });
    host.create({ bindingId: "single-flight" });
    vi.spyOn(console, "error").mockImplementation(() => undefined);

    const first = host.shutdownAll("first");
    expect(() => host.create({ bindingId: "late-sync" })).toThrow(/shutting down/);
    const second = host.shutdownAll("second");
    expect(second).toBe(first);
    await vi.advanceTimersByTimeAsync(24);

    const [a, b] = await Promise.all([first, second]);
    expect(a).toEqual(b);
    expect(a.clean).toBe(false);
    expect(fake.controllers[0]?.signals).toEqual(["SIGTERM", "SIGKILL"]);
    expect(() => host.create({ bindingId: "late-after-failure" })).toThrow(/shutting down/);

    fake.controllers[0]?.exit();
    await Promise.resolve();
    expect(host.runningCount()).toBe(0);
  });

  it("returns a clean receipt only after every exact terminal witness settles", async () => {
    vi.useFakeTimers();
    const fake = makeFakeTerminalProcessAuthority(() => ({
      pid: trackSyntheticPid(44_100),
      exitOnSignal: false,
    }));
    const host = hostWith(fake, {
      killGraceMs: 5,
      shutdownGraceMs: 10,
      lateExitGraceMs: 30,
    });
    host.create({ bindingId: "late-but-bounded" });

    let settled = false;
    const shutdown = host.shutdownAll("late-window").then((result) => {
      settled = true;
      return result;
    });
    await vi.advanceTimersByTimeAsync(20);
    expect(settled).toBe(false);
    expect(fake.controllers[0]?.signals).toContain("SIGKILL");
    fake.controllers[0]?.exit();

    await expect(shutdown).resolves.toEqual({ clean: true, stragglers: [] });
    expect(host.runningCount()).toBe(0);
    expect(vi.getTimerCount()).toBe(0);
  });

  it("reports resistant terminals with central TERM/KILL receipts and keeps them noninteractive", async () => {
    vi.useFakeTimers();
    const fake = makeFakeTerminalProcessAuthority(() => ({
      pid: trackSyntheticPid(44_200),
      exitOnSignal: false,
    }));
    const host = hostWith(fake, {
      killGraceMs: 2,
      shutdownGraceMs: 8,
      lateExitGraceMs: 8,
    });
    host.create({ bindingId: "stubborn" });
    const attached = host.attach({ bindingId: "stubborn", mode: "control" });
    expect(attached.ok).toBe(true);
    vi.spyOn(console, "error").mockImplementation(() => undefined);

    const shutdown = host.shutdownAll("stubborn-test");
    await vi.advanceTimersByTimeAsync(24);
    const result = await shutdown;

    expect(result).toMatchObject({
      clean: false,
      stragglers: [{
        bindingId: "stubborn",
        pid: 44_200,
        term: { attempted: true, signal: "SIGTERM" },
        kill: { attempted: true, signal: "SIGKILL" },
      }],
    });
    if (attached.ok) {
      expect(host.write(attached.lease, "must-not-write")).toBe(false);
      expect(host.resize(attached.lease, 90, 30)).toBe(false);
    }
    expect(host.attach({ bindingId: "stubborn", mode: "control" })).toEqual({
      ok: false,
      message: "session interaction revoked during stop",
    });
    fake.controllers[0]?.emitData("ignored-after-stop");
    expect(fake.controllers[0]?.writes).toEqual([]);
    fake.controllers[0]?.exit();
    await Promise.resolve();
  });

  it("fails closed when the central authority refuses or throws signal dispatch", async () => {
    vi.useFakeTimers();
    const refused = makeFakeTerminalProcessAuthority(() => ({
      pid: trackSyntheticPid(44_300),
      exitOnSignal: false,
      signalAttempted: false,
      signalFailureReason: "child-epoch-mismatch",
    }));
    const refusedHost = hostWith(refused, {
      killGraceMs: 2,
      shutdownGraceMs: 6,
      lateExitGraceMs: 6,
    });
    refusedHost.create({ bindingId: "refused" });

    const throwing = makeFakeTerminalProcessAuthority(() => ({
      pid: trackSyntheticPid(44_301),
      exitOnSignal: false,
      throwOnSignal: true,
    }));
    const throwingHost = hostWith(throwing, {
      killGraceMs: 2,
      shutdownGraceMs: 6,
      lateExitGraceMs: 6,
    });
    throwingHost.create({ bindingId: "throwing" });
    vi.spyOn(console, "error").mockImplementation(() => undefined);

    const first = refusedHost.shutdownAll("refused");
    const second = throwingHost.shutdownAll("throwing");
    await vi.advanceTimersByTimeAsync(20);

    await expect(first).resolves.toMatchObject({
      clean: false,
      stragglers: [{
        bindingId: "refused",
        term: { attempted: false, decision: { reason: "child-epoch-mismatch" } },
        kill: { attempted: false, decision: { reason: "child-epoch-mismatch" } },
      }],
    });
    await expect(second).resolves.toMatchObject({
      clean: false,
      stragglers: [{ bindingId: "throwing" }],
    });
    expect(refusedHost.runningCount()).toBe(1);
    expect(throwingHost.runningCount()).toBe(1);
    refused.controllers[0]?.exit();
    throwing.controllers[0]?.exit();
    await Promise.resolve();
  });

  it.each(["listener", "identity"] as const)(
    "retains the exact central lease when post-spawn %s setup throws",
    async (failureAt) => {
      const fake = makeFakeTerminalProcessAuthority(() => ({
        pid: trackSyntheticPid(44_400),
        exitOnSignal: false,
      }));
      const host = hostWith(fake, {
        killGraceMs: 2,
        shutdownGraceMs: 6,
        lateExitGraceMs: 6,
      });
      if (failureAt === "listener") {
        host.on("event", (event) => {
          if (event.type === "session" && event.status === "running") {
            throw new Error("running listener failed");
          }
        });
      } else {
        const identities = makeProcessIdentityMap();
        setProcessIdentityMapForTests({
          ...identities,
          bind: () => {
            throw new Error("identity bind failed");
          },
        });
      }
      vi.spyOn(console, "error").mockImplementation(() => undefined);

      const created = host.create({
        bindingId: `post-spawn-${failureAt}`,
        canvasName: "main",
        nodeId: "term-node",
      });
      expect(created.status).toBe("running");
      expect(fake.controllers[0]?.signals[0]).toBe("SIGTERM");
      expect(host.runningCount()).toBe(1);

      const shutdown = host.shutdownAll(`post-spawn-${failureAt}`);
      await new Promise((resolve) => setTimeout(resolve, 22));
      await expect(shutdown).resolves.toMatchObject({ clean: false });
      fake.controllers[0]?.exit();
      await Promise.resolve();
      expect(host.runningCount()).toBe(0);
    },
  );

  it("keeps a rejected exact witness live instead of inventing exit", async () => {
    vi.useFakeTimers();
    let rejectWitness!: (error: Error) => void;
    const witness = new Promise<never>((_resolve, reject) => {
      rejectWitness = reject;
    });
    const lease = {
      io: {
        pidForDiagnostics: 44_500,
        exited: witness,
        write() {},
        resize: undefined,
        onData: () => () => undefined,
        onExit: () => () => undefined,
        onError: () => () => undefined,
      },
    } as unknown as AppTerminalLease;
    const receipt = (signal: "SIGTERM" | "SIGKILL", reason: string): AppProcessSignalReceipt => ({
      signal,
      reason,
      attempted: false,
      decision: { ok: false, reason: "signal-dispatch-failed" },
      via: "none",
    });
    const authority: LocalTerminalProcessAuthority = {
      spawnTerminal: () => lease,
      terminate: (_lease, reason) => receipt("SIGTERM", reason),
      forceTerminate: (_lease, reason) => receipt("SIGKILL", reason),
    };
    const host = new LocalSessionHost(authority, {
      killGraceMs: 2,
      shutdownGraceMs: 6,
      lateExitGraceMs: 6,
    });
    hosts.push(host);
    vi.spyOn(console, "error").mockImplementation(() => undefined);
    host.create({ bindingId: "rejected-witness" });
    rejectWitness(new Error("unexpected witness rejection"));
    await Promise.resolve();

    const shutdown = host.shutdownAll("rejected-witness");
    await vi.advanceTimersByTimeAsync(20);
    await expect(shutdown).resolves.toMatchObject({
      clean: false,
      stragglers: [{ bindingId: "rejected-witness", pid: 44_500 }],
    });
    expect(host.runningCount()).toBe(1);
  });

  it("turns a spawn failure into an exited session without pretending ownership", () => {
    const authority: LocalTerminalProcessAuthority = {
      spawnTerminal: () => {
        throw new Error("spawn refused");
      },
      terminate: () => {
        throw new Error("unreachable");
      },
      forceTerminate: () => {
        throw new Error("unreachable");
      },
    };
    const host = new LocalSessionHost(authority);
    hosts.push(host);

    expect(host.create({ bindingId: "spawn-failed" })).toMatchObject({
      bindingId: "spawn-failed",
      status: "exited",
    });
    expect(host.runningCount()).toBe(0);
  });
});
