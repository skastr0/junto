import {
  chmodSync,
  existsSync,
  lstatSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { createConnection, type Socket } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { LocalSessionHost } from "../src/main/vellum-command/term/local-host";
import {
  TermPlane,
  termPlaneBlocksAppExit,
  type TermPrimeAgentReporterPlane,
} from "../src/main/vellum-command/term/plane";
import { termControlSocketPath } from "../src/shared/term-control";
import { makeFakeTerminalProcessAuthority } from "./helpers/fake-terminal-process-authority";
import {
  PRIME_AGENT_REPORTER_MAX_LINE_BYTES,
  PRIME_AGENT_REPORTER_MAX_MESSAGE_BYTES,
  PrimeAgentReporterPlane,
  type PrimeAgentReporterReport,
} from "../src/main/vellum-command/term/prime-agent-reporter";
import { SeatStateRuntime } from "../src/main/vellum-command/term/agent-state/runtime";
import type { ObserverGridSnapshot } from "../src/main/vellum-command/term/observer/types";

const cleanups: Array<() => Promise<void> | void> = [];

afterEach(async () => {
  vi.useRealTimers();
  while (cleanups.length > 0) await cleanups.pop()?.();
});

const reporterHome = (): string => {
  const home = mkdtempSync(join(tmpdir(), "vpr-"));
  cleanups.push(() => rmSync(home, { recursive: true, force: true }));
  return home;
};

const request = (
  paneId: string,
  seq: number,
  state: "idle" | "working" | "blocked" = "idle",
  extra: Record<string, unknown> = {},
): Record<string, unknown> => ({
  id: `request-${seq}`,
  method: "pane.report_agent",
  params: {
    pane_id: paneId,
    source: "herdr:pi",
    agent: "prime-agent",
    state,
    seq,
    ...extra,
  },
});

const exchangeRaw = (
  socketPath: string,
  payload: Buffer | string,
): Promise<Record<string, unknown>> =>
  new Promise((resolve, reject) => {
    const socket: Socket = createConnection({ path: socketPath });
    let response = "";
    socket.setEncoding("utf8");
    socket.once("connect", () => socket.write(payload));
    socket.on("data", (chunk: string) => {
      response += chunk;
    });
    socket.once("error", reject);
    socket.once("end", () => {
      try {
        resolve(JSON.parse(response.trim()) as Record<string, unknown>);
      } catch (error) {
        reject(error);
      }
    });
  });

const exchange = (
  socketPath: string,
  payload: unknown,
): Promise<Record<string, unknown>> =>
  exchangeRaw(socketPath, `${JSON.stringify(payload)}\n`);

const expectOk = (response: Record<string, unknown>, id: string): void => {
  expect(response).toEqual({ id, result: { type: "ok" } });
};

const errorCode = (response: Record<string, unknown>): unknown =>
  (response.error as { code?: unknown } | undefined)?.code;

describe("PrimeAgentReporterPlane", () => {
  it("requires readiness, mints generation-specific panes, and hardens one socket", async () => {
    const plane = new PrimeAgentReporterPlane();
    const home = reporterHome();
    expect(() =>
      plane.register({
        bindingId: "before",
        epoch: "e0",
        onReport: () => undefined,
      }),
    ).toThrow(/not accepting/);

    await plane.start({ home });
    const first = plane.register({
      bindingId: "b1",
      epoch: "e1",
      onReport: () => undefined,
    });
    const second = plane.register({
      bindingId: "b1",
      epoch: "e2",
      onReport: () => undefined,
    });
    expect(first.paneId).not.toBe(second.paneId);
    expect(first.socketPath).toBe(second.socketPath);
    expect(lstatSync(first.socketPath).isSocket()).toBe(true);
    expect(lstatSync(first.socketPath).mode & 0o777).toBe(0o600);

    first.release();
    second.release();
    await expect(plane.shutdown()).resolves.toMatchObject({ clean: true });
    expect(existsSync(first.socketPath)).toBe(false);
  });

  it("does not reopen registration when shutdown wins a concurrent start", async () => {
    const plane = new PrimeAgentReporterPlane();
    const home = reporterHome();
    const starting = plane.start({ home });
    plane.beginShutdown();
    const shuttingDown = plane.shutdown();

    await starting;
    await expect(shuttingDown).resolves.toMatchObject({ clean: true });
    expect(existsSync(join(home, ".vellum-command", "term", "pa.sock"))).toBe(
      false,
    );
    expect(() =>
      plane.register({
        bindingId: "late",
        epoch: "e1",
        onReport: () => undefined,
      }),
    ).toThrow(/not accepting/);
  });

  it("accepts the exact 0.7.1 lifecycle, derives UUID session ids, and releases", async () => {
    const plane = new PrimeAgentReporterPlane();
    const home = reporterHome();
    await plane.start({ home });
    const reports: PrimeAgentReporterReport[] = [];
    const registration = plane.register({
      bindingId: "agent-seat",
      epoch: "epoch-1",
      onReport: (report) => reports.push(report),
    });
    cleanups.push(async () => {
      await plane.shutdown();
    });

    const sessionId = "123e4567-e89b-12d3-a456-426614174000";
    const sessionPath = `/tmp/prime/sessions/${sessionId}.jsonl`;
    expectOk(
      await exchange(
        registration.socketPath,
        request(registration.paneId, 1, "idle", {
          agent_session_path: sessionPath,
        }),
      ),
      "request-1",
    );
    expectOk(
      await exchange(
        registration.socketPath,
        request(registration.paneId, 2, "working", {
          agent_session_id: sessionId,
        }),
      ),
      "request-2",
    );
    expectOk(
      await exchange(
        registration.socketPath,
        request(registration.paneId, 3, "blocked", {
          message: "Approve shell command",
        }),
      ),
      "request-3",
    );
    expect(reports.slice(0, 3)).toEqual([
      {
        bindingId: "agent-seat",
        epoch: "epoch-1",
        state: "idle",
        reason: "prime_agent_reporter_idle",
        sessionId,
        sessionPath,
      },
      {
        bindingId: "agent-seat",
        epoch: "epoch-1",
        state: "working",
        reason: "prime_agent_reporter_working",
        sessionId,
      },
      {
        bindingId: "agent-seat",
        epoch: "epoch-1",
        state: "attention",
        reason: "prime_agent_reporter_blocked",
        message: "Approve shell command",
      },
    ]);

    const released = await exchange(registration.socketPath, {
      id: "release-4",
      method: "pane.release_agent",
      params: {
        pane_id: registration.paneId,
        source: "herdr:pi",
        agent: "prime-agent",
        seq: 4,
      },
    });
    expectOk(released, "release-4");
    expect(reports.at(-1)).toMatchObject({
      bindingId: "agent-seat",
      epoch: "epoch-1",
      state: "idle",
      reason: "prime_agent_reporter_released",
      released: true,
    });

    const late = await exchange(
      registration.socketPath,
      request(registration.paneId, 5, "working"),
    );
    expect(errorCode(late)).toBe("unknown_pane");
    expect(reports).toHaveLength(4);
  });

  it("rejects wrong authority, malformed fields, and stale seq without moving state", async () => {
    const plane = new PrimeAgentReporterPlane();
    const home = reporterHome();
    await plane.start({ home });
    const reports: PrimeAgentReporterReport[] = [];
    const registration = plane.register({
      bindingId: "b1",
      epoch: "e1",
      onReport: (report) => reports.push(report),
    });
    cleanups.push(async () => {
      await plane.shutdown();
    });

    const wrongPane = request("another-pane", 1, "working");
    expect(errorCode(await exchange(registration.socketPath, wrongPane))).toBe(
      "unknown_pane",
    );
    const wrongSource = request(registration.paneId, 1, "working");
    (wrongSource.params as Record<string, unknown>).source = "other";
    expect(errorCode(await exchange(registration.socketPath, wrongSource))).toBe(
      "invalid_source",
    );
    const wrongAgent = request(registration.paneId, 1, "working");
    (wrongAgent.params as Record<string, unknown>).agent = "pi";
    expect(errorCode(await exchange(registration.socketPath, wrongAgent))).toBe(
      "invalid_agent",
    );
    const relativePath = request(registration.paneId, 1, "working", {
      agent_session_path: "relative/session.jsonl",
    });
    expect(errorCode(await exchange(registration.socketPath, relativePath))).toBe(
      "invalid_session_path",
    );
    const oversizedMessage = request(registration.paneId, 1, "blocked", {
      message: "x".repeat(PRIME_AGENT_REPORTER_MAX_MESSAGE_BYTES + 1),
    });
    expect(
      errorCode(await exchange(registration.socketPath, oversizedMessage)),
    ).toBe("invalid_message");
    expect(reports).toHaveLength(0);

    expectOk(
      await exchange(
        registration.socketPath,
        request(registration.paneId, 10, "working"),
      ),
      "request-10",
    );
    expect(errorCode(await exchange(
      registration.socketPath,
      request(registration.paneId, 10, "idle"),
    ))).toBe("stale_sequence");
    expect(reports.map((report) => report.state)).toEqual(["working"]);

    // An invalid packet never consumes the next sequence.
    const invalidState = request(registration.paneId, 11, "idle");
    (invalidState.params as Record<string, unknown>).state = "done";
    expect(errorCode(await exchange(registration.socketPath, invalidState))).toBe(
      "invalid_state",
    );
    expectOk(
      await exchange(
        registration.socketPath,
        request(registration.paneId, 11, "idle"),
      ),
      "request-11",
    );
    expect(reports.map((report) => report.state)).toEqual([
      "working",
      "idle",
    ]);
  });

  it("bounds malformed and oversized lines without invoking a registration", async () => {
    const plane = new PrimeAgentReporterPlane();
    const home = reporterHome();
    await plane.start({ home });
    const onReport = vi.fn();
    const registration = plane.register({
      bindingId: "b1",
      epoch: "e1",
      onReport,
    });
    cleanups.push(async () => {
      await plane.shutdown();
    });

    expect(errorCode(await exchangeRaw(
      registration.socketPath,
      "{not-json}\n",
    ))).toBe("invalid_request");
    expect(errorCode(await exchangeRaw(
      registration.socketPath,
      `${"x".repeat(PRIME_AGENT_REPORTER_MAX_LINE_BYTES + 1)}\n`,
    ))).toBe("request_too_large");
    expect(onReport).not.toHaveBeenCalled();
  });

  it("handle release is idempotent and late packets cannot reclaim its generation", async () => {
    const plane = new PrimeAgentReporterPlane();
    const home = reporterHome();
    await plane.start({ home });
    const reports: PrimeAgentReporterReport[] = [];
    const registration = plane.register({
      bindingId: "b1",
      epoch: "old",
      onReport: (report) => reports.push(report),
    });
    cleanups.push(async () => {
      await plane.shutdown();
    });

    registration.release();
    registration.release();
    expect(reports).toEqual([
      {
        bindingId: "b1",
        epoch: "old",
        state: "idle",
        reason: "prime_agent_reporter_released",
        released: true,
      },
    ]);
    expect(errorCode(await exchange(
      registration.socketPath,
      request(registration.paneId, 1, "working"),
    ))).toBe("unknown_pane");
    expect(reports).toHaveLength(1);
  });

  it("drains accepted peers and removes only its owned socket", async () => {
    const plane = new PrimeAgentReporterPlane({
      shutdownGraceMs: 10,
      shutdownDeadlineMs: 200,
    });
    const home = reporterHome();
    await plane.start({ home });
    const registration = plane.register({
      bindingId: "b1",
      epoch: "e1",
      onReport: () => undefined,
    });
    const peer = createConnection({ path: registration.socketPath });
    await new Promise<void>((resolve, reject) => {
      peer.once("connect", resolve);
      peer.once("error", reject);
    });

    plane.beginShutdown();
    await expect(plane.shutdown()).resolves.toMatchObject({
      clean: true,
      retainedClients: 0,
      retainedListener: false,
      retainedSocketPath: false,
    });
    expect(peer.destroyed).toBe(true);
    expect(existsSync(registration.socketPath)).toBe(false);
  });

  it("preserves a foreign replacement and converges after it is removed", async () => {
    const plane = new PrimeAgentReporterPlane({
      shutdownGraceMs: 5,
      shutdownDeadlineMs: 50,
    });
    const home = reporterHome();
    await plane.start({ home });
    const registration = plane.register({
      bindingId: "b1",
      epoch: "e1",
      onReport: () => undefined,
    });
    const path = registration.socketPath;
    unlinkSync(path);
    writeFileSync(path, "foreign", "utf8");
    chmodSync(path, 0o600);

    const first = await plane.shutdown();
    expect(first.clean).toBe(false);
    expect(first.retainedLabels).toContain("replacement-path");
    expect(readFileSync(path, "utf8")).toBe("foreign");

    unlinkSync(path);
    await expect(plane.shutdown()).resolves.toMatchObject({
      clean: true,
      retainedLabels: [],
    });
  });
});

const snapshot = (
  epoch: string,
  options: {
    readonly title?: string;
    readonly osc9?: string;
    readonly lines?: readonly string[];
    readonly seq?: bigint;
  } = {},
): ObserverGridSnapshot => {
  const lines = options.lines ?? [];
  return {
    bindingId: "b1",
    epoch,
    cols: 80,
    rows: 24,
    lines,
    text: lines.join("\n"),
    seq: options.seq ?? 1n,
    signals: {
      title: options.title ?? "",
      osc9: options.osc9 ?? "",
      modes: {
        bracketedPaste: false,
        synchronizedOutput: false,
        altScreen: true,
        mouseModes: [],
      },
    },
  };
};

describe("SeatStateRuntime structured full-lifecycle hooks", () => {
  it("keeps structured state dominant over every screen tick until release", () => {
    const runtime = new SeatStateRuntime({ turnProgressWatch: false });
    runtime.bindHarness("b1", "prime-agent", "e1");

    expect(runtime.observeStructuredHook({
      bindingId: "b1",
      epoch: "e1",
      state: "working",
      reason: "prime_agent_reporter_working",
    })).toMatchObject({ state: "working", epoch: "e1" });

    expect(runtime.observe(snapshot("e1", {
      title: "prime-agent - session - cwd",
      osc9: "4;0",
      lines: ["ready for input"],
      seq: 2n,
    }))).toBeNull();
    expect(runtime.getState("b1")).toBe("working");

    expect(runtime.observeStructuredHook({
      bindingId: "b1",
      epoch: "e1",
      state: "attention",
      reason: "prime_agent_reporter_blocked",
    })).toMatchObject({ state: "attention" });
    expect(runtime.observe(snapshot("e1", {
      osc9: "4;0",
      lines: ["ready"],
      seq: 3n,
    }))).toBeNull();
    expect(runtime.getState("b1")).toBe("attention");

    expect(runtime.clearStructuredHook(
      "b1",
      "e1",
      "prime_agent_reporter_released",
    )).toMatchObject({ state: "idle", epoch: "e1" });
    expect(runtime.getState("b1")).toBe("idle");
    runtime.stop();
  });

  it("generation-fences structured observe, clear, and old screen packets", () => {
    const runtime = new SeatStateRuntime({ turnProgressWatch: false });
    runtime.bindHarness("b1", "prime-agent", "old");
    runtime.observeStructuredHook({
      bindingId: "b1",
      epoch: "old",
      state: "working",
      reason: "old-working",
    });

    runtime.bindHarness("b1", "prime-agent", "new");
    expect(runtime.getState("b1")).toBe("unknown");
    expect(runtime.observeStructuredHook({
      bindingId: "b1",
      epoch: "old",
      state: "attention",
      reason: "late-old",
    })).toBeNull();
    expect(runtime.clearStructuredHook("b1", "old")).toBeNull();
    expect(runtime.observe(snapshot("old", {
      osc9: "4;3",
      seq: 10n,
    }))).toBeNull();
    expect(runtime.getState("b1")).toBe("unknown");

    expect(runtime.observeStructuredHook({
      bindingId: "b1",
      epoch: "new",
      state: "idle",
      reason: "new-idle",
    })).toMatchObject({ state: "idle", epoch: "new" });
    expect(runtime.clearStructuredHook("b1", "old")).toBeNull();
    expect(runtime.getState("b1")).toBe("idle");
    runtime.stop();
  });

  it("does not let the heuristic progress watchdog override full lifecycle", async () => {
    vi.useFakeTimers();
    const runtime = new SeatStateRuntime({ turnStallMs: 5 });
    runtime.bindHarness("b1", "prime-agent", "e1");
    runtime.observeStructuredHook({
      bindingId: "b1",
      epoch: "e1",
      state: "working",
      reason: "prime_agent_reporter_working",
    });

    await vi.advanceTimersByTimeAsync(50);
    expect(runtime.getState("b1")).toBe("working");
    expect(runtime.isTurnStalled("b1")).toBe(false);
    runtime.stop();
  });
});


const cleanReporterReceipt = Object.freeze({
  clean: true,
  retainedClients: 0,
  retainedListener: false,
  retainedSocketPath: false,
  retainedLabels: Object.freeze([]),
  diagnostics: Object.freeze([]),
});

const isolatedHost = (): LocalSessionHost =>
  new LocalSessionHost(
    makeFakeTerminalProcessAuthority(() => ({
      pid: undefined,
      exitOnSignal: "SIGTERM",
    })).authority,
    {
      primeDaemons: null,
      killGraceMs: 5,
      shutdownGraceMs: 5,
      lateExitGraceMs: 5,
    },
  );

describe("TermPlane Prime Agent reporter lifecycle", () => {
  it("awaits reporter readiness before publishing terminal control", async () => {
    const home = reporterHome();
    let releaseStart!: () => void;
    const startGate = new Promise<void>((resolve) => {
      releaseStart = resolve;
    });
    const reporter: TermPrimeAgentReporterPlane = {
      start: vi.fn(() => startGate),
      beginShutdown: vi.fn(),
      shutdown: vi.fn(async () => cleanReporterReceipt),
    };
    const plane = new TermPlane(isolatedHost(), reporter);

    const starting = plane.start({ controlHome: home });
    await vi.waitFor(() => expect(reporter.start).toHaveBeenCalledOnce());
    expect(existsSync(termControlSocketPath(home))).toBe(false);

    releaseStart();
    await starting;
    expect(existsSync(termControlSocketPath(home))).toBe(true);
    await expect(plane.drainOnQuit("test")).resolves.toMatchObject({
      clean: true,
      reporter: { clean: true },
    });
  });

  it("contains reporter startup failure to Prime seats while control still opens", async () => {
    const home = reporterHome();
    const startupError = new Error("synthetic reporter bind failure");
    const reporter: TermPrimeAgentReporterPlane = {
      start: vi.fn(async () => {
        throw startupError;
      }),
      beginShutdown: vi.fn(),
      shutdown: vi.fn(async () => cleanReporterReceipt),
    };
    const plane = new TermPlane(isolatedHost(), reporter);

    await expect(plane.start({ controlHome: home })).resolves.toBeUndefined();
    expect(existsSync(termControlSocketPath(home))).toBe(true);
    const receipt = await plane.drainOnQuit("test");
    expect(receipt.retainedLabels).toContain("prime-agent-reporter-start");
    expect(receipt.diagnostics.join(" ")).toContain(
      "synthetic reporter bind failure",
    );
    expect(termPlaneBlocksAppExit(receipt)).toBe(false);
  });

  it("retires the reporter only after LocalSessionHost cleanup settles", async () => {
    let resolveLocal!: (value: { clean: true; stragglers: [] }) => void;
    const localGate = new Promise<{ clean: true; stragglers: [] }>((resolve) => {
      resolveLocal = resolve;
    });
    const host = isolatedHost();
    vi.spyOn(host, "shutdownAll").mockReturnValue(localGate);
    const beginShutdown = vi.fn();
    const reporter: TermPrimeAgentReporterPlane = {
      start: vi.fn(async () => undefined),
      beginShutdown,
      shutdown: vi.fn(async () => cleanReporterReceipt),
    };
    const plane = new TermPlane(host, reporter);

    const draining = plane.drainOnQuit("test");
    await Promise.resolve();
    expect(beginShutdown).not.toHaveBeenCalled();
    resolveLocal({ clean: true, stragglers: [] });
    await expect(draining).resolves.toMatchObject({ clean: true });
    expect(beginShutdown).toHaveBeenCalledOnce();
  });

  it("diagnoses daemon-only debt without turning it into an exit trap", async () => {
    const host = isolatedHost();
    vi.spyOn(host, "shutdownAll").mockResolvedValue({
      clean: false,
      stragglers: [
        {
          bindingId: "prime-agent-daemon-manager",
          epoch: "shutdown",
          status: "running",
          primeDaemon: {
            state: "manager_failed",
            message: "unowned replacement still answers",
          },
        },
      ],
    });
    const reporter: TermPrimeAgentReporterPlane = {
      start: vi.fn(async () => undefined),
      beginShutdown: vi.fn(),
      shutdown: vi.fn(async () => cleanReporterReceipt),
    };
    const receipt = await new TermPlane(host, reporter).drainOnQuit("test");

    expect(receipt.clean).toBe(false);
    expect(receipt.retainedLabels).toContain("prime-agent-daemon");
    expect(receipt.diagnostics.join(" ")).toContain("manager_failed");
    expect(termPlaneBlocksAppExit(receipt)).toBe(false);
    expect(
      termPlaneBlocksAppExit({
        clean: false,
        local: {
          clean: false,
          stragglers: [
            {
              bindingId: "owned",
              epoch: "e1",
              status: "running",
              ownedPtyOutstanding: true,
            },
          ],
        },
        retainedLabels: [],
        diagnostics: [],
      }),
    ).toBe(true);
  });
});
