import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { Result } from "effect";
import type {
  AppProcessSignalReceipt,
  AppTerminalLease,
} from "../src/main/vellum-command/app-process-plane";
import { homedir } from "node:os";
import { join } from "node:path";
import {
  expandTerminalCwd,
  LocalSessionHost,
  resolveLaunch,
  TerminalLaunchError,
  type LocalTerminalProcessAuthority,
} from "../src/main/vellum-command/term/local-host";
import {
  makeProcessIdentityMap,
  setProcessIdentityMapForTests,
} from "../src/main/vellum-command/process-identity";
import { setProcessEpochReaderForTests } from "../src/main/vellum-command/process-epoch";
import {
  makeFakeTerminalProcessAuthority,
  type FakeTerminalProcessAuthority,
} from "./helpers/fake-terminal-process-authority";
import {
  getCapturedSessionId,
  resetSessionIdStoreForTest,
} from "../src/main/vellum-command/term/session-id-store";
import type {
  PrimeAgentDaemonHandle,
  PrimeAgentDaemons,
} from "../src/main/vellum-command/term/prime-agent-daemon";
import { seatStateRuntime } from "../src/main/vellum-command/term/agent-state";
import { OperatorInterlock } from "../src/main/vellum-command/term/drive/operator-interlock";
import {
  OBSERVER_UNWATCHED_SCROLLBACK,
  OBSERVER_WATCHED_SCROLLBACK,
  TerminalObserverPlane,
} from "../src/main/vellum-command/term/observer";
import { SeatOccupationFailedError } from "../src/shared/terminal-seat-occupancy";
import type { PrimeAgentReporterReport } from "../src/main/vellum-command/term/prime-agent-reporter";

const hosts: LocalSessionHost[] = [];
const syntheticEpochs = new Map<number, string>();

const trackSyntheticPid = (pid: number): number => {
  syntheticEpochs.set(pid, `synthetic-${pid}`);
  return pid;
};

const makeSyntheticIdentityMap = () => makeProcessIdentityMap({
  processAlive: (pid) => pid === process.pid || syntheticEpochs.has(pid),
  readProcessStartKey: (pid) =>
    pid === process.pid ? `self-${pid}` : syntheticEpochs.get(pid),
  readParentPid: () => undefined,
});

beforeEach(() => {
  syntheticEpochs.clear();
  resetSessionIdStoreForTest();
  setProcessEpochReaderForTests({
    snapshot: () => [...syntheticEpochs].map(([pid, startKey]) => ({
      pid,
      processGroupId: Math.max(2, pid - 1),
      sessionId: 7,
      startKey,
    })),
  });
  // LocalSessionHost now treats an anchored identity-bind miss as a security
  // failure. Give synthetic PTYs exact process epochs rather than relying on
  // the production ps reader (which correctly cannot see fake PIDs).
  setProcessIdentityMapForTests(makeSyntheticIdentityMap());
});

afterEach(async () => {
  vi.useRealTimers();
  vi.unstubAllEnvs();
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
  // Most tests here prove occupancy, replay, capture, and receipt ordering —
  // not shutdown timing. Stubborn synthetic fakes (exitOnSignal: false) must
  // not pay the production TERM/KILL/late windows in afterEach cleanup, so
  // the helper defaults to short graces. Shutdown/refusal/escalation proofs
  // pass their own explicit graces, which override these defaults.
  const host = new LocalSessionHost(fake.authority, {
    killGraceMs: 5,
    shutdownGraceMs: 5,
    lateExitGraceMs: 5,
    ...options,
  });
  hosts.push(host);
  return host;
};

type FakeDaemonStartInput = Parameters<
  PrimeAgentDaemons["start"]
>[0];

type FakeDaemonRecord = {
  readonly input: FakeDaemonStartInput;
  readonly handle: PrimeAgentDaemonHandle;
  readonly stopReasons: string[];
  readonly report: (
    report: Omit<PrimeAgentReporterReport, "bindingId" | "epoch">,
  ) => void;
  readonly crash: () => void;
  readonly resolveStop: (clean?: boolean) => void;
  readonly rejectStop: (error: Error) => void;
};

const makeFakeDaemons = (options: {
  readonly manualStop?: boolean;
  readonly stopClean?: boolean;
  readonly daemonPidBase?: number;
  readonly log?: string[];
} = {}): {
  readonly manager: PrimeAgentDaemons;
  readonly records: FakeDaemonRecord[];
  readonly shutdownReasons: string[];
} => {
  const records: FakeDaemonRecord[] = [];
  const shutdownReasons: string[] = [];
  const log = options.log;

  const start: PrimeAgentDaemons["start"] = (input) => {
    const unstopped = records.find(
      (record) =>
        record.input.bindingId === input.bindingId &&
        record.stopReasons.length === 0,
    );
    if (unstopped !== undefined) {
      throw new Error(`fake daemon plane still owns ${input.bindingId}`);
    }
    log?.push(`daemon:start:${input.bindingId}`);
    const daemonPid = trackSyntheticPid(
      (options.daemonPidBase ?? 51_000) + records.length,
    );
    const stopReasons: string[] = [];
    let stopFlight: ReturnType<PrimeAgentDaemonHandle["stop"]> | undefined;
    let resolveManual:
      | ((receipt: Awaited<ReturnType<PrimeAgentDaemonHandle["stop"]>>) => void)
      | undefined;
    let rejectManual: ((error: Error) => void) | undefined;

    const receipt = (
      reason: string,
      clean = options.stopClean ?? true,
    ): Awaited<ReturnType<PrimeAgentDaemonHandle["stop"]>> => ({
      bindingId: input.bindingId,
      epoch: input.epoch,
      reason,
      clean,
      reporterReleased: true,
      rootSessionIds: [],
      stoppedSessionIds: [],
      remainingActiveSessionIds: clean ? [] : ["fake-root"],
      daemonExited: clean,
      directoryRemoved: clean,
      diagnostics: clean
        ? []
        : [{ stage: "stop", message: `fake cleanup failed for ${input.bindingId}` }],
    });

    const stop: PrimeAgentDaemonHandle["stop"] = (reason = "stop") => {
      stopReasons.push(reason);
      log?.push(`daemon:stop:${input.bindingId}:${reason}`);
      if (stopFlight !== undefined) return stopFlight;
      stopFlight = options.manualStop
        ? new Promise((resolve, reject) => {
            resolveManual = resolve;
            rejectManual = reject;
          })
        : Promise.resolve(receipt(reason));
      return stopFlight;
    };

    const env = Object.fromEntries(
      Object.entries(input.launch.env).filter(
        (entry): entry is [string, string] => typeof entry[1] === "string",
      ),
    );
    const handle: PrimeAgentDaemonHandle = {
      bindingId: input.bindingId,
      epoch: input.epoch,
      daemonPid,
      daemonPidForDiagnostics: daemonPid,
      socketPath: `/tmp/fake-prime-${input.bindingId}.sock`,
      terminalLaunch: {
        file: "/bin/sh",
        args: ["--fake-prime-client", input.bindingId],
        cwd: input.launch.cwd,
        env: { ...env, FAKE_PRIME_SOCKET: input.bindingId },
      },
      stop,
    };
    const record: FakeDaemonRecord = {
      input,
      handle,
      stopReasons,
      report: (report) => input.onReport?.({
        bindingId: input.bindingId,
        epoch: input.epoch,
        ...report,
      }),
      crash: () => {
        const cleanup = handle.stop("fake_unexpected_exit");
        input.onUnexpectedExit?.({
          bindingId: input.bindingId,
          epoch: input.epoch,
          daemonPid,
          exit: { code: 1, signal: null },
          stdout: "",
          stderr: "fake daemon crash",
          cleanup,
        });
      },
      resolveStop: (clean = options.stopClean ?? true) => {
        resolveManual?.(receipt(stopReasons[0] ?? "stop", clean));
      },
      rejectStop: (error) => rejectManual?.(error),
    };
    records.push(record);
    return handle;
  };

  const manager: PrimeAgentDaemons = {
    start,
    shutdownAll: vi.fn(async (reason = "shutdown") => {
      shutdownReasons.push(reason);
      log?.push(`daemon:shutdown:${reason}`);
      const receipts = await Promise.all(
        records.map((record) => record.handle.stop(reason)),
      );
      return {
        clean: receipts.every((receipt) => receipt.clean),
        receipts,
      };
    }),
  };
  return { manager, records, shutdownReasons };
};

describe("LocalSessionHost", () => {
  it("uses the explicit shell argv before the ambient user shell", () => {
    const launch = Result.getOrThrow(
      resolveLaunch({ kind: "terminal", launch: { kind: "shell", argv: ["/bin/sh", "-l"] } }),
    );
    expect(launch.file).toBe("/bin/sh");
    expect(launch.args).toEqual(["-l"]);
  });

  it("expands region ~/ cwd paths before spawn (node-pty rejects literal tildes)", () => {
    expect(expandTerminalCwd("~")).toBe(homedir());
    expect(expandTerminalCwd("~/Projects/vellum")).toBe(
      join(homedir(), "Projects/vellum"),
    );
    expect(expandTerminalCwd("/absolute/repo")).toBe("/absolute/repo");

    const launch = Result.getOrThrow(
      resolveLaunch({
        kind: "terminal",
        launch: { kind: "shell", cwd: "~/Projects/vellum" },
      }),
    );
    expect(launch.cwd).toBe(join(homedir(), "Projects/vellum"));
    expect(launch.env.TERM).toMatch(/^(xterm|screen)/);
  });

  it("forces an xterm TERM when the host process runs under TERM=dumb", () => {
    vi.stubEnv("TERM", "dumb");
    const launch = Result.getOrThrow(resolveLaunch({ kind: "terminal" }));
    expect(launch.env.TERM).toBe("xterm-256color");
  });

  it("does not pass ambient NO_COLOR into a managed agent TUI", () => {
    vi.stubEnv("NO_COLOR", "1");
    const launch = Result.getOrThrow(
      resolveLaunch({
        kind: "agent",
        harness: "codex",
        agentKey: "local:codex",
        launch: { kind: "harness", argv: ["codex"] },
      }),
    );

    expect(launch.env.NO_COLOR).toBeUndefined();
    expect(launch.env.TERM).toMatch(/^(xterm|screen)/);
    expect(launch.env.COLORTERM).toBe("truecolor");
    expect(launch.env.COLORFGBG).toBe("15;0");
  });

  it("sets COLORFGBG from the Junto theme mode at spawn", () => {
    const dark = Result.getOrThrow(
      resolveLaunch({ kind: "terminal" }, { themeMode: "dark" }),
    );
    expect(dark.env.COLORFGBG).toBe("15;0");
    const bright = Result.getOrThrow(
      resolveLaunch({ kind: "terminal" }, { themeMode: "bright" }),
    );
    expect(bright.env.COLORFGBG).toBe("0;15");
  });

  it("fails before ownership when the launch cwd is missing", async () => {
    const fake = makeFakeTerminalProcessAuthority(() => ({
      pid: trackSyntheticPid(42_901),
    }));
    const host = hostWith(fake);

    const summary = host.create({
      bindingId: "bad-cwd",
      launch: {
        kind: "shell",
        cwd: join(homedir(), "definitely-missing-vellum-cwd-probe"),
      },
    });

    expect(summary).toMatchObject({ bindingId: "bad-cwd", status: "exited" });
    expect(fake.controllers).toHaveLength(0);
    const attached = await host.attach({ bindingId: "bad-cwd", mode: "observe" });
    expect(attached.ok).toBe(true);
    if (!attached.ok) return;
    expect(
      attached.journal
        .map((entry) => (entry.type === "output" ? entry.data : ""))
        .join(""),
    ).toContain("working directory is not a usable directory");
  });

  it("rejects a missing or non-absolute shell before process spawn", () => {
    expect(() =>
      resolveLaunch({ kind: "terminal", launch: { kind: "shell", argv: ["sh"] } }),
    ).toThrow(TerminalLaunchError);
    expect(() =>
      resolveLaunch({ kind: "terminal", launch: { kind: "shell", argv: ["/no/such/shell"] } }),
    ).toThrow(TerminalLaunchError);
  });

  it("falls through invalid ambient SHELL preferences to the fixed platform shell", () => {
    const fallback = process.platform === "linux" ? "/bin/bash" : "/bin/zsh";

    vi.stubEnv("SHELL", "relative-shell");
    expect(Result.getOrThrow(resolveLaunch({ kind: "terminal" }))).toMatchObject({
      file: fallback,
      args: ["-l"],
    });

    vi.stubEnv("SHELL", "/no/such/user-shell");
    expect(Result.getOrThrow(resolveLaunch({ kind: "terminal" }))).toMatchObject({
      file: fallback,
      args: ["-l"],
    });
  });

  it("resolves an agent seat to its harness argv, and to a failure when it has none", () => {
    const resolved = resolveLaunch({
      kind: "agent",
      harness: "claude",
      agentKey: "local:claude",
      launch: { kind: "harness", argv: ["/usr/local/bin/claude", "--resume"] },
    });
    expect(Result.getOrThrow(resolved)).toMatchObject({
      file: "/usr/local/bin/claude",
      args: [],
    });

    const seatWithoutArgv = resolveLaunch({
      kind: "agent",
      harness: "claude",
      agentKey: "local:claude",
      launch: { kind: "harness" },
    });
    if (!Result.isFailure(seatWithoutArgv)) {
      throw new Error("an agent seat with no argv must not resolve to a launch");
    }
    expect(seatWithoutArgv.failure).toMatchObject({
      code: "agent_launch_unresolvable",
      harness: "claude",
    });
  });

  it("keeps the live seat environment authoritative over a stale launch plan", () => {
    const resolved = Result.getOrThrow(
      resolveLaunch(
        {
          kind: "agent",
          harness: "codex",
          agentKey: "local:codex",
          launch: {
            kind: "harness",
            argv: ["codex"],
            env: {
              PATH: "/installed/bin:/usr/bin",
              JUNTO_SOCKET: "/stale/work.sock",
              CLAUDECODE: "nested",
            },
          },
        },
        {
          seatInject: {
            PATH: "/repo/dist:/usr/bin",
            JUNTO_SOCKET: "/live/work.sock",
          },
        },
      ),
    );

    expect(resolved.env.PATH).toBe("/repo/dist:/usr/bin");
    expect(resolved.env.JUNTO_SOCKET).toBe("/live/work.sock");
    expect(resolved.env.CLAUDECODE).toBeUndefined();
  });

  it("drives an unresolvable agent seat to the error state instead of a login shell", async () => {
    const fake = makeFakeTerminalProcessAuthority(() => ({
      pid: trackSyntheticPid(42_900),
    }));
    const host = hostWith(fake);

    const summary = host.createAgentSeat({
      bindingId: "seat-unresolvable",
      harness: "claude",
      agentKey: "local:claude",
      launch: { kind: "harness" },
    });

    // The state the node renders: exited, never a running shell.
    expect(summary).toMatchObject({ bindingId: "seat-unresolvable", status: "exited" });
    expect(summary.pid).toBeUndefined();
    // No process was ever owned — the seat failed before ownership.
    expect(fake.controllers).toHaveLength(0);
    expect(host.runningCount()).toBe(0);

    const attached = await host.attach({ bindingId: "seat-unresolvable", mode: "observe" });
    expect(attached.ok).toBe(true);
    if (!attached.ok) return;
    expect(attached.status).toBe("exited");
    // Unresolvable launch is spawn_failed with harness display-name copy —
    // never a raw errno dump and never idle "stopped" semantics on the wire.
    expect(summary).toMatchObject({
      exitReason: "spawn_failed",
      exitMessage: "Claude Code failed to start",
    });
    expect(
      attached.journal
        .map((entry) => (entry.type === "output" ? entry.data : ""))
        .join(""),
    ).toContain("Claude Code failed to start");
  });

  it("classifies ENOENT spawn as cli-missing with harness display name", async () => {
    const fake = makeFakeTerminalProcessAuthority(() => {
      throw Object.assign(new Error("spawn claude ENOENT"), { code: "ENOENT" });
    });
    const host = hostWith(fake);

    const summary = host.createAgentSeat({
      bindingId: "seat-cli-missing",
      harness: "claude",
      agentKey: "local:claude",
      launch: { kind: "harness", argv: ["claude"] },
    });

    expect(summary).toMatchObject({
      bindingId: "seat-cli-missing",
      status: "exited",
      exitReason: "cli-missing",
      exitMessage: "Claude Code is not installed on this machine",
    });
    expect(summary.pid).toBeUndefined();
    expect(fake.controllers).toHaveLength(0);

    const attached = await host.attach({
      bindingId: "seat-cli-missing",
      mode: "observe",
    });
    expect(attached.ok).toBe(true);
    if (!attached.ok) return;
    const journal = attached.journal
      .map((entry) => (entry.type === "output" ? entry.data : ""))
      .join("");
    expect(journal).toContain("Claude Code is not installed on this machine");
    expect(journal).toContain("PATH");
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

  it("subscribes before replaying the current live generation", async () => {
    const fake = makeFakeTerminalProcessAuthority((_spec, index) => ({
      pid: trackSyntheticPid(42_425 + index),
    }));
    const host = hostWith(fake);
    const first = host.createAgentSeat({
      bindingId: "replay-running",
      harness: "grok",
      agentKey: "local:grok",
      launch: { kind: "harness", argv: ["/usr/local/bin/grok"] },
    });
    const seen: Array<{
      readonly bindingId: string;
      readonly epoch: string;
      readonly status: string;
    }> = [];

    const unsubscribe = host.subscribeEvents((event) => {
      if (event.type !== "session") return;
      seen.push(event);
    }, { replayCurrentSessions: true });

    expect(seen).toEqual([
      expect.objectContaining({
        bindingId: "replay-running",
        epoch: first.epoch,
        status: "running",
        pid: 42_425,
      }),
    ]);

    fake.controllers[0]?.exit();
    await vi.waitFor(() => expect(host.get("replay-running")?.status).toBe("exited"));
    expect(seen.at(-1)).toMatchObject({
      bindingId: "replay-running",
      epoch: first.epoch,
      status: "exited",
    });
    unsubscribe();
  });

  it("never replays an exited generation as a live session", async () => {
    const fake = makeFakeTerminalProcessAuthority(() => ({
      pid: trackSyntheticPid(42_426),
    }));
    const host = hostWith(fake);
    const exited = host.createAgentSeat({
      bindingId: "replay-exited",
      harness: "grok",
      agentKey: "local:grok",
      launch: { kind: "harness", argv: ["/usr/local/bin/grok"] },
    });
    fake.controllers[0]?.exit();
    await vi.waitFor(() => expect(host.get("replay-exited")?.status).toBe("exited"));
    const seen: Array<{ readonly epoch: string; readonly status: string }> = [];

    const unsubscribe = host.subscribeEvents((event) => {
      if (event.type === "session") seen.push(event);
    }, { replayCurrentSessions: true });

    expect(seen).toEqual([]);
    expect(host.get("replay-exited")?.epoch).toBe(exited.epoch);
    unsubscribe();
  });

  it("starts and exact-binds the Prime Agent daemon before spawning its routed PTY", async () => {
    const order: string[] = [];
    const identities = makeSyntheticIdentityMap();
    setProcessIdentityMapForTests({
      ...identities,
      bindGeneration: (pid, principal) => {
        order.push(`identity:bind:${pid}`);
        return identities.bindGeneration(pid, principal);
      },
    });
    const daemons = makeFakeDaemons({
      daemonPidBase: 52_000,
      log: order,
    });
    const fake = makeFakeTerminalProcessAuthority((spec) => {
      order.push(`terminal:spawn:${spec.command}`);
      return { pid: trackSyntheticPid(52_100), exitOnSignal: "SIGTERM" };
    });
    const host = hostWith(fake, { primeDaemons: daemons.manager });

    host.createAgentSeat({
      bindingId: "prime-ordered",
      harness: "prime-agent",
      agentKey: "local:prime",
      launch: {
        kind: "harness",
        argv: ["/usr/local/bin/prime-agent", "--thinking", "high"],
      },
      canvasName: "factory",
      nodeId: "prime-node",
    });

    expect(order.slice(0, 4)).toEqual([
      "daemon:start:prime-ordered",
      "identity:bind:52000",
      "terminal:spawn:/bin/sh",
      "identity:bind:52100",
    ]);
    expect(fake.controllers[0]?.spec).toMatchObject({
      command: "/bin/sh",
      args: ["--fake-prime-client", "prime-ordered"],
      env: expect.objectContaining({ FAKE_PRIME_SOCKET: "prime-ordered" }),
    });
    expect(identities.snapshot()).toEqual([
      expect.objectContaining({
        pid: 52_000,
        principal: {
          agentKey: "local:prime",
          canvasName: "factory",
          nodeId: "prime-node",
        },
      }),
      expect.objectContaining({
        pid: 52_100,
        principal: {
          agentKey: "local:prime",
          canvasName: "factory",
          nodeId: "prime-node",
        },
      }),
    ]);

    host.kill("prime-ordered");
    await vi.waitFor(() => expect(host.runningCount()).toBe(0));
  });

  it("keeps a partially anchored Prime seat unbound until bindCanvas can bind both generations", async () => {
    const identities = makeSyntheticIdentityMap();
    setProcessIdentityMapForTests(identities);
    const daemons = makeFakeDaemons({ daemonPidBase: 52_200 });
    const fake = makeFakeTerminalProcessAuthority(() => ({
      pid: trackSyntheticPid(52_300),
      exitOnSignal: "SIGTERM",
    }));
    const host = hostWith(fake, { primeDaemons: daemons.manager });

    host.createAgentSeat({
      bindingId: "prime-late-anchor",
      harness: "prime-agent",
      agentKey: "local:late-prime",
      launch: { kind: "harness", argv: ["prime-agent"] },
      canvasName: "factory",
    });
    expect(identities.snapshot()).toEqual([]);

    host.bindCanvas("prime-late-anchor", { canvasName: "factory" });
    expect(identities.snapshot()).toEqual([]);
    host.bindCanvas("prime-late-anchor", {
      canvasName: "factory",
      nodeId: "prime-late-node",
    });
    expect(identities.snapshot().map((entry) => entry.pid)).toEqual([
      52_200,
      52_300,
    ]);
    expect(new Set(
      identities.snapshot().map((entry) => JSON.stringify(entry.principal)),
    ).size).toBe(1);

    host.bindCanvas("prime-late-anchor", null);
    expect(identities.snapshot()).toEqual([]);
    host.kill("prime-late-anchor");
    await vi.waitFor(() => expect(host.runningCount()).toBe(0));
  });

  it("uses generation-fenced structured Prime reports and authoritative session capture", async () => {
    const daemons = makeFakeDaemons({ daemonPidBase: 52_400 });
    const fake = makeFakeTerminalProcessAuthority(() => ({
      pid: trackSyntheticPid(52_500),
      exitOnSignal: "SIGTERM",
    }));
    const host = hostWith(fake, { primeDaemons: daemons.manager });
    const created = host.createAgentSeat({
      bindingId: "prime-report",
      harness: "prime-agent",
      agentKey: "local:prime-report",
      launch: { kind: "harness", argv: ["prime-agent"] },
    });

    daemons.records[0]?.report({
      state: "working",
      reason: "prime_agent_reporter_working",
      sessionPath: "/tmp/prime/sessions/session-from-path.jsonl",
    });
    expect(seatStateRuntime.getState("prime-report")).toBe("working");
    expect(getCapturedSessionId("prime-report")).toBe("session-from-path");

    daemons.records[0]?.report({
      state: "idle",
      reason: "prime_agent_reporter_idle",
      sessionId: "authoritative-session-id",
    });
    expect(seatStateRuntime.getState("prime-report")).toBe("idle");
    expect(getCapturedSessionId("prime-report")).toBe(
      "authoritative-session-id",
    );

    daemons.records[0]?.report({
      state: "idle",
      reason: "prime_agent_reporter_released",
      released: true,
    });
    expect(seatStateRuntime.getState("prime-report")).not.toBe("idle");

    fake.controllers[0]?.exit();
    await vi.waitFor(() => expect(host.get("prime-report")?.status).toBe("exited"));
    expect(getCapturedSessionId("prime-report")).toBeUndefined();
    expect(host.get("prime-report")?.epoch).toBe(created.epoch);
  });

  it("captures a labeled harness session split across PTY chunks without accepting a bare UUID", () => {
    const fake = makeFakeTerminalProcessAuthority(() => ({ pid: trackSyntheticPid(42_430) }));
    const host = hostWith(fake);
    host.createAgentSeat({
      bindingId: "codex-session-capture",
      harness: "codex",
      agentKey: "local:codex",
      launch: { kind: "harness", argv: ["/usr/local/bin/codex"] },
    });

    fake.controllers[0]?.emitData("tool id 550e8400-e29b-41d4-a716-446655440000\nCODEX_");
    fake.controllers[0]?.emitData("THREAD_ID=3e6433af-b0ea-5718-8d29-27a68c9839fb\n");

    expect(getCapturedSessionId("codex-session-capture")).toBe(
      "3e6433af-b0ea-5718-8d29-27a68c9839fb",
    );
  });

  it("kimi spawn welcome card is not a session id; a later Session: line is", () => {
    const fake = makeFakeTerminalProcessAuthority(() => ({
      pid: trackSyntheticPid(42_432),
    }));
    const host = hostWith(fake);
    host.createAgentSeat({
      bindingId: "kimi-session-capture",
      harness: "kimi",
      agentKey: "local:kimi",
      launch: { kind: "harness", argv: ["kimi"] },
    });

    fake.controllers[0]?.emitData(
      "Session:\nNo session yet — one will be created on your first message.\n",
    );
    expect(getCapturedSessionId("kimi-session-capture")).toBeUndefined();

    fake.controllers[0]?.emitData(
      "Session: session_c2da0425-9e75-75e2-bca4-18bff1f2d5cc\n",
    );
    expect(getCapturedSessionId("kimi-session-capture")).toBe(
      "session_c2da0425-9e75-75e2-bca4-18bff1f2d5cc",
    );
  });

  it("keeps client-exit cleanup in the shutdown fence until the Prime stop receipt settles", async () => {
    const identities = makeSyntheticIdentityMap();
    setProcessIdentityMapForTests(identities);
    const daemons = makeFakeDaemons({
      manualStop: true,
      daemonPidBase: 52_600,
    });
    const fake = makeFakeTerminalProcessAuthority(() => ({
      pid: trackSyntheticPid(52_700),
      exitOnSignal: false,
    }));
    const host = hostWith(fake, { primeDaemons: daemons.manager });
    host.createAgentSeat({
      bindingId: "prime-client-exit",
      harness: "prime-agent",
      agentKey: "local:prime-client-exit",
      launch: { kind: "harness", argv: ["prime-agent"] },
      canvasName: "factory",
      nodeId: "prime-client-exit-node",
    });

    fake.controllers[0]?.exit();
    await vi.waitFor(() =>
      expect(host.get("prime-client-exit")?.status).toBe("exited"),
    );
    expect(daemons.records[0]?.stopReasons).toContain("terminal_exit");
    expect(identities.snapshot()).toEqual([]);
    // The PTY is gone, but the exact daemons generation still prevents a
    // false zero-session maintenance cut and remains in the shutdown fence.
    expect(host.runningCount()).toBe(1);
    expect(host.acquireMaintenanceLease()).toMatchObject({
      acquired: false,
      reason: "active_sessions",
      evidence: { activeTerminalSessions: 1 },
    });
    const shutdown = host.shutdownAll("client_exit_cleanup");
    let settled = false;
    void shutdown.then(() => {
      settled = true;
    });
    await Promise.resolve();
    expect(settled).toBe(false);

    daemons.records[0]?.resolveStop();
    await expect(shutdown).resolves.toEqual({ clean: true, stragglers: [] });
    expect(host.runningCount()).toBe(0);
  });

  it("revokes both Prime generations immediately and stops only its PTY when the daemon crashes", async () => {
    const identities = makeSyntheticIdentityMap();
    setProcessIdentityMapForTests(identities);
    const daemons = makeFakeDaemons({
      manualStop: true,
      daemonPidBase: 52_800,
    });
    const fake = makeFakeTerminalProcessAuthority(() => ({
      pid: trackSyntheticPid(52_900),
      exitOnSignal: false,
    }));
    const host = hostWith(fake, {
      primeDaemons: daemons.manager,
      killGraceMs: 100,
    });
    const outputEvents: Array<{
      readonly bindingId: string;
      readonly epoch: string;
      readonly data: string;
    }> = [];
    host.on("event", (event) => {
      if (event.type === "output") outputEvents.push(event);
    });
    const created = host.createAgentSeat({
      bindingId: "prime-crash",
      harness: "prime-agent",
      agentKey: "local:prime-crash",
      launch: { kind: "harness", argv: ["prime-agent"] },
      canvasName: "factory",
      nodeId: "prime-crash-node",
    });
    expect(identities.snapshot()).toHaveLength(2);

    daemons.records[0]?.crash();
    expect(identities.snapshot()).toEqual([]);
    expect(fake.controllers[0]?.signals).toEqual(["SIGTERM"]);
    expect(host.get("prime-crash")?.stopping).toBe(true);
    expect(outputEvents).toMatchObject([
      {
        bindingId: "prime-crash",
        epoch: created.epoch,
        data: expect.stringContaining(
          "Prime Agent daemon exited unexpectedly; stopping client",
        ),
      },
    ]);

    daemons.records[0]?.resolveStop();
    fake.controllers[0]?.exit(1);
    await vi.waitFor(() => expect(host.runningCount()).toBe(0));
  });

  it.each(["daemon", "pty"] as const)(
    "rolls back both Prime processes when the %s exact identity bind fails",
    async (failureAt) => {
      const daemons = makeFakeDaemons({ daemonPidBase: 53_000 });
      const identities = makeSyntheticIdentityMap();
      const ptyPid = 53_100;
      setProcessIdentityMapForTests({
        ...identities,
        bindGeneration: (pid, principal) =>
          (failureAt === "daemon" && pid === 53_000) ||
          (failureAt === "pty" && pid === ptyPid)
            ? undefined
            : identities.bindGeneration(pid, principal),
      });
      const fake = makeFakeTerminalProcessAuthority(() => ({
        pid: trackSyntheticPid(ptyPid),
        exitOnSignal: "SIGTERM",
      }));
      const host = hostWith(fake, { primeDaemons: daemons.manager });
      vi.spyOn(console, "error").mockImplementation(() => undefined);

      const input = {
        bindingId: `prime-bind-fail-${failureAt}`,
        harness: "prime-agent",
        agentKey: `local:prime-bind-fail-${failureAt}`,
        launch: { kind: "harness", argv: ["prime-agent"] },
        canvasName: "factory",
        nodeId: `prime-bind-fail-${failureAt}-node`,
      } as const;

      if (failureAt === "daemon") {
        // Pre-ownership failure: no process was ever owned, so create settles
        // on the exited generation for the node to render.
        const created = host.createAgentSeat(input);
        expect(created.status).toBe("exited");
        expect(fake.controllers).toHaveLength(0);
      } else {
        // Post-spawn failure: the actor occupation rejects fail-closed with a
        // typed failure while the process is torn down exactly as before.
        expect(() => host.createAgentSeat(input)).toThrow(
          SeatOccupationFailedError,
        );
        expect(fake.controllers).toHaveLength(1);
        expect(fake.controllers[0]?.signals).toEqual(["SIGTERM"]);
        await vi.waitFor(() =>
          expect(host.get(input.bindingId)?.status).toBe("exited"),
        );
      }
      expect(daemons.records[0]?.stopReasons.length).toBeGreaterThan(0);
      expect(identities.snapshot()).toEqual([]);
      await vi.waitFor(() => expect(host.runningCount()).toBe(0));
    },
  );

  it("treats duplicate actor-seat create as an idempotent live ensure", async () => {
    const fake = makeFakeTerminalProcessAuthority(() => ({
      pid: trackSyntheticPid(42_440),
      exitOnSignal: "SIGTERM",
    }));
    const host = hostWith(fake);
    const input = {
      bindingId: "stable-agent-seat",
      harness: "claude" as const,
      agentKey: "local:claude",
      launch: { kind: "harness" as const, argv: ["/usr/local/bin/claude"] },
      canvasName: "factory",
      nodeId: "agent-node",
    };

    const initial = host.createAgentSeat(input);
    const duplicate = host.createAgentSeat(input);

    expect(duplicate).toEqual(initial);
    expect(fake.controllers).toHaveLength(1);
    expect(fake.controllers[0]?.signals).toEqual([]);
    expect(host.runningCount()).toBe(1);

    expect(host.kill(input.bindingId)).toBe(true);
    await vi.waitFor(() =>
      expect(host.get(input.bindingId)?.status).toBe("exited"),
    );
    const restarted = host.createAgentSeat(input);

    expect(restarted.epoch).not.toBe(initial.epoch);
    expect(fake.controllers).toHaveLength(2);
    expect(host.runningCount()).toBe(1);
  });

  it("fail-open after an immediately-dead resume settles the binding on the live pin", async () => {
    // Production path (no isolation) — resume argv is allowed.
    const priorHome = process.env.JUNTO_HOME;
    delete process.env.JUNTO_HOME;
    try {
      const fake = makeFakeTerminalProcessAuthority((_spec, index) => ({
        pid: trackSyntheticPid(42_490 + index),
        // First generation is already dead when open attaches exitWitness.
        ...(index === 0 ? { exitImmediately: true as const } : {}),
        exitOnSignal: false,
      }));
      const host = hostWith(fake);
      const bindingId = "fail-open-create-returns-live";
      const created = host.createAgentSeat({
        bindingId,
        harness: "claude",
        agentKey: "local:claude",
        launch: {
          kind: "harness",
          argv: ["claude", "--resume", "dead-session-aaaaaaaa"],
        },
        canvasName: "factory",
        nodeId: "agent-node",
      });
      // exitWitness.then is a microtask even when already resolved — same
      // flush the router awaits after local create so IPC never hands the
      // renderer a stale resume row.
      await Promise.resolve();

      const live = host.get(bindingId);
      expect(live?.status).toBe("running");
      expect(fake.controllers.length).toBeGreaterThanOrEqual(2);
      expect(live?.epoch).not.toBe(created.epoch);
      // Replacement is a fresh pin, never another --resume.
      expect(fake.controllers[1]?.spec.args).not.toContain("--resume");
      expect(fake.controllers[1]?.spec.args).not.toContain("dead-session-aaaaaaaa");
    } finally {
      if (priorHome === undefined) delete process.env.JUNTO_HOME;
      else process.env.JUNTO_HOME = priorHome;
    }
  });

  it("fail-open after a late resume death replaces the binding with a live pin", async () => {
    const priorHome = process.env.JUNTO_HOME;
    delete process.env.JUNTO_HOME;
    try {
      const fake = makeFakeTerminalProcessAuthority((_spec, index) => ({
        pid: trackSyntheticPid(42_495 + index),
        exitOnSignal: false,
      }));
      const host = hostWith(fake);
      const bindingId = "fail-open-late-resume-death";
      const first = host.createAgentSeat({
        bindingId,
        harness: "claude",
        agentKey: "local:claude",
        launch: {
          kind: "harness",
          argv: ["claude", "--resume", "gone-session-bbbbbbbb"],
        },
      });
      expect(first.status).toBe("running");

      fake.controllers[0]?.emitData(
        "Error: No conversation found with the provided resume id\n",
      );
      fake.controllers[0]?.exit(1);

      await vi.waitFor(() => {
        const live = host.get(bindingId);
        expect(live?.status).toBe("running");
        expect(live?.epoch).not.toBe(first.epoch);
      });
      expect(fake.controllers).toHaveLength(2);
      expect(fake.controllers[1]?.spec.args).not.toContain("--resume");

      // ensure / reopen path: create is idempotent on the live pin.
      const again = host.createAgentSeat({
        bindingId,
        harness: "claude",
        agentKey: "local:claude",
        launch: {
          kind: "harness",
          argv: ["claude", "--resume", "gone-session-bbbbbbbb"],
        },
      });
      expect(again.status).toBe("running");
      expect(again.epoch).toBe(host.get(bindingId)?.epoch);
      expect(fake.controllers).toHaveLength(2);
    } finally {
      if (priorHome === undefined) delete process.env.JUNTO_HOME;
      else process.env.JUNTO_HOME = priorHome;
    }
  });

  it("under JUNTO_HOME does not occupy an already occupied pin generation", () => {
    const priorHome = process.env.JUNTO_HOME;
    delete process.env.JUNTO_HOME;
    try {
      const fake = makeFakeTerminalProcessAuthority((_spec, index) => ({
        pid: trackSyntheticPid(42_460 + index),
        exitOnSignal: false,
      }));
      const host = hostWith(fake);
      const bindingId = "isolate-resume-seat";
      const shared = "9b5fd124-24aa-465c-95be-1f05d97f0f77";
      const initial = host.createAgentSeat({
        bindingId,
        harness: "claude",
        agentKey: "local:claude",
        launch: {
          kind: "harness",
          argv: ["claude", "--resume", shared],
        },
        canvasName: "factory",
        nodeId: "agent-node",
      });
      expect(initial.status).toBe("running");
      expect(fake.controllers).toHaveLength(1);

      process.env.JUNTO_HOME = "/tmp/vellum-dev-isolate-create-agent-seat";
      const fresh = "aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee";
      const again = host.createAgentSeat({
        bindingId,
        harness: "claude",
        agentKey: "local:claude",
        launch: {
          kind: "harness",
          argv: ["claude", "--session-id", fresh],
        },
        canvasName: "factory",
        nodeId: "agent-node",
      });
      expect(again.epoch).toBe(initial.epoch);
      expect(fake.controllers).toHaveLength(1);
      expect(fake.controllers[0]?.signals).toEqual([]);
    } finally {
      if (priorHome === undefined) delete process.env.JUNTO_HOME;
      else process.env.JUNTO_HOME = priorHome;
    }
  });

  it("under JUNTO_HOME strips shared resume argv even when create is first open", () => {
    const priorHome = process.env.JUNTO_HOME;
    process.env.JUNTO_HOME = "/tmp/vellum-dev-isolate-strip-resume";
    try {
      const fake = makeFakeTerminalProcessAuthority(() => ({
        pid: trackSyntheticPid(42_470),
        exitOnSignal: false,
      }));
      const host = hostWith(fake);
      const shared = "0c813489-ff73-4f9d-af00-96adc0d63d94";
      host.createAgentSeat({
        bindingId: "strip-resume-seat",
        harness: "grok",
        agentKey: "local:grok",
        launch: {
          kind: "harness",
          argv: ["grok", "-r", shared, "-m", "grok-4.5"],
        },
      });
      expect(fake.controllers).toHaveLength(1);
      const args = fake.controllers[0]?.spec.args ?? [];
      expect(args).not.toContain("-r");
      expect(args).not.toContain(shared);
      expect(args).toEqual(expect.arrayContaining(["--session-id"]));
    } finally {
      if (priorHome === undefined) delete process.env.JUNTO_HOME;
      else process.env.JUNTO_HOME = priorHome;
    }
  });

  it("refuses occupy while a generation is still stopping", () => {
    const fake = makeFakeTerminalProcessAuthority((_spec, index) => ({
      pid: trackSyntheticPid(42_450 + index),
      exitOnSignal: false,
    }));
    const host = hostWith(fake);
    const input = {
      bindingId: "restart-stopping-seat",
      harness: "codex" as const,
      agentKey: "local:codex",
      launch: { kind: "harness" as const, argv: ["/usr/local/bin/codex"] },
      canvasName: "factory",
      nodeId: "codex-node",
    };

    const initial = host.createAgentSeat(input);
    expect(host.kill(input.bindingId)).toBe(true);
    expect(host.get(input.bindingId)).toMatchObject({
      epoch: initial.epoch,
      status: "running",
      stopping: true,
    });

    const again = host.createAgentSeat(input);
    expect(again.epoch).toBe(initial.epoch);
    expect(again.stopping).toBe(true);
    expect(fake.controllers).toHaveLength(1);
    expect(fake.controllers[0]?.signals).toEqual(["SIGTERM"]);
  });

  it("requests Prime cleanup before PTY TERM and makes app quit await the receipt", async () => {
    const order: string[] = [];
    const daemons = makeFakeDaemons({
      manualStop: true,
      daemonPidBase: 53_200,
      log: order,
    });
    const fakeBase = makeFakeTerminalProcessAuthority(() => ({
      pid: trackSyntheticPid(53_300),
      exitOnSignal: "SIGTERM",
    }));
    const authority: LocalTerminalProcessAuthority = {
      ...fakeBase.authority,
      terminate: (lease, reason) => {
        order.push("terminal:term");
        return fakeBase.authority.terminate(lease, reason);
      },
    };
    const host = new LocalSessionHost(authority, {
      primeDaemons: daemons.manager,
      shutdownGraceMs: 100,
      lateExitGraceMs: 100,
    });
    hosts.push(host);
    host.createAgentSeat({
      bindingId: "prime-quit-wait",
      harness: "prime-agent",
      agentKey: "local:prime-quit-wait",
      launch: { kind: "harness", argv: ["prime-agent"] },
      canvasName: "factory",
      nodeId: "prime-quit-wait-node",
    });

    const shutdown = host.shutdownAll("app_quit");
    let settled = false;
    void shutdown.then(() => {
      settled = true;
    });
    await Promise.resolve();
    expect(order.indexOf("daemon:stop:prime-quit-wait:app_quit")).toBeLessThan(
      order.indexOf("terminal:term"),
    );
    expect(daemons.shutdownReasons).toEqual(["app_quit"]);
    expect(settled).toBe(false);

    daemons.records[0]?.resolveStop();
    await expect(shutdown).resolves.toEqual({ clean: true, stragglers: [] });
  });

  it("explicit Prime kill starts daemons cleanup even before a later app-quit drain", async () => {
    const daemons = makeFakeDaemons({
      manualStop: true,
      daemonPidBase: 53_400,
    });
    const fake = makeFakeTerminalProcessAuthority(() => ({
      pid: trackSyntheticPid(53_500),
      exitOnSignal: "SIGTERM",
    }));
    const host = hostWith(fake, {
      primeDaemons: daemons.manager,
      shutdownGraceMs: 100,
      lateExitGraceMs: 100,
    });
    host.createAgentSeat({
      bindingId: "prime-explicit-kill",
      harness: "prime-agent",
      agentKey: "local:prime-explicit-kill",
      launch: { kind: "harness", argv: ["prime-agent"] },
    });

    expect(host.kill("prime-explicit-kill")).toBe(true);
    expect(daemons.records[0]?.stopReasons).toEqual(["explicit_kill"]);
    const shutdown = host.shutdownAll("app_quit_after_kill");
    let settled = false;
    void shutdown.then(() => {
      settled = true;
    });
    await Promise.resolve();
    expect(settled).toBe(false);
    daemons.records[0]?.resolveStop();
    await expect(shutdown).resolves.toEqual({ clean: true, stragglers: [] });
  });

  it("node deletion awaits the exact Prime PTY and daemons receipt", async () => {
    const daemons = makeFakeDaemons({
      manualStop: true,
      daemonPidBase: 53_600,
    });
    const fake = makeFakeTerminalProcessAuthority(() => ({
      pid: trackSyntheticPid(53_700),
      exitOnSignal: "SIGTERM",
    }));
    const host = hostWith(fake, {
      primeDaemons: daemons.manager,
      shutdownGraceMs: 100,
      lateExitGraceMs: 100,
    });
    host.createAgentSeat({
      bindingId: "prime-node-delete",
      harness: "prime-agent",
      agentKey: "local:prime-node-delete",
      launch: { kind: "harness", argv: ["prime-agent"] },
      canvasName: "factory",
      nodeId: "prime-node-delete-node",
    });

    const deletion = host.deleteBinding("prime-node-delete");
    let settled = false;
    void deletion.then(() => {
      settled = true;
    });
    await Promise.resolve();
    expect(daemons.records[0]?.stopReasons).toEqual(["node_delete"]);
    expect(fake.controllers[0]?.signals).toEqual(["SIGTERM"]);
    expect(settled).toBe(false);

    daemons.records[0]?.resolveStop();
    await expect(deletion).resolves.toBe(true);
    expect(host.runningCount()).toBe(0);
  });

  it("keeps two Prime seats isolated across reporter, socket, identity, and crash lifecycle", async () => {
    const identities = makeSyntheticIdentityMap();
    setProcessIdentityMapForTests(identities);
    const daemons = makeFakeDaemons({ daemonPidBase: 53_600 });
    const fake = makeFakeTerminalProcessAuthority((_spec, index) => ({
      pid: trackSyntheticPid(53_700 + index),
      exitOnSignal: false,
    }));
    const host = hostWith(fake, { primeDaemons: daemons.manager });
    for (const suffix of ["a", "b"] as const) {
      host.createAgentSeat({
        bindingId: `prime-${suffix}`,
        harness: "prime-agent",
        agentKey: `local:prime-${suffix}`,
        launch: { kind: "harness", argv: ["prime-agent"] },
        canvasName: "factory",
        nodeId: `prime-${suffix}-node`,
      });
    }
    expect(fake.controllers.map((controller) =>
      controller.spec.env?.FAKE_PRIME_SOCKET,
    )).toEqual(["prime-a", "prime-b"]);
    expect(identities.snapshot()).toHaveLength(4);

    daemons.records[0]?.report({
      state: "working",
      reason: "prime_agent_reporter_working",
      sessionId: "session-a",
    });
    daemons.records[1]?.report({
      state: "idle",
      reason: "prime_agent_reporter_idle",
      sessionId: "session-b",
    });
    expect(getCapturedSessionId("prime-a")).toBe("session-a");
    expect(getCapturedSessionId("prime-b")).toBe("session-b");
    expect(seatStateRuntime.getState("prime-a")).toBe("working");
    expect(seatStateRuntime.getState("prime-b")).toBe("idle");

    daemons.records[0]?.crash();
    expect(fake.controllers[0]?.signals).toEqual(["SIGTERM"]);
    expect(fake.controllers[1]?.signals).toEqual([]);
    expect(host.get("prime-b")).toMatchObject({ status: "running" });
    expect(identities.snapshot().map((entry) => entry.principal.agentKey)).toEqual([
      "local:prime-b",
      "local:prime-b",
    ]);

    fake.controllers[0]?.exit(1);
    host.kill("prime-b");
    fake.controllers[1]?.exit();
    await vi.waitFor(() => expect(host.runningCount()).toBe(0));
  });

  it("fences late old Prime reports and exits from a replacement generation", async () => {
    const identities = makeSyntheticIdentityMap();
    setProcessIdentityMapForTests(identities);
    const sharedPty = trackSyntheticPid(53_900);
    const daemons = makeFakeDaemons({ daemonPidBase: 53_800 });
    const fake = makeFakeTerminalProcessAuthority(() => ({
      pid: sharedPty,
      exitOnSignal: false,
    }));
    const host = hostWith(fake, { primeDaemons: daemons.manager });
    const crashOutputs: string[] = [];
    host.on("event", (event) => {
      if (event.type === "output") crashOutputs.push(event.data);
    });
    const input = {
      bindingId: "prime-replacement",
      harness: "prime-agent" as const,
      agentKey: "local:prime-replacement",
      launch: { kind: "harness" as const, argv: ["prime-agent"] },
      canvasName: "factory",
      nodeId: "prime-replacement-node",
    };

    const old = host.createAgentSeat(input);
    host.kill(input.bindingId);
    // Occupancy law: create refuses a stopping seat. The old generation must
    // fully exit before the binding is vacant for a replacement.
    fake.controllers[0]?.exit();
    await vi.waitFor(() =>
      expect(host.get(input.bindingId)?.status).toBe("exited"),
    );
    const replacement = host.createAgentSeat(input);
    expect(replacement.epoch).not.toBe(old.epoch);
    daemons.records[1]?.report({
      state: "idle",
      reason: "prime_agent_reporter_idle",
      sessionId: "replacement-session",
    });
    daemons.records[0]?.report({
      state: "working",
      reason: "prime_agent_reporter_working",
      sessionId: "stale-old-session",
    });
    expect(getCapturedSessionId(input.bindingId)).toBe("replacement-session");
    daemons.records[0]?.crash();
    expect(fake.controllers[1]?.signals).toEqual([]);
    expect(crashOutputs).toEqual([]);

    await Promise.resolve();
    expect(host.get(input.bindingId)).toMatchObject({
      epoch: replacement.epoch,
      status: "running",
    });
    expect(getCapturedSessionId(input.bindingId)).toBe("replacement-session");
    expect(identities.snapshot().map((entry) => entry.pid)).toEqual([
      53_801,
      53_900,
    ]);

    host.kill(input.bindingId);
    fake.controllers[1]?.exit();
    await vi.waitFor(() => expect(host.runningCount()).toBe(0));
  });

  it("never selects the production daemons singleton for a fake process authority", async () => {
    const fake = makeFakeTerminalProcessAuthority(() => ({
      pid: trackSyntheticPid(54_050),
      exitOnSignal: "SIGTERM",
    }));
    const host = hostWith(fake);
    host.createAgentSeat({
      bindingId: "prime-fake-authority",
      harness: "prime-agent",
      agentKey: "local:prime-fake-authority",
      launch: { kind: "harness", argv: ["/fake/bin/prime-agent"] },
    });

    expect(fake.controllers).toHaveLength(1);
    expect(fake.controllers[0]?.spec.command).toBe("/fake/bin/prime-agent");
    host.kill("prime-fake-authority");
    await vi.waitFor(() => expect(host.runningCount()).toBe(0));
  });

  it("does not start a daemons for non-Prime harnesses", async () => {
    const daemons = makeFakeDaemons({ daemonPidBase: 54_000 });
    const fake = makeFakeTerminalProcessAuthority(() => ({
      pid: trackSyntheticPid(54_100),
      exitOnSignal: "SIGTERM",
    }));
    const host = hostWith(fake, { primeDaemons: daemons.manager });
    host.createAgentSeat({
      bindingId: "codex-no-daemons",
      harness: "codex",
      agentKey: "local:codex-no-daemons",
      launch: { kind: "harness", argv: ["/usr/local/bin/codex"] },
    });

    expect(daemons.records).toHaveLength(0);
    expect(fake.controllers[0]?.spec.command).toBe("/usr/local/bin/codex");
    host.kill("codex-no-daemons");
    await vi.waitFor(() => expect(host.runningCount()).toBe(0));
  });

  it("enforces control leases and routes IO only through the lease facade", async () => {
    const fake = makeFakeTerminalProcessAuthority(() => ({
      pid: trackSyntheticPid(42_500),
      exitOnSignal: "SIGTERM",
    }));
    const host = hostWith(fake);
    host.create({ bindingId: "lease-io" });

    const observer = await host.attach({ bindingId: "lease-io", mode: "observe" });
    expect(observer.ok).toBe(true);
    if (observer.ok) expect(host.write(observer.lease, "blocked")).toBe(false);

    const first = await host.attach({ bindingId: "lease-io", mode: "control" });
    expect(first.ok).toBe(true);
    expect(await host.attach({ bindingId: "lease-io", mode: "control" })).toEqual({
      ok: false,
      message: "control lease held (pass takeover)",
    });
    const takeover = await host.attach({ bindingId: "lease-io", mode: "control", takeover: true });
    expect(takeover.ok).toBe(true);
    if (!takeover.ok) return;

    expect(host.write(takeover.lease, "yes\n")).toBe(true);
    expect(host.resize(takeover.lease, 100, 40)).toBe(true);
    expect(fake.controllers[0]?.writes).toEqual(["yes\n"]);
    expect(fake.controllers[0]?.resizes).toEqual([{ cols: 100, rows: 40 }]);
  });

  it("parks operator writes during a submission hold and replays them in order", async () => {
    const interlock = new OperatorInterlock();
    const fake = makeFakeTerminalProcessAuthority(() => ({
      pid: trackSyntheticPid(42_520),
      exitOnSignal: "SIGTERM",
    }));
    const host = hostWith(fake, { operatorInterlock: interlock });
    host.create({ bindingId: "hold-io" });

    const control = await host.attach({ bindingId: "hold-io", mode: "control" });
    expect(control.ok).toBe(true);
    if (!control.ok) return;

    // While the drive's submission span holds the write path, keystrokes
    // park — nothing reaches the PTY inside a paste envelope.
    interlock.beginHold("hold-io");
    expect(host.write(control.lease, "h")).toBe(true);
    expect(host.write(control.lease, "i")).toBe(true);
    expect(fake.controllers[0]?.writes).toEqual([]);

    // The outermost hold end replays in arrival order through the normal
    // write path — lease, epoch, and phase re-validated at replay time.
    interlock.endHold("hold-io");
    expect(fake.controllers[0]?.writes).toEqual(["h", "i"]);

    // Writes before the hold and after it flow through untouched.
    expect(host.write(control.lease, "!")).toBe(true);
    expect(fake.controllers[0]?.writes).toEqual(["h", "i", "!"]);
  });

  it("operator writes and resizes stamp the interlock latches", async () => {
    const interlock = new OperatorInterlock();
    const fake = makeFakeTerminalProcessAuthority(() => ({
      pid: trackSyntheticPid(42_521),
      exitOnSignal: "SIGTERM",
    }));
    const host = hostWith(fake, { operatorInterlock: interlock });
    host.create({ bindingId: "latch-io" });

    const control = await host.attach({ bindingId: "latch-io", mode: "control" });
    expect(control.ok).toBe(true);
    if (!control.ok) return;

    expect(interlock.gateActive("latch-io")).toBe(false);
    expect(host.write(control.lease, "x")).toBe(true);
    expect(interlock.inputActive("latch-io")).toBe(true);
    expect(host.resize(control.lease, 90, 30)).toBe(true);
    expect(interlock.resizeActive("latch-io")).toBe(true);
  });

  it("retains the observer grid only while a surface lease is painting it", async () => {
    const fake = makeFakeTerminalProcessAuthority(() => ({
      pid: trackSyntheticPid(42_505),
      exitOnSignal: "SIGTERM",
    }));
    const observerPlane = new TerminalObserverPlane();
    const host = hostWith(fake, { observerPlane });
    host.create({ bindingId: "retain-io" });

    const tier = (): number | undefined =>
      observerPlane.get("retain-io")?.scrollbackLines;

    // Nobody is looking: the grid keeps the bounded window.
    expect(tier()).toBe(OBSERVER_UNWATCHED_SCROLLBACK);

    const observe = await host.attach({ bindingId: "retain-io", mode: "observe" });
    expect(observe.ok).toBe(true);
    if (!observe.ok) return;
    expect(tier()).toBe(OBSERVER_WATCHED_SCROLLBACK);

    const control = await host.attach({ bindingId: "retain-io", mode: "control" });
    expect(control.ok).toBe(true);
    if (!control.ok) return;
    expect(observerPlane.surfaceCount("retain-io")).toBe(2);

    // Takeover swaps the control lease without a release call on every path.
    const takeover = await host.attach({
      bindingId: "retain-io",
      mode: "control",
      takeover: true,
    });
    expect(takeover.ok).toBe(true);
    if (!takeover.ok) return;
    expect(observerPlane.surfaceCount("retain-io")).toBe(2);

    host.release(observe.lease);
    // A repeated release must not steal the other viewer's retention.
    host.release(observe.lease);
    expect(observerPlane.surfaceCount("retain-io")).toBe(1);
    expect(tier()).toBe(OBSERVER_WATCHED_SCROLLBACK);

    host.release(takeover.lease);
    expect(observerPlane.surfaceCount("retain-io")).toBe(0);
    expect(tier()).toBe(OBSERVER_UNWATCHED_SCROLLBACK);

    host.kill("retain-io");
    await vi.waitFor(() => expect(host.runningCount()).toBe(0));
  });

  it("delivers factory prompts without taking over the interactive control lease", async () => {
    const fake = makeFakeTerminalProcessAuthority(() => ({
      pid: trackSyntheticPid(42_510),
      exitOnSignal: "SIGTERM",
    }));
    const host = hostWith(fake);
    host.createAgentSeat({
      bindingId: "managed-io",
      harness: "claude",
      agentKey: "local:claude",
      launch: { kind: "harness", argv: ["/usr/local/bin/claude"] },
    });

    const interactive = await host.attach({
      bindingId: "managed-io",
      mode: "control",
    });
    expect(interactive.ok).toBe(true);
    if (!interactive.ok) return;

    expect(host.writeManagedSeat("managed-io", "factory prompt")).toBe(true);
    expect(host.write(interactive.lease, "operator input")).toBe(true);
    expect(fake.controllers[0]?.writes).toEqual([
      "factory prompt",
      "operator input",
    ]);
    expect(fake.controllers[0]?.signals).toEqual([]);

    host.create({ bindingId: "geography" });
    expect(host.writeManagedSeat("geography", "forbidden")).toBe(false);
  });

  it("refuses to occupy an already occupied geography seat", async () => {
    // A fake PTY needs a deterministic start-key witness. Binding the test
    // runner's real pid would make this occupancy test depend on OS ps timing.
    const identities = makeSyntheticIdentityMap();
    setProcessIdentityMapForTests(identities);
    const pid = trackSyntheticPid(43_510);
    const fake = makeFakeTerminalProcessAuthority(() => ({
      pid,
      exitOnSignal: "SIGTERM",
    }));
    const host = hostWith(fake, { killGraceMs: 2 });

    const first = host.create({ bindingId: "replace", canvasName: "main", nodeId: "term" });
    expect(first.status).toBe("running");
    expect(identities.resolve(pid)).toEqual({
      bindingId: "replace",
      canvasName: "main",
      nodeId: "term",
    });
    const occupiedIdentity = identities.snapshot();
    const again = host.create({
      bindingId: "replace",
      canvasName: "main",
      nodeId: "term",
    });
    expect(again.epoch).toBe(first.epoch);
    expect(host.runningCount()).toBe(1);
    expect(fake.controllers).toHaveLength(1);
    expect(fake.controllers[0]?.signals).toEqual([]);
    expect(identities.snapshot()).toEqual(occupiedIdentity);
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

  it("reopens a live PTY only from serialized VT state", async () => {
    const fake = makeFakeTerminalProcessAuthority(() => ({
      pid: trackSyntheticPid(44_150),
    }));
    const host = hostWith(fake);
    host.create({ bindingId: "colored-reopen" });
    fake.controllers[0]?.emitData("\u001b[31mred\u001b[0m\r\n");
    await Promise.resolve();

    const attached = await host.attach({
      bindingId: "colored-reopen",
      mode: "observe",
    });
    expect(attached.ok).toBe(true);
    if (!attached.ok) return;
    expect(attached.screen?.serialized).toContain("\u001b[31mred");
    expect(attached.journal).toEqual([]);
  });

  it("keeps the same serialized VT attach after the raw journal truncates", async () => {
    const fake = makeFakeTerminalProcessAuthority(() => ({
      pid: trackSyntheticPid(44_151),
    }));
    const host = hostWith(fake);
    host.create({ bindingId: "long-reopen" });
    fake.controllers[0]?.emitData("x".repeat(512 * 1024 + 1));
    await Promise.resolve();

    const attached = await host.attach({
      bindingId: "long-reopen",
      mode: "observe",
    });
    expect(attached.ok).toBe(true);
    if (!attached.ok) return;
    expect(attached.screen).toBeDefined();
    expect(attached.journal).toEqual([]);
  });

  it("surfaces bounded daemons-only cleanup debt without claiming PTY authority", async () => {
    const daemons = makeFakeDaemons({
      stopClean: false,
      daemonPidBase: 54_200,
    });
    const fake = makeFakeTerminalProcessAuthority(() => ({
      pid: trackSyntheticPid(54_300),
      exitOnSignal: false,
    }));
    const host = hostWith(fake, {
      primeDaemons: daemons.manager,
      killGraceMs: 0,
      shutdownGraceMs: 2,
      lateExitGraceMs: 2,
    });
    host.createAgentSeat({
      bindingId: "prime-dirty-cleanup",
      harness: "prime-agent",
      agentKey: "local:prime-dirty-cleanup",
      launch: { kind: "harness", argv: ["prime-agent"] },
    });
    fake.controllers[0]?.exit();
    await vi.waitFor(() =>
      expect(host.get("prime-dirty-cleanup")?.status).toBe("exited"),
    );
    await Promise.resolve();
    vi.spyOn(console, "error").mockImplementation(() => undefined);

    const result = await host.shutdownAll("dirty-daemons");
    expect(result.clean).toBe(false);
    if (result.clean) return;
    const seatDebt = result.stragglers.find(
      (straggler) => straggler.bindingId === "prime-dirty-cleanup",
    );
    expect(seatDebt).toMatchObject({
      primeDaemon: {
        daemonPid: 54_200,
        state: "failed",
        message: "stop: fake cleanup failed for prime-dirty-cleanup",
      },
    });
    expect(seatDebt?.ownedPtyOutstanding).toBeUndefined();
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
    const attached = await host.attach({ bindingId: "stubborn", mode: "control" });
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
    expect(await host.attach({ bindingId: "stubborn", mode: "control" })).toEqual({
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
          bindGeneration: () => {
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
