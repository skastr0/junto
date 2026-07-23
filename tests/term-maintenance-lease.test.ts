import { mkdtempSync, rmSync } from "node:fs";
import { createConnection } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  decodeTermMaintenanceAcquirePayload,
  decodeTermMaintenanceReleasePayload,
  decodeTermMaintenanceRequest,
  TERM_MAINTENANCE_MAX_ACTIVE_SESSIONS,
  type TermControlResponse,
} from "../src/shared/term-control";
import {
  type TermControlMaintenanceLease,
  TermControlClient,
} from "../src/main/vellum/term/control-client";
import {
  startTermControlServer,
  type TermControlServer,
} from "../src/main/vellum/term/control-server";
import { LocalSessionHost } from "../src/main/vellum/term/local-host";
import {
  makeProcessIdentityMap,
  setProcessIdentityMapForTests,
} from "../src/main/vellum/process-identity";
import { setProcessEpochReaderForTests } from "../src/main/vellum/process-epoch";
import {
  makeFakeTerminalProcessAuthority,
  type FakeTerminalProcessAuthority,
} from "./helpers/fake-terminal-process-authority";

interface TestRig {
  readonly home: string;
  readonly fake: FakeTerminalProcessAuthority;
  readonly host: LocalSessionHost;
  readonly server: TermControlServer;
  readonly connect: () => Promise<TermControlClient>;
  readonly dispose: () => Promise<void>;
}

const rigs: TestRig[] = [];

const delay = (durationMs: number): Promise<void> =>
  new Promise((resolve) => setTimeout(resolve, durationMs));

const waitUntil = async (predicate: () => boolean, timeoutMs = 1_000): Promise<void> => {
  const deadline = Date.now() + timeoutMs;
  while (!predicate()) {
    if (Date.now() >= deadline) throw new Error("condition timed out");
    await delay(5);
  }
};

const makeRig = async (): Promise<TestRig> => {
  // Unix-domain socket paths are short on macOS; keep the synthetic home terse.
  const home = mkdtempSync(join(tmpdir(), "vtm-"));
  const fake = makeFakeTerminalProcessAuthority((_spec, index) => ({
    pid: 9_001 + index,
    exitOnSignal: "SIGTERM",
  }));
  const host = new LocalSessionHost(fake.authority, {
    killGraceMs: 10,
    shutdownGraceMs: 50,
    lateExitGraceMs: 50,
  });
  const server = await startTermControlServer(host, {
    home,
    shutdownGraceMs: 20,
    shutdownDeadlineMs: 500,
  });
  const clients: TermControlClient[] = [];
  let disposed = false;
  const rig = {
    home,
    fake,
    host,
    server,
    async connect(): Promise<TermControlClient> {
      const client = await TermControlClient.connect({
        socketPath: server.socketPath,
        token: server.token,
        timeoutMs: 1_000,
      });
      clients.push(client);
      return client;
    },
    async dispose(): Promise<void> {
      if (disposed) return;
      disposed = true;
      for (const client of clients) client.close();
      await Promise.all(clients.map((client) => client.whenClosed()));
      await server.close();
      await host.shutdownAll("maintenance-test");
      rmSync(home, { recursive: true, force: true });
    },
  };
  rigs.push(rig);
  return rig;
};

const acquireEventually = async (
  client: TermControlClient,
): Promise<TermControlMaintenanceLease> => {
  const deadline = Date.now() + 1_000;
  for (;;) {
    const result = await client.acquireMaintenance();
    if (result.acquired) return result.lease;
    if (result.reason !== "maintenance_held" || Date.now() >= deadline) {
      throw new Error(
        `maintenance acquisition remained denied: ${result.reason} (${result.evidence.activeTerminalSessions})`,
      );
    }
    await delay(5);
  }
};

const rawRequest = (
  socketPath: string,
  token: string,
  request: Record<string, unknown> & { readonly id: string },
): Promise<TermControlResponse> =>
  new Promise((resolve, reject) => {
    const socket = createConnection({ path: socketPath });
    socket.setEncoding("utf8");
    let buffer = "";
    let authenticated = false;
    let settled = false;
    const timer = setTimeout(() => finish(new Error("raw request timed out")), 1_000);
    const finish = (outcome: Error | TermControlResponse): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      socket.destroy();
      if (outcome instanceof Error) reject(outcome);
      else resolve(outcome);
    };
    socket.once("connect", () => {
      socket.write(`${JSON.stringify({ token })}\n`);
    });
    socket.on("data", (chunk: string) => {
      buffer += chunk;
      for (;;) {
        const newline = buffer.indexOf("\n");
        if (newline < 0) return;
        const line = buffer.slice(0, newline).trim();
        buffer = buffer.slice(newline + 1);
        if (!line) continue;
        const message = JSON.parse(line) as TermControlResponse;
        if (!authenticated) {
          if (message.ok && message.id === "auth") {
            authenticated = true;
            socket.write(`${JSON.stringify(request)}\n`);
            continue;
          }
          finish(new Error("raw request authentication failed"));
          return;
        }
        if (message.id === request.id) {
          finish(message);
          return;
        }
      }
    });
    socket.once("error", (error) => finish(error));
  });

beforeEach(() => {
  setProcessIdentityMapForTests(makeProcessIdentityMap());
  setProcessEpochReaderForTests({
    snapshot: () =>
      Array.from({ length: 32 }, (_unused, index) => ({
        pid: 9_001 + index,
        processGroupId: 9_000 + index,
        sessionId: 7,
        startKey: `synthetic-${9_001 + index}`,
      })),
  });
});

afterEach(async () => {
  while (rigs.length > 0) await rigs.pop()!.dispose();
  setProcessEpochReaderForTests(undefined);
  setProcessIdentityMapForTests(undefined);
});

describe("terminal maintenance lease", () => {
  it("reports the exact active generation count without signaling it", async () => {
    const rig = await makeRig();
    const terminalClient = await rig.connect();
    const maintenanceClient = await rig.connect();
    await terminalClient.create({ bindingId: "active-terminal" });

    const denied = await maintenanceClient.acquireMaintenance();
    expect(denied).toMatchObject({
      acquired: false,
      reason: "active_sessions",
      evidence: { activeTerminalSessions: 1 },
    });
    expect(denied.evidence.observationId).toMatch(/^tm_[0-9a-f]{16}$/);
    expect(rig.fake.controllers[0]!.signals).toEqual([]);

    rig.fake.controllers[0]!.exit();
    await waitUntil(() => rig.host.runningCount() === 0);
    const acquired = await maintenanceClient.acquireMaintenance();
    expect(acquired.acquired).toBe(true);
    if (!acquired.acquired) return;
    await expect(acquired.lease.release()).resolves.toEqual({ released: true });
    expect(rig.fake.controllers[0]!.signals).toEqual([]);
  });

  it("admits one concurrent holder, blocks every create path, and releases idempotently", async () => {
    const rig = await makeRig();
    const first = await rig.connect();
    const second = await rig.connect();
    const terminalClient = await rig.connect();

    const results = await Promise.all([
      first.acquireMaintenance(),
      second.acquireMaintenance(),
    ]);
    const winner = results.find((result) => result.acquired);
    const loser = results.find((result) => !result.acquired);
    expect(results.filter((result) => result.acquired)).toHaveLength(1);
    expect(loser).toMatchObject({
      acquired: false,
      reason: "maintenance_held",
      evidence: { activeTerminalSessions: 0 },
    });
    if (winner === undefined || !winner.acquired) throw new Error("missing lease winner");

    expect(() => rig.host.create({ bindingId: "direct-create" })).toThrow(
      /admission closed for maintenance/i,
    );
    await expect(
      terminalClient.create({ bindingId: "socket-create" }),
    ).rejects.toThrow(/admission closed for maintenance/i);
    const repeated = await terminalClient.acquireMaintenance();
    expect(repeated).toMatchObject({
      acquired: false,
      reason: "maintenance_held",
      evidence: { activeTerminalSessions: 0 },
    });

    const firstRelease = winner.lease.release();
    const repeatedRelease = winner.lease.release();
    expect(repeatedRelease).toBe(firstRelease);
    await expect(firstRelease).resolves.toEqual({ released: true });

    await expect(
      terminalClient.create({ bindingId: "after-release" }),
    ).resolves.toMatchObject({ bindingId: "after-release", status: "running" });
    expect(rig.fake.controllers[0]!.signals).toEqual([]);
    rig.fake.controllers[0]!.exit();
  });

  it("releases the admission cut on exact client disconnect", async () => {
    const rig = await makeRig();
    const holder = await rig.connect();
    const acquisition = await holder.acquireMaintenance();
    expect(acquisition.acquired).toBe(true);
    if (!acquisition.acquired) return;

    holder.close();
    await holder.whenClosed();

    const successor = await rig.connect();
    const successorLease = await acquireEventually(successor);
    await expect(successorLease.release()).resolves.toEqual({ released: true });
  });

  it("retains the cut through control shutdown until the socket close witness", async () => {
    const rig = await makeRig();
    const holder = await rig.connect();
    const acquisition = await holder.acquireMaintenance();
    expect(acquisition.acquired).toBe(true);
    if (!acquisition.acquired) return;

    rig.server.beginShutdown();
    expect(() => rig.host.create({ bindingId: "shutdown-gap" })).toThrow(
      /admission closed for maintenance/i,
    );
    await expect(rig.server.drainOnQuit()).resolves.toMatchObject({ clean: true });

    expect(rig.host.create({ bindingId: "after-control-close" })).toMatchObject({
      bindingId: "after-control-close",
      status: "running",
    });
    expect(rig.fake.controllers[0]!.signals).toEqual([]);
    rig.fake.controllers[0]!.exit();
  });

  it("does not let another authenticated socket release the capability", async () => {
    const rig = await makeRig();
    const holder = await rig.connect();
    const acquisition = await holder.acquireMaintenance();
    expect(acquisition.acquired).toBe(true);
    if (!acquisition.acquired) return;

    await expect(
      rawRequest(rig.server.socketPath, rig.server.token, {
        v: 1,
        id: "wrong-socket-release",
        op: "maintenance.release",
      }),
    ).resolves.toEqual({
      v: 1,
      id: "wrong-socket-release",
      ok: true,
      data: { released: false },
    });
    expect(() => rig.host.create({ bindingId: "still-cut" })).toThrow(
      /admission closed for maintenance/i,
    );
    await expect(acquisition.lease.release()).resolves.toEqual({ released: true });
  });

  it("invalidates the capability during app shutdown without signaling a session", async () => {
    const rig = await makeRig();
    const holder = await rig.connect();
    const acquisition = await holder.acquireMaintenance();
    expect(acquisition.acquired).toBe(true);
    if (!acquisition.acquired) return;

    await expect(rig.host.shutdownAll("app_quit")).resolves.toEqual({
      clean: true,
      stragglers: [],
    });
    await expect(acquisition.lease.release()).resolves.toEqual({ released: false });
    expect(rig.fake.controllers).toEqual([]);
    expect(() => rig.host.create({ bindingId: "after-shutdown" })).toThrow(
      /host shutting down/i,
    );

    const observer = await rig.connect();
    await expect(observer.acquireMaintenance()).resolves.toMatchObject({
      acquired: false,
      reason: "shutting_down",
      evidence: { activeTerminalSessions: 0 },
    });
  });

  it("rejects caller-supplied PID, path, client, and lease identity fields", async () => {
    const rig = await makeRig();
    const response = await rawRequest(rig.server.socketPath, rig.server.token, {
      v: 1,
      id: "injected-authority",
      op: "maintenance.acquire",
      pid: 42,
      socketPath: "/tmp/not-authority.sock",
      clientId: "operator",
      leaseId: "caller-minted",
    });
    expect(response).toEqual({
      v: 1,
      id: "injected-authority",
      ok: false,
      error: "invalid maintenance request",
    });

    const legitimate = await rig.connect();
    const result = await legitimate.acquireMaintenance();
    expect(result.acquired).toBe(true);
    if (result.acquired) await result.lease.release();
  });

  it("treats an unreachable control plane as an error, never zero sessions", async () => {
    const home = mkdtempSync(join(tmpdir(), "vellum-term-unreachable-"));
    try {
      await expect(
        TermControlClient.connect({
          socketPath: join(home, "missing.sock"),
          token: "not-a-zero-observation",
          timeoutMs: 100,
        }),
      ).rejects.toThrow();
    } finally {
      rmSync(home, { recursive: true, force: true });
    }
  });
});

describe("terminal maintenance wire contract", () => {
  const observationId = "tm_0123456789abcdef";

  it("strictly decodes bounded evidence and release receipts", () => {
    expect(
      decodeTermMaintenanceAcquirePayload({
        acquired: true,
        evidence: { activeTerminalSessions: 0, observationId },
      }),
    ).toEqual({
      acquired: true,
      evidence: { activeTerminalSessions: 0, observationId },
    });
    expect(
      decodeTermMaintenanceAcquirePayload({
        acquired: true,
        evidence: { activeTerminalSessions: 1, observationId },
      }),
    ).toBeUndefined();
    expect(
      decodeTermMaintenanceAcquirePayload({
        acquired: false,
        reason: "active_sessions",
        evidence: { activeTerminalSessions: 0, observationId },
      }),
    ).toBeUndefined();
    expect(
      decodeTermMaintenanceAcquirePayload({
        acquired: false,
        reason: "active_sessions",
        evidence: {
          activeTerminalSessions: TERM_MAINTENANCE_MAX_ACTIVE_SESSIONS + 1,
          observationId,
        },
      }),
    ).toBeUndefined();
    expect(
      decodeTermMaintenanceAcquirePayload({
        acquired: false,
        reason: "maintenance_held",
        evidence: { activeTerminalSessions: 0, observationId: `${observationId}00` },
      }),
    ).toBeUndefined();
    expect(
      decodeTermMaintenanceReleasePayload({ released: true, leaseId: "not-on-wire" }),
    ).toBeUndefined();
    expect(decodeTermMaintenanceReleasePayload({ released: true })).toEqual({
      released: true,
    });
  });

  it("accepts only fixed maintenance request shapes", () => {
    expect(
      decodeTermMaintenanceRequest({
        v: 1,
        id: "0123456789abcdef",
        op: "maintenance.acquire",
      }),
    ).toEqual({
      v: 1,
      id: "0123456789abcdef",
      op: "maintenance.acquire",
    });
    expect(
      decodeTermMaintenanceRequest({
        v: 1,
        id: "0123456789abcdef",
        op: "maintenance.release",
        leaseId: "caller-minted",
      }),
    ).toBeUndefined();
  });
});
