import {
  existsSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  statSync,
} from "node:fs";
import { dirname, join } from "node:path";
import { randomUUID } from "node:crypto";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { createAppProcessPlane } from "../src/main/vellum/app-process-plane";
import {
  getProcessIdentityMap,
  setProcessIdentityMapForTests,
  type ProcessPrincipal,
} from "../src/main/vellum/process-identity";
import { seatStateRuntime } from "../src/main/vellum/term/agent-state";
import { LocalSessionHost } from "../src/main/vellum/term/local-host";
import { TerminalObserverPlane } from "../src/main/vellum/term/observer";
import {
  makePrimeAgentCompanionManager,
  type PrimeAgentCompanionUnexpectedExit,
} from "../src/main/vellum/term/prime-agent-companion";
import {
  PrimeAgentReporterPlane,
  primeAgentReporterSocketPath,
} from "../src/main/vellum/term/prime-agent-reporter";
import {
  getCapturedSessionId,
  resetSessionIdStoreForTest,
} from "../src/main/vellum/term/session-id-store";

const FAKE_PRIME_AGENT = fileURLToPath(
  new URL("./fixtures/prime-agent/prime-agent.mjs", import.meta.url),
);
const POLL_INTERVAL_MS = 25;
const POLL_TIMEOUT_MS = 12_000;

type FakeProcessEvent = Readonly<{
  event: string;
  pid: number;
  ppid: number;
  seat?: string;
  [key: string]: unknown;
}>;

const readFakeEvents = (path: string): FakeProcessEvent[] => {
  if (!existsSync(path)) return [];
  return readFileSync(path, "utf8")
    .split("\n")
    .filter((line) => line.trim().length > 0)
    .flatMap((line) => {
      try {
        const decoded = JSON.parse(line) as unknown;
        if (
          typeof decoded === "object" &&
          decoded !== null &&
          "event" in decoded &&
          typeof decoded.event === "string" &&
          "pid" in decoded &&
          typeof decoded.pid === "number" &&
          "ppid" in decoded &&
          typeof decoded.ppid === "number"
        ) {
          return [decoded as FakeProcessEvent];
        }
      } catch {
        // A concurrent append can expose an incomplete final line. Poll again.
      }
      return [];
    });
};

const waitFor = async (
  description: string,
  predicate: () => boolean,
  timeoutMs = POLL_TIMEOUT_MS,
): Promise<void> => {
  const deadline = Date.now() + timeoutMs;
  let lastError: unknown;
  while (Date.now() < deadline) {
    try {
      if (predicate()) return;
      lastError = undefined;
    } catch (error) {
      lastError = error;
    }
    await new Promise<void>((resolve) => setTimeout(resolve, POLL_INTERVAL_MS));
  }
  const detail = lastError instanceof Error ? `: ${lastError.message}` : "";
  throw new Error(`timed out waiting for ${description}${detail}`);
};

const oneEvent = (
  events: readonly FakeProcessEvent[],
  event: string,
  seat: "A" | "B",
): FakeProcessEvent => {
  const matches = events.filter(
    (candidate) => candidate.event === event && candidate.seat === seat,
  );
  expect(matches, `${event} witness for seat ${seat}`).toHaveLength(1);
  return matches[0]!;
};

const stringField = (event: FakeProcessEvent, field: string): string => {
  const value = event[field];
  expect(value, `${event.event}.${field}`).toEqual(expect.any(String));
  return value as string;
};

const numberField = (event: FakeProcessEvent, field: string): number => {
  const value = event[field];
  expect(value, `${event.event}.${field}`).toEqual(expect.any(Number));
  return value as number;
};

const principalFor = (
  agentKey: string,
  canvasName: string,
  nodeId: string,
): ProcessPrincipal => ({ agentKey, canvasName, nodeId });

const sorted = <Value extends string | number>(values: Iterable<Value>): Value[] =>
  [...values].sort((left, right) => String(left).localeCompare(String(right)));

const restoreEnv = (
  before: ReadonlyMap<string, string | undefined>,
): void => {
  for (const [key, value] of before) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
};

describe("Prime Agent two-seat real-process integration", () => {
  it("isolates both resident roots, process identity, reporter state, and scoped cleanup", async () => {
    expect(process.platform === "darwin" || process.platform === "linux").toBe(true);
    expect(statSync(FAKE_PRIME_AGENT).mode & 0o111).not.toBe(0);

    const testRoot = mkdtempSync(join("/tmp", "vc-prime-agent-two-seat-"));
    const logPath = join(testRoot, "fake-prime-agent.ndjson");
    const reporterHome = join(testRoot, "reporter-home");
    const reporterSocket = primeAgentReporterSocketPath(reporterHome);
    const token = randomUUID().replaceAll("-", "").slice(0, 10);
    const bindingA = `prime-agent-seat-a-${token}`;
    const bindingB = `prime-agent-seat-b-${token}`;
    const canvasName = `prime-agent-two-seat-${token}`;
    const agentKeyA = `local:prime-agent-a-${token}`;
    const agentKeyB = `local:prime-agent-b-${token}`;
    const principalA = principalFor(agentKeyA, canvasName, "node-a");
    const principalB = principalFor(agentKeyB, canvasName, "node-b");
    const forbiddenKeys = [
      "PI_CODING_AGENT",
      "PRIME_AGENT_INTERNAL_ROLE",
      "PRIME_AGENT_INTERNAL_PARENT_TOKEN",
      "PRIME_AGENT_INTERNAL_",
    ] as const;
    const priorEnv = new Map<string, string | undefined>(
      forbiddenKeys.map((key) => [key, process.env[key]]),
    );

    const observerPlane = new TerminalObserverPlane();
    const reporterPlane = new PrimeAgentReporterPlane({
      shutdownGraceMs: 100,
      shutdownDeadlineMs: 2_000,
    });
    const processPlane = createAppProcessPlane({
      termGraceMs: 2_000,
      killGraceMs: 2_000,
    });
    const manager = makePrimeAgentCompanionManager({
      processPlane,
      reporterPort: reporterPlane,
      commandTimeoutMs: 4_000,
      commandTermGraceMs: 250,
      commandKillGraceMs: 500,
      daemonTermGraceMs: 2_000,
      daemonKillGraceMs: 1_000,
      listAttempts: 6,
      listRetryMs: 50,
      replacementProbes: 2,
      replacementRetryMs: 50,
    });
    const host = new LocalSessionHost(processPlane, {
      observerPlane,
      companionManager: manager,
      killGraceMs: 1_000,
      shutdownGraceMs: 5_000,
      lateExitGraceMs: 2_000,
    });
    let hostShutdown = false;
    let reporterShutdown = false;
    let processPlaneDrained = false;

    setProcessIdentityMapForTests(undefined);
    const identities = getProcessIdentityMap();
    resetSessionIdStoreForTest();
    for (const key of forbiddenKeys) process.env[key] = `ambient-${key}`;

    try {
      await reporterPlane.start({ home: reporterHome });
      expect(existsSync(reporterSocket)).toBe(true);

      const createSeat = (
        seat: "A" | "B",
        bindingId: string,
        agentKey: string,
        nodeId: string,
      ) => host.createAgentSeat({
        bindingId,
        harness: "prime-agent",
        agentKey,
        canvasName,
        nodeId,
        launch: {
          kind: "harness",
          argv: [FAKE_PRIME_AGENT, "--fake-seat", seat],
          cwd: testRoot,
          env: {
            FAKE_PRIME_AGENT_LOG: logPath,
            FAKE_PRIME_AGENT_SEAT: seat,
            PRIME_AGENT_INTERNAL_LAUNCH_OVERRIDE: `seat-${seat}`,
          },
        },
      });

      const summaryA = createSeat("A", bindingA, agentKeyA, "node-a");
      const summaryB = createSeat("B", bindingB, agentKeyB, "node-b");
      expect(summaryA.status).toBe("running");
      expect(summaryB.status).toBe("running");
      expect(summaryA.pid).not.toBe(summaryB.pid);
      expect(host.runningCount()).toBe(2);

      await waitFor("both Prime Agent workers, tools, clients, and idle reports", () => {
        const events = readFakeEvents(logPath);
        return ["daemon.ready", "client.start", "worker.start", "tool.start", "worker.report"]
          .every((event) =>
            events.filter((entry) => entry.event === event).length === 2
          );
      });

      let events = readFakeEvents(logPath);
      const daemonA = oneEvent(events, "daemon.start", "A");
      const daemonB = oneEvent(events, "daemon.start", "B");
      const clientA = oneEvent(events, "client.start", "A");
      const clientB = oneEvent(events, "client.start", "B");
      const workerA = oneEvent(events, "worker.start", "A");
      const workerB = oneEvent(events, "worker.start", "B");
      const toolA = oneEvent(events, "tool.start", "A");
      const toolB = oneEvent(events, "tool.start", "B");

      const daemonSocketA = stringField(daemonA, "socketPath");
      const daemonSocketB = stringField(daemonB, "socketPath");
      const paneA = stringField(daemonA, "herdrPaneId");
      const paneB = stringField(daemonB, "herdrPaneId");
      const sessionA = stringField(workerA, "sessionId");
      const sessionB = stringField(workerB, "sessionId");
      const activeSessionA = stringField(workerA, "activeSessionId");
      const activeSessionB = stringField(workerB, "activeSessionId");
      const toolPidA = toolA.pid;
      const toolPidB = toolB.pid;

      expect(new Set([daemonSocketA, daemonSocketB]).size).toBe(2);
      expect(new Set([daemonA.pid, daemonB.pid]).size).toBe(2);
      expect(new Set([paneA, paneB]).size).toBe(2);
      expect(new Set([sessionA, sessionB]).size).toBe(2);
      expect(new Set([activeSessionA, activeSessionB]).size).toBe(2);
      expect(new Set([toolPidA, toolPidB]).size).toBe(2);
      expect(stringField(workerA, "pane")).toBe(paneA);
      expect(stringField(workerB, "pane")).toBe(paneB);
      expect(stringField(clientA, "sessionId")).toBe(sessionA);
      expect(stringField(clientB, "sessionId")).toBe(sessionB);
      expect(numberField(workerA, "toolPid")).toBe(toolPidA);
      expect(numberField(workerB, "toolPid")).toBe(toolPidB);
      expect(stringField(daemonA, "reporterSocket")).toBe(reporterSocket);
      expect(stringField(daemonB, "reporterSocket")).toBe(reporterSocket);
      expect(existsSync(daemonSocketA)).toBe(true);
      expect(existsSync(daemonSocketB)).toBe(true);

      for (const event of [daemonA, daemonB, clientA, clientB, workerA, workerB, toolA, toolB]) {
        expect(event.forbiddenEnvKeys, `${event.event} ${event.seat} env`).toEqual([]);
      }

      await waitFor("reporter-owned idle state and structured session capture", () =>
        getCapturedSessionId(bindingA) === sessionA &&
        getCapturedSessionId(bindingB) === sessionB &&
        seatStateRuntime.currentEvents().some((event) =>
          event.bindingId === bindingA &&
          event.state === "idle" &&
          event.reason === "prime_agent_reporter_idle" &&
          event.confidence === "high"
        ) &&
        seatStateRuntime.currentEvents().some((event) =>
          event.bindingId === bindingB &&
          event.state === "idle" &&
          event.reason === "prime_agent_reporter_idle" &&
          event.confidence === "high"
        ));
      expect(seatStateRuntime.getState(bindingA)).toBe("idle");
      expect(seatStateRuntime.getState(bindingB)).toBe("idle");

      expect(identities.size()).toBe(4);
      expect(identities.resolve(toolPidA)).toBeUndefined();
      expect(identities.resolve(toolPidB)).toBeUndefined();
      expect(identities.resolveInTree(toolPidA)).toEqual(principalA);
      expect(identities.resolveInTree(toolPidB)).toEqual(principalB);
      expect(identities.resolveInTree(workerA.pid)).toEqual(principalA);
      expect(identities.resolveInTree(workerB.pid)).toEqual(principalB);
      expect(
        identities.snapshot().filter((entry) => entry.principal.agentKey === agentKeyA),
      ).toHaveLength(2);
      expect(
        identities.snapshot().filter((entry) => entry.principal.agentKey === agentKeyB),
      ).toHaveLength(2);

      expect(events.some((event) =>
        event.event === "worker.stop" && event.seat === "A"
      )).toBe(false);
      expect(host.kill(bindingA)).toBe(true);

      // kill() cuts both exact generation bindings before starting any async
      // root discovery or sending TERM to the PTY capability.
      events = readFakeEvents(logPath);
      expect(events.some((event) =>
        event.event === "worker.stop" && event.seat === "A"
      )).toBe(false);
      expect(identities.size()).toBe(2);
      expect(
        identities.snapshot().every((entry) => entry.principal.agentKey === agentKeyB),
      ).toBe(true);
      expect(identities.resolveInTree(toolPidA)).toBeUndefined();
      expect(identities.resolveInTree(toolPidB)).toEqual(principalB);
      expect(host.get(bindingB)?.status).toBe("running");

      await waitFor("scoped seat A root, terminal, daemon, and directory cleanup", () => {
        const current = readFakeEvents(logPath);
        return current.some((event) =>
          event.event === "command.stop" &&
          event.seat === "A" &&
          event.activeSessionId === activeSessionA &&
          event.socketPath === daemonSocketA
        ) && current.some((event) =>
          event.event === "worker.stop" && event.seat === "A"
        ) && current.some((event) =>
          event.event === "tool.stop" && event.seat === "A"
        ) && current.some((event) =>
          event.event === "client.stop" && event.seat === "A"
        ) && current.some((event) =>
          event.event === "daemon.stop" &&
          event.seat === "A" &&
          event.clean === true
        ) && host.get(bindingA)?.status === "exited" &&
          !existsSync(daemonSocketA) &&
          !existsSync(dirname(daemonSocketA));
      });

      events = readFakeEvents(logPath);
      const stopsBeforeShutdown = events.filter((event) => event.event === "command.stop");
      expect(stopsBeforeShutdown).toHaveLength(1);
      expect(stopsBeforeShutdown[0]).toMatchObject({
        seat: "A",
        socketPath: daemonSocketA,
        activeSessionId: activeSessionA,
      });
      for (const forbiddenBStop of ["command.stop", "worker.stop", "tool.stop", "client.stop", "daemon.signal"]) {
        expect(events.some((event) =>
          event.event === forbiddenBStop && event.seat === "B"
        )).toBe(false);
      }
      expect(existsSync(daemonSocketB)).toBe(true);
      expect(existsSync(reporterSocket)).toBe(true);
      expect(host.get(bindingB)?.status).toBe("running");
      expect(host.runningCount()).toBe(1);
      expect(identities.size()).toBe(2);
      expect(identities.resolveInTree(toolPidB)).toEqual(principalB);

      const hostReceipt = await host.shutdownAll("two_seat_integration_shutdown");
      hostShutdown = true;
      expect(hostReceipt).toEqual({ clean: true, stragglers: [] });
      const reporterReceipt = await reporterPlane.shutdown();
      reporterShutdown = true;
      expect(reporterReceipt.clean).toBe(true);
      expect(reporterReceipt.retainedLabels).toEqual([]);
      const drainReceipt = await processPlane.drainOnQuit();
      processPlaneDrained = true;
      expect(drainReceipt).toEqual({ clean: true, stragglers: [] });

      await waitFor("all fake process stop witnesses and socket removal", () => {
        const current = readFakeEvents(logPath);
        return ["daemon.stop", "client.stop", "worker.stop", "tool.stop"]
          .every((event) => current.filter((entry) => entry.event === event).length === 2) &&
          !existsSync(daemonSocketA) &&
          !existsSync(daemonSocketB) &&
          !existsSync(reporterSocket);
      });

      events = readFakeEvents(logPath);
      expect(events.filter((event) => event.event === "command.stop")).toEqual([
        expect.objectContaining({
          seat: "A",
          socketPath: daemonSocketA,
          activeSessionId: activeSessionA,
        }),
        expect.objectContaining({
          seat: "B",
          socketPath: daemonSocketB,
          activeSessionId: activeSessionB,
        }),
      ]);
      expect(events.filter((event) => event.event === "daemon.stop").every(
        (event) => event.clean === true && event.active === 0,
      )).toBe(true);
      expect(events.filter((event) => event.event === "daemon.root-stop.end").every(
        (event) => event.workerExited === true,
      )).toBe(true);
      expect(events.filter((event) => event.event === "worker.stop").every(
        (event) => event.toolExited === true,
      )).toBe(true);
      expect(events.some((event) =>
        event.event === "command.stop.error" ||
        event.event === "client.error" ||
        event.event === "daemon.error"
      )).toBe(false);

      expect(sorted(events.filter((event) => event.event === "daemon.start").map(
        (event) => stringField(event, "socketPath"),
      ))).toEqual(sorted(events.filter((event) => event.event === "daemon.stop").map(
        (event) => stringField(event, "socketPath"),
      )));
      expect(sorted(events.filter((event) => event.event === "worker.start").map(
        (event) => stringField(event, "activeSessionId"),
      ))).toEqual(sorted(events.filter((event) => event.event === "worker.stop").map(
        (event) => stringField(event, "activeSessionId"),
      )));
      expect(sorted(events.filter((event) => event.event === "tool.start").map(
        (event) => event.pid,
      ))).toEqual(sorted(events.filter((event) => event.event === "tool.stop").map(
        (event) => event.pid,
      )));
      expect(sorted(events.filter((event) => event.event === "client.start").map(
        (event) => event.pid,
      ))).toEqual(sorted(events.filter((event) => event.event === "client.stop").map(
        (event) => event.pid,
      )));

      expect(identities.size()).toBe(0);
      expect(identities.snapshot()).toEqual([]);
      expect(host.runningCount()).toBe(0);
      expect(getCapturedSessionId(bindingA)).toBeUndefined();
      expect(getCapturedSessionId(bindingB)).toBeUndefined();
      expect(existsSync(dirname(daemonSocketA))).toBe(false);
      expect(existsSync(dirname(daemonSocketB))).toBe(false);
      expect(existsSync(reporterSocket)).toBe(false);
    } finally {
      if (!hostShutdown) {
        await host.shutdownAll("two_seat_integration_finally").catch(() => undefined);
      }
      if (!reporterShutdown) {
        await reporterPlane.shutdown().catch(() => undefined);
      }
      if (!processPlaneDrained) {
        await processPlane.drainOnQuit().catch(() => undefined);
      }
      observerPlane.disposeAll();
      seatStateRuntime.unbind(bindingA, undefined, "two_seat_test_cleanup");
      seatStateRuntime.unbind(bindingB, undefined, "two_seat_test_cleanup");
      identities.clear();
      setProcessIdentityMapForTests(undefined);
      resetSessionIdStoreForTest();
      restoreEnv(priorEnv);
      rmSync(testRoot, { recursive: true, force: true });
    }
  }, 30_000);

  it("rejects an installed Prime Agent executable that is not exact 0.7.1", async () => {
    const testRoot = mkdtempSync(join("/tmp", "vc-prime-agent-version-"));
    const reporterHome = join(testRoot, "reporter-home");
    const logPath = join(testRoot, "fake-prime-agent.ndjson");
    const reporterPlane = new PrimeAgentReporterPlane({
      shutdownGraceMs: 100,
      shutdownDeadlineMs: 2_000,
    });
    const processPlane = createAppProcessPlane({
      termGraceMs: 1_000,
      killGraceMs: 1_000,
    });
    const manager = makePrimeAgentCompanionManager({
      processPlane,
      reporterPort: reporterPlane,
      commandTimeoutMs: 500,
      commandTermGraceMs: 50,
      commandKillGraceMs: 100,
      daemonTermGraceMs: 100,
      daemonKillGraceMs: 100,
      listAttempts: 1,
      listRetryMs: 0,
      replacementProbes: 1,
      replacementRetryMs: 10,
    });
    let handleDirectory: string | undefined;
    try {
      await reporterPlane.start({ home: reporterHome });
      let resolveUnexpected!: (
        event: PrimeAgentCompanionUnexpectedExit,
      ) => void;
      const unexpected = new Promise<PrimeAgentCompanionUnexpectedExit>(
        (resolve) => {
          resolveUnexpected = resolve;
        },
      );
      const handle = manager.start({
        bindingId: "prime-agent-version-mismatch",
        epoch: "version-mismatch-epoch",
        launch: {
          file: FAKE_PRIME_AGENT,
          args: ["this prompt must never run"],
          cwd: testRoot,
          env: {
            ...process.env,
            FAKE_PRIME_AGENT_LOG: logPath,
            FAKE_PRIME_AGENT_VERSION: "0.8.0",
          },
        },
        onUnexpectedExit: resolveUnexpected,
      });
      handleDirectory = dirname(handle.socketPath);

      const crash = await unexpected;
      const receipt = await crash.cleanup;
      expect(crash.exit.code).toBe(69);
      expect(crash.stderr).toContain(
        "managed Prime Agent requires exact version 0.7.1 (found: 0.8.0)",
      );
      expect(receipt.clean).toBe(false);
      expect(receipt.diagnostics[0]).toMatchObject({
        stage: "daemon-exit",
        stderr: expect.stringContaining("requires exact version 0.7.1"),
      });
      expect(readFakeEvents(logPath).some((event) =>
        event.event === "daemon.start" || event.event === "client.start"
      )).toBe(false);
      expect(existsSync(handle.socketPath)).toBe(false);

      const managerReceipt = await manager.shutdownAll("version_test_cleanup");
      expect(managerReceipt.clean).toBe(false);
      const reporterReceipt = await reporterPlane.shutdown();
      expect(reporterReceipt.clean).toBe(true);
      const processReceipt = await processPlane.drainOnQuit();
      expect(processReceipt.clean).toBe(true);
    } finally {
      await manager.shutdownAll("version_test_finally").catch(() => undefined);
      await reporterPlane.shutdown().catch(() => undefined);
      await processPlane.drainOnQuit().catch(() => undefined);
      if (handleDirectory !== undefined) {
        rmSync(handleDirectory, { recursive: true, force: true });
      }
      rmSync(testRoot, { recursive: true, force: true });
    }
  }, 10_000);
});
