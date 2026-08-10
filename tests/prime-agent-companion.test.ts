import { existsSync, rmSync } from "node:fs";
import { dirname } from "node:path";
import { PassThrough } from "node:stream";
import { afterEach, describe, expect, it, vi } from "vitest";
import type {
  AppChildIo,
  AppProcessChildSpawnSpec,
  AppProcessExit,
  AppProcessLease,
  AppProcessPlane,
  AppProcessSignalReceipt,
} from "../src/main/vellum/app-process-plane";
import {
  makePrimeAgentCompanionManager,
  type PrimeAgentCompanionHandle,
  type PrimeAgentCompanionProcessPlane,
  type PrimeAgentCompanionUnexpectedExit,
} from "../src/main/vellum/term/prime-agent-companion";
import type {
  PrimeAgentReporterRegisterInput,
  PrimeAgentReporterRegistration,
} from "../src/main/vellum/term/prime-agent-reporter";

type CommandPlan = Readonly<{
  stdout?: string;
  stderr?: string;
  code?: number;
  signal?: NodeJS.Signals | null;
  hang?: boolean;
}>;

class FakeChild {
  readonly stdin = new PassThrough();
  readonly stdout = new PassThrough();
  readonly stderr = new PassThrough();
  readonly exitListeners = new Set<(event: AppProcessExit) => void>();
  readonly closeListeners = new Set<(event: AppProcessExit) => void>();
  readonly errorListeners = new Set<(error: Error) => void>();
  readonly exited: Promise<AppProcessExit>;
  readonly closed: Promise<AppProcessExit>;
  readonly lease: AppProcessLease;
  readonly kind: "daemon" | "command";
  private resolveExit!: (event: AppProcessExit) => void;
  private resolveClose!: (event: AppProcessExit) => void;
  exitEvent: AppProcessExit | undefined;
  closeEvent: AppProcessExit | undefined;
  termExits = true;
  killExits = true;

  constructor(
    readonly spec: AppProcessChildSpawnSpec,
    readonly pid: number,
    kind: "daemon" | "command",
  ) {
    this.kind = kind;
    this.exited = new Promise((resolve) => {
      this.resolveExit = resolve;
    });
    this.closed = new Promise((resolve) => {
      this.resolveClose = resolve;
    });
    const io: AppChildIo = Object.freeze({
      stdin: this.stdin,
      stdout: this.stdout,
      stderr: this.stderr,
      pidForDiagnostics: pid,
      exited: this.exited,
      closed: this.closed,
      onExit: (listener: (event: AppProcessExit) => void) =>
        this.subscribeExit(listener),
      onClose: (listener: (event: AppProcessExit) => void) =>
        this.subscribeClose(listener),
      onError: (listener: (error: Error) => void) => {
        this.errorListeners.add(listener);
        return () => this.errorListeners.delete(listener);
      },
    });
    this.lease = Object.freeze({
      generation: pid,
      source: spec.source,
      purpose: spec.purpose,
      mode: "child",
      io,
    }) as AppProcessLease;
  }

  private subscribeExit(listener: (event: AppProcessExit) => void): () => void {
    if (this.exitEvent !== undefined) {
      listener(this.exitEvent);
      return () => undefined;
    }
    this.exitListeners.add(listener);
    return () => this.exitListeners.delete(listener);
  }

  private subscribeClose(listener: (event: AppProcessExit) => void): () => void {
    if (this.closeEvent !== undefined) {
      listener(this.closeEvent);
      return () => undefined;
    }
    this.closeListeners.add(listener);
    return () => this.closeListeners.delete(listener);
  }

  finish(
    code: number | null = 0,
    signal: NodeJS.Signals | null = null,
    close = true,
  ): void {
    if (this.exitEvent === undefined) {
      const event = Object.freeze({ code, signal });
      this.exitEvent = event;
      this.resolveExit(event);
      for (const listener of [...this.exitListeners]) listener(event);
      this.exitListeners.clear();
    }
    if (close && this.closeEvent === undefined) {
      const event = this.exitEvent!;
      this.stdout.end();
      this.stderr.end();
      this.closeEvent = event;
      this.resolveClose(event);
      for (const listener of [...this.closeListeners]) listener(event);
      this.closeListeners.clear();
    }
  }

  completePlan(plan: CommandPlan): void {
    if (plan.stdout !== undefined) this.stdout.write(plan.stdout);
    if (plan.stderr !== undefined) this.stderr.write(plan.stderr);
    this.finish(plan.code ?? 0, plan.signal ?? null);
  }
}

const signalReceipt = (
  signal: "SIGTERM" | "SIGKILL",
  reason: string,
): AppProcessSignalReceipt =>
  Object.freeze({
    signal,
    reason,
    attempted: true,
    decision: { ok: true as const, mode: "child" as const },
    via: "child.kill" as const,
  });

class FakeProcessPlane {
  readonly events: string[];
  readonly spawns: FakeChild[] = [];
  readonly daemons: FakeChild[] = [];
  readonly commands: FakeChild[] = [];
  readonly commandPlans: CommandPlan[] = [];
  readonly terminations: Array<{
    child: FakeChild;
    reason: string;
  }> = [];
  readonly forceTerminations: Array<{
    child: FakeChild;
    reason: string;
  }> = [];
  private nextPid = 70_000;

  constructor(events: string[] = []) {
    this.events = events;
  }

  enqueue(...plans: CommandPlan[]): void {
    this.commandPlans.push(...plans);
  }

  spawnChild = (spec: AppProcessChildSpawnSpec): AppProcessLease => {
    const isDaemon =
      spec.args?.[0] === "--mode" && spec.args?.[1] === "daemon";
    const child = new FakeChild(
      spec,
      this.nextPid++,
      isDaemon ? "daemon" : "command",
    );
    this.spawns.push(child);
    if (isDaemon) {
      this.events.push(`daemon:${spec.source}`);
      this.daemons.push(child);
    } else {
      this.events.push(`command:${spec.args?.[0] ?? ""}`);
      this.commands.push(child);
      const plan = this.commandPlans.shift() ??
        (spec.args?.[0] === "list"
          ? { stdout: JSON.stringify({ sessions: [] }) }
          : { stdout: JSON.stringify({ stopped: true }) });
      if (!plan.hang) queueMicrotask(() => child.completePlan(plan));
    }
    return child.lease;
  };

  terminate: AppProcessPlane["terminate"] = (lease, reason) => {
    const child = this.childFor(lease);
    this.terminations.push({ child, reason });
    if (child.termExits) child.finish(null, "SIGTERM");
    return signalReceipt("SIGTERM", reason);
  };

  forceTerminate: AppProcessPlane["forceTerminate"] = (lease, reason) => {
    const child = this.childFor(lease);
    this.forceTerminations.push({ child, reason });
    if (child.killExits) child.finish(null, "SIGKILL");
    return signalReceipt("SIGKILL", reason);
  };

  asPort(): PrimeAgentCompanionProcessPlane {
    return {
      spawnChild: this.spawnChild,
      terminate: this.terminate,
      forceTerminate: this.forceTerminate,
    };
  }

  private childFor(
    lease: Parameters<AppProcessPlane["terminate"]>[0],
  ): FakeChild {
    const child = this.spawns.find((candidate) => candidate.lease === lease);
    if (child === undefined) throw new Error("unknown fake lease");
    return child;
  }
}

class FakeReporterPort {
  readonly registrations: Array<{
    input: PrimeAgentReporterRegisterInput;
    registration: PrimeAgentReporterRegistration;
    releases: number;
  }> = [];

  constructor(private readonly events: string[] = []) {}

  register = (
    input: PrimeAgentReporterRegisterInput,
  ): PrimeAgentReporterRegistration => {
    const index = this.registrations.length + 1;
    this.events.push(`register:${input.bindingId}`);
    const entry: {
      input: PrimeAgentReporterRegisterInput;
      registration: PrimeAgentReporterRegistration;
      releases: number;
    } = {
      input,
      registration: undefined as unknown as PrimeAgentReporterRegistration,
      releases: 0,
    };
    const registration = Object.freeze({
      paneId: `pane-${index}`,
      socketPath: `/tmp/fake-prime-agent-reporter-${index}.sock`,
      release: () => {
        entry.releases += 1;
        this.events.push(`release:${input.bindingId}`);
      },
    });
    entry.registration = registration;
    this.registrations.push(entry);
    return registration;
  };
}

const liveRoot = (activeSessionId: string) => ({
  activeSessionId,
  runtimeKind: "top-level",
  rlmDepth: 0,
});

const testOptions = (
  plane: FakeProcessPlane,
  reporter: FakeReporterPort,
) => ({
  processPlane: plane.asPort(),
  reporterPort: reporter,
  commandTimeoutMs: 50,
  commandTermGraceMs: 1,
  commandKillGraceMs: 1,
  daemonTermGraceMs: 5,
  daemonKillGraceMs: 5,
  listAttempts: 1,
  listRetryMs: 0,
  replacementProbes: 1,
  replacementRetryMs: 0,
});

const launch = (overrides: Partial<{
  file: string;
  args: readonly string[];
  cwd: string;
  env: Readonly<NodeJS.ProcessEnv>;
}> = {}) => ({
  file: overrides.file ?? "/opt/bin/prime-agent",
  args: overrides.args ?? ["--model", "provider/model"],
  cwd: overrides.cwd ?? "/tmp",
  env: overrides.env ?? { PATH: "/opt/bin:/usr/bin" },
});

const mintedDirectories = new Set<string>();
const remember = (handle: PrimeAgentCompanionHandle): void => {
  mintedDirectories.add(dirname(handle.socketPath));
};

afterEach(() => {
  for (const path of mintedDirectories) {
    rmSync(path, { recursive: true, force: true });
  }
  mintedDirectories.clear();
});

describe("Prime Agent companion manager", () => {
  it("registers before daemon spawn and returns unique isolated wrapper launches", async () => {
    const events: string[] = [];
    const plane = new FakeProcessPlane(events);
    const reporter = new FakeReporterPort(events);
    const manager = makePrimeAgentCompanionManager(
      testOptions(plane, reporter),
    );
    const authoredArgs = [
      "--model",
      "model with spaces",
      "; touch /tmp/not-interpolated",
    ];
    const inheritedEnv = {
      PATH: "/opt/bin:/usr/bin",
      SAFE_VALUE: "kept",
      PI_CODING_AGENT: "nested",
      PRIME_AGENT_INTERNAL_ROLE: "worker",
      PRIME_AGENT_INTERNAL_: "also-private",
      HERDR_ENV: "ambient",
      HERDR_SOCKET_PATH: "/tmp/wrong.sock",
      HERDR_PANE_ID: "wrong-pane",
    };

    const first = manager.start({
      bindingId: "seat-a",
      epoch: "epoch-a",
      launch: launch({ args: authoredArgs, env: inheritedEnv }),
    });
    const second = manager.start({
      bindingId: "seat-b",
      epoch: "epoch-b",
      launch: launch({ args: ["--thinking", "high"] }),
    });
    remember(first);
    remember(second);

    expect(events.slice(0, 4)).toEqual([
      "register:seat-a",
      "daemon:term:prime-agent:seat-a",
      "register:seat-b",
      "daemon:term:prime-agent:seat-b",
    ]);
    expect(first.socketPath).not.toBe(second.socketPath);
    expect(first.socketPath).toMatch(/vc-pa-[^/]+\/daemon\.sock$/u);
    expect(existsSync(dirname(first.socketPath))).toBe(true);

    const daemon = plane.daemons[0]!;
    expect(daemon.spec.command).toBe("/opt/bin/prime-agent");
    expect(daemon.spec.args).toEqual([
      "--mode",
      "daemon",
      "--daemon-socket",
      first.socketPath,
    ]);
    expect(daemon.spec.isolateProcessGroup).toBe(true);
    expect(daemon.spec.cwd).toBe("/tmp");
    expect(daemon.spec.env).toMatchObject({
      PATH: "/opt/bin:/usr/bin",
      SAFE_VALUE: "kept",
      HERDR_ENV: "1",
      HERDR_SOCKET_PATH: "/tmp/fake-prime-agent-reporter-1.sock",
      HERDR_PANE_ID: "pane-1",
    });
    expect(daemon.spec.env).not.toHaveProperty("PI_CODING_AGENT");
    expect(daemon.spec.env).not.toHaveProperty("PRIME_AGENT_INTERNAL_ROLE");
    expect(daemon.spec.env).not.toHaveProperty("PRIME_AGENT_INTERNAL_");

    const terminal = first.terminalLaunch;
    expect(terminal.file).toBe("/bin/sh");
    expect(terminal.cwd).toBe("/tmp");
    expect(terminal.env).toEqual(daemon.spec.env);
    expect(terminal.args.slice(0, 5)).toEqual([
      "-c",
      expect.any(String),
      "vellum-command-prime-agent",
      "/opt/bin/prime-agent",
      first.socketPath,
    ]);
    expect(terminal.args.slice(5)).toEqual(authoredArgs);
    const wrapper = terminal.args[1]!;
    expect(wrapper).toContain(
      '"$prime_agent" list --json --daemon-socket "$socket_path"',
    );
    expect(wrapper).toContain(
      'exec "$prime_agent" --daemon-socket "$socket_path" "$@"',
    );
    expect(wrapper).toContain('while [ "$attempt" -lt 3 ]');
    expect(wrapper.indexOf(" list --json ")).toBeLessThan(
      wrapper.indexOf("exec "),
    );
    expect(wrapper).not.toContain("; touch /tmp/not-interpolated");
    expect(wrapper).not.toContain(first.socketPath);
    expect(wrapper).toContain("Vellum Command:");

    await first.stop("test_cleanup");
    await second.stop("test_cleanup");
    expect(existsSync(dirname(first.socketPath))).toBe(false);
    expect(existsSync(dirname(second.socketPath))).toBe(false);
  });

  it("selects only top-level depth-zero full ids and uses scoped public commands", async () => {
    const plane = new FakeProcessPlane();
    const reporter = new FakeReporterPort();
    const manager = makePrimeAgentCompanionManager(
      testOptions(plane, reporter),
    );
    const handle = manager.start({
      bindingId: "seat-roots",
      epoch: "epoch-roots",
      launch: launch(),
    });
    remember(handle);
    plane.enqueue(
      {
        stdout: JSON.stringify({
          sessions: [
            liveRoot("root-full-id"),
            {
              activeSessionId: "child-id",
              runtimeKind: "subagent",
              rlmDepth: 1,
            },
            {
              activeSessionId: "wrong-depth",
              runtimeKind: "top-level",
              rlmDepth: 1,
            },
            { id: "saved-only", runtimeKind: "top-level", rlmDepth: 0 },
          ],
        }),
      },
      { stdout: JSON.stringify({ stopped: "root-full-id" }) },
      { stdout: JSON.stringify({ sessions: [] }) },
    );

    const receipt = await handle.stop("renderer_stop");

    expect(receipt.clean).toBe(true);
    expect(receipt.rootSessionIds).toEqual(["root-full-id"]);
    expect(receipt.stoppedSessionIds).toEqual(["root-full-id"]);
    expect(receipt.remainingActiveSessionIds).toEqual([]);
    expect(plane.commands.map((child) => child.spec.args)).toEqual([
      ["list", "--json", "--daemon-socket", handle.socketPath],
      [
        "stop",
        "root-full-id",
        "--json",
        "--daemon-socket",
        handle.socketPath,
      ],
      ["list", "--json", "--daemon-socket", handle.socketPath],
    ]);
    const everyArg = plane.commands.flatMap((child) => child.spec.args ?? []);
    expect(everyArg).not.toContain("status");
    expect(everyArg).not.toContain("doctor");
    expect(everyArg).not.toContain("shutdown");
    expect(plane.terminations.map(({ child }) => child)).toEqual([
      plane.daemons[0],
    ]);
  });

  it("coalesces repeated stop and escalates only the retained daemon lease", async () => {
    const plane = new FakeProcessPlane();
    const reporter = new FakeReporterPort();
    const manager = makePrimeAgentCompanionManager(
      testOptions(plane, reporter),
    );
    const handle = manager.start({
      bindingId: "seat-escalate",
      epoch: "epoch-escalate",
      launch: launch(),
    });
    remember(handle);
    const daemon = plane.daemons[0]!;
    daemon.termExits = false;

    const first = handle.stop("exact_stop");
    const second = handle.stop("ignored_duplicate_reason");
    expect(second).toBe(first);
    const receipt = await first;

    expect(receipt.clean).toBe(true);
    expect(receipt.term?.signal).toBe("SIGTERM");
    expect(receipt.kill?.signal).toBe("SIGKILL");
    expect(reporter.registrations[0]!.releases).toBe(1);
    expect(plane.terminations).toHaveLength(1);
    expect(plane.terminations[0]!.child).toBe(daemon);
    expect(plane.forceTerminations).toHaveLength(1);
    expect(plane.forceTerminations[0]!.child).toBe(daemon);
    expect(plane.forceTerminations[0]!.child.spec.args).toEqual([
      "--mode",
      "daemon",
      "--daemon-socket",
      handle.socketPath,
    ]);
  });

  it("returns a bounded partial-failure receipt without terminating a nonempty scope", async () => {
    const plane = new FakeProcessPlane();
    const reporter = new FakeReporterPort();
    const manager = makePrimeAgentCompanionManager(
      testOptions(plane, reporter),
    );
    const handle = manager.start({
      bindingId: "seat-partial",
      epoch: "epoch-partial",
      launch: launch(),
    });
    remember(handle);
    plane.enqueue(
      { stdout: JSON.stringify({ sessions: [liveRoot("root-stuck")] }) },
      { code: 1, stderr: "x".repeat(100_000) },
      { stdout: JSON.stringify({ sessions: [liveRoot("root-stuck")] }) },
    );

    const receipt = await handle.stop("partial_failure");

    expect(receipt.clean).toBe(false);
    expect(receipt.reporterReleased).toBe(true);
    expect(receipt.rootSessionIds).toEqual(["root-stuck"]);
    expect(receipt.stoppedSessionIds).toEqual([]);
    expect(receipt.remainingActiveSessionIds).toEqual(["root-stuck"]);
    expect(receipt.daemonExited).toBe(false);
    expect(receipt.directoryRemoved).toBe(false);
    expect(plane.terminations).toEqual([]);
    expect(plane.forceTerminations).toEqual([]);
    expect(existsSync(dirname(handle.socketPath))).toBe(true);
    const stopFailure = receipt.diagnostics.find(
      (diagnostic) => diagnostic.stage === "stop",
    );
    expect(stopFailure?.stderrTruncated).toBe(true);
    expect(Buffer.byteLength(stopFailure?.stderr ?? "", "utf8")).toBeLessThanOrEqual(
      64 * 1024,
    );
  });

  it("rejects an unbounded or unsafe active id instead of reusing it as argv", async () => {
    const plane = new FakeProcessPlane();
    const reporter = new FakeReporterPort();
    const manager = makePrimeAgentCompanionManager(
      testOptions(plane, reporter),
    );
    const handle = manager.start({
      bindingId: "seat-invalid-id",
      epoch: "epoch-invalid-id",
      launch: launch(),
    });
    remember(handle);
    plane.enqueue({
      stdout: JSON.stringify({
        sessions: [liveRoot(`-${"x".repeat(300)}`)],
      }),
    });

    const receipt = await handle.stop("invalid_roster");

    expect(receipt.clean).toBe(false);
    expect(plane.commands).toHaveLength(1);
    expect(plane.commands[0]!.spec.args?.[0]).toBe("list");
    expect(plane.terminations).toEqual([]);
    expect(receipt.diagnostics[0]?.message).toContain("sessions array");
  });

  it("on unexpected exit waits for a replacement, stops its roots, and never adopts it", async () => {
    const plane = new FakeProcessPlane();
    const reporter = new FakeReporterPort();
    const manager = makePrimeAgentCompanionManager(
      testOptions(plane, reporter),
    );
    const onUnexpectedExit = vi.fn<
      (event: PrimeAgentCompanionUnexpectedExit) => void
    >();
    const handle = manager.start({
      bindingId: "seat-crash",
      epoch: "epoch-crash",
      launch: launch(),
      onUnexpectedExit,
    });
    remember(handle);
    plane.enqueue(
      { code: 1, stderr: "socket unavailable" },
      { stdout: JSON.stringify({ sessions: [liveRoot("replacement-root")] }) },
      { stdout: JSON.stringify({ stopped: "replacement-root" }) },
      { stdout: JSON.stringify({ sessions: [] }) },
      { code: 1, stderr: "replacement exited" },
    );
    const retainedDaemon = plane.daemons[0]!;
    retainedDaemon.stderr.write("foreground daemon crashed");
    retainedDaemon.finish(9, null);

    await vi.waitFor(() => expect(onUnexpectedExit).toHaveBeenCalledOnce());
    const event = onUnexpectedExit.mock.calls[0]![0];
    const receipt = await event.cleanup;

    expect(event.bindingId).toBe("seat-crash");
    expect(event.epoch).toBe("epoch-crash");
    expect(event.daemonPid).toBe(handle.daemonPid);
    expect(event.exit.code).toBe(9);
    expect(event.stderr).toContain("foreground daemon crashed");
    expect(receipt.clean).toBe(true);
    expect(receipt.rootSessionIds).toEqual(["replacement-root"]);
    expect(receipt.stoppedSessionIds).toEqual(["replacement-root"]);
    expect(receipt.directoryRemoved).toBe(true);
    expect(receipt.diagnostics[0]?.stage).toBe("daemon-exit");
    expect(plane.daemons).toEqual([retainedDaemon]);
    expect(plane.terminations).toEqual([]);
    expect(plane.forceTerminations).toEqual([]);
    expect(plane.commands.map((child) => child.spec.args?.[0])).toEqual([
      "list",
      "list",
      "stop",
      "list",
      "list",
    ]);
    expect(reporter.registrations[0]!.releases).toBe(1);
  });

  it("keeps the crash convergence window open past the stock 1.5 second relaunch", async () => {
    vi.useFakeTimers();
    try {
      const plane = new FakeProcessPlane();
      const reporter = new FakeReporterPort();
      const quick = testOptions(plane, reporter);
      const {
        replacementProbes: _replacementProbes,
        replacementRetryMs: _replacementRetryMs,
        ...withDefaultReplacementWindow
      } = quick;
      const manager = makePrimeAgentCompanionManager(
        withDefaultReplacementWindow,
      );
      const onUnexpectedExit = vi.fn<
        (event: PrimeAgentCompanionUnexpectedExit) => void
      >();
      const handle = manager.start({
        bindingId: "seat-delayed-replacement",
        epoch: "epoch-delayed-replacement",
        launch: launch(),
        onUnexpectedExit,
      });
      remember(handle);
      plane.enqueue(
        { code: 1, stderr: "initial socket absent" },
        { code: 1, stderr: "absent at 500ms" },
        { code: 1, stderr: "absent at 1000ms" },
        { code: 1, stderr: "absent at 1500ms" },
        {
          stdout: JSON.stringify({
            sessions: [liveRoot("late-replacement-root")],
          }),
        },
        { stdout: JSON.stringify({ stopped: "late-replacement-root" }) },
        { stdout: JSON.stringify({ sessions: [] }) },
        { code: 1, stderr: "replacement absent 1" },
        { code: 1, stderr: "replacement absent 2" },
        { code: 1, stderr: "replacement absent 3" },
        { code: 1, stderr: "replacement absent 4" },
        { code: 1, stderr: "replacement absent 5" },
        { code: 1, stderr: "replacement absent 6" },
      );
      plane.daemons[0]!.finish(1, null);
      await Promise.resolve();
      expect(onUnexpectedExit).toHaveBeenCalledOnce();
      const cleanup = onUnexpectedExit.mock.calls[0]![0].cleanup;
      let settled = false;
      void cleanup.then(() => {
        settled = true;
      });

      await vi.advanceTimersByTimeAsync(1_500);
      expect(settled).toBe(false);
      expect(existsSync(dirname(handle.socketPath))).toBe(true);
      expect(plane.commands.every((child) => child.spec.args?.[0] === "list"))
        .toBe(true);

      await vi.advanceTimersByTimeAsync(3_500);
      const receipt = await cleanup;
      expect(receipt.clean).toBe(true);
      expect(receipt.stoppedSessionIds).toEqual(["late-replacement-root"]);
      expect(receipt.directoryRemoved).toBe(true);
      expect(plane.commands.map((child) => child.spec.args?.[0])).toEqual([
        "list",
        "list",
        "list",
        "list",
        "list",
        "stop",
        "list",
        "list",
        "list",
        "list",
        "list",
        "list",
        "list",
      ]);
    } finally {
      vi.useRealTimers();
    }
  });

  it("keeps the directory and returns dirty when crash convergence cannot prove roots gone", async () => {
    const plane = new FakeProcessPlane();
    const reporter = new FakeReporterPort();
    const manager = makePrimeAgentCompanionManager(
      testOptions(plane, reporter),
    );
    const onUnexpectedExit = vi.fn<
      (event: PrimeAgentCompanionUnexpectedExit) => void
    >();
    const handle = manager.start({
      bindingId: "seat-crash-unknown",
      epoch: "epoch-crash-unknown",
      launch: launch(),
      onUnexpectedExit,
    });
    remember(handle);
    plane.enqueue(
      { code: 1, stderr: "not ready" },
      { code: 1, stderr: "still absent" },
    );
    plane.daemons[0]!.finish(1, null);

    await vi.waitFor(() => expect(onUnexpectedExit).toHaveBeenCalledOnce());
    const receipt = await onUnexpectedExit.mock.calls[0]![0].cleanup;

    expect(receipt.clean).toBe(false);
    expect(receipt.directoryRemoved).toBe(false);
    expect(existsSync(dirname(handle.socketPath))).toBe(true);
    expect(receipt.diagnostics.some((diagnostic) =>
      diagnostic.message.includes("could not be proven gone")
    )).toBe(true);
    expect(plane.terminations).toEqual([]);
  });

  it("shutdownAll stops every exact handle and closes further admission", async () => {
    const plane = new FakeProcessPlane();
    const reporter = new FakeReporterPort();
    const manager = makePrimeAgentCompanionManager(
      testOptions(plane, reporter),
    );
    const first = manager.start({
      bindingId: "seat-one",
      epoch: "epoch-one",
      launch: launch(),
    });
    const second = manager.start({
      bindingId: "seat-two",
      epoch: "epoch-two",
      launch: launch(),
    });
    remember(first);
    remember(second);

    const receipt = await manager.shutdownAll("test_app_quit");

    expect(receipt.clean).toBe(true);
    expect(receipt.receipts).toHaveLength(2);
    expect(receipt.receipts.map((item) => item.bindingId).sort()).toEqual([
      "seat-one",
      "seat-two",
    ]);
    expect(new Set(plane.terminations.map(({ child }) => child))).toEqual(
      new Set(plane.daemons),
    );
    expect(reporter.registrations.map((entry) => entry.releases)).toEqual([
      1,
      1,
    ]);
    expect(() => manager.start({
      bindingId: "seat-three",
      epoch: "epoch-three",
      launch: launch(),
    })).toThrow("closing");
  });
});
