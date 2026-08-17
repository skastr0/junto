import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createConnection } from "node:net";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  LocalSessionHost,
  type LocalHostEvent,
} from "../src/main/vellum/term/local-host";
import { startTermControlServer } from "../src/main/vellum/term/control-server";
import { TermControlClient } from "../src/main/vellum/term/control-client";
import { seatStateRuntime } from "../src/main/vellum/term/agent-state";
import type { TermControlResponse } from "../src/shared/term-control";
import {
  makeProcessIdentityMap,
  setProcessIdentityMapForTests,
} from "../src/main/vellum/process-identity";
import { setProcessEpochReaderForTests } from "../src/main/vellum/process-epoch";
import { makeFakeTerminalProcessAuthority } from "./helpers/fake-terminal-process-authority";

const cleanups: Array<() => Promise<void> | void> = [];

beforeEach(() => {
  setProcessEpochReaderForTests({
    snapshot: () => [{
      pid: 9001,
      processGroupId: 9000,
      sessionId: 7,
      startKey: "synthetic-9001",
    }],
  });
});

afterEach(async () => {
  while (cleanups.length > 0) {
    await cleanups.pop()?.();
  }
  setProcessEpochReaderForTests(undefined);
  setProcessIdentityMapForTests(undefined);
});

const fakeAuthority = () => makeFakeTerminalProcessAuthority(() => ({
  pid: 9001,
  output: "ready\r\n",
  exitOnSignal: "SIGTERM",
  echoWrites: "echo:",
})).authority;

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
    const finish = (outcome: Error | TermControlResponse): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      socket.destroy();
      if (outcome instanceof Error) reject(outcome);
      else resolve(outcome);
    };
    const timer = setTimeout(
      () => finish(new Error("raw request timed out")),
      1_000,
    );
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

describe("term control UDS", () => {
  it("auth + create + attach + write + kill over NDJSON with bigint journal", async () => {
    setProcessIdentityMapForTests(makeProcessIdentityMap());
    const home = mkdtempSync(join(tmpdir(), "vt-"));
    cleanups.push(() => rmSync(home, { recursive: true, force: true }));

    const host = new LocalSessionHost(fakeAuthority());
    cleanups.push(async () => {
      await host.shutdownAll("test");
    });

    const server = await startTermControlServer(host, { home });
    cleanups.push(() => server.close());

    const client = await TermControlClient.connect({
      socketPath: server.socketPath,
      token: server.token,
      timeoutMs: 5_000,
    });
    cleanups.push(() => client.close());

    const created = await client.create({
      bindingId: "bind_a",
      launch: { kind: "shell" },
      cols: 80,
      rows: 24,
      label: "t",
    });
    expect(created.bindingId).toBe("bind_a");
    expect(created.status).toBe("running");

    const listed = await client.list();
    expect(listed.some((s) => s.bindingId === "bind_a")).toBe(true);

    const browsedPath = join(home, "project");
    mkdirSync(browsedPath);
    const browsed = await client.readDirectory(home);
    expect(browsed.entries).toContainEqual(
      expect.objectContaining({
        name: "project",
        path: join(browsed.root, "project"),
        kind: "directory",
      }),
    );

    const attach = await client.attach({
      bindingId: "bind_a",
      mode: "control",
      takeover: true,
    });
    expect(attach.ok).toBe(true);
    if (!attach.ok) return;

    // Journal may include startup "ready" output — seq must revive as bigint.
    for (const entry of attach.journal) {
      expect(typeof entry.seq).toBe("bigint");
    }

    const events: string[] = [];
    client.on("event", (ev) => {
      if (ev && typeof ev === "object" && (ev as { type?: string }).type === "output") {
        events.push(String((ev as { data?: string }).data ?? ""));
      }
    });

    const wrote = await client.write(attach.lease.leaseId, "hi");
    expect(wrote).toBe(true);

    await new Promise((r) => setTimeout(r, 50));
    expect(events.some((e) => e.includes("echo:hi"))).toBe(true);

    const killed = await client.kill("bind_a");
    expect(killed).toBe(true);
    const after = await client.get("bind_a");
    expect(after?.status === "exited" || after === undefined).toBe(true);
  });

  it("create on an occupied seat returns the occupant and does not respawn", async () => {
    setProcessIdentityMapForTests(makeProcessIdentityMap());
    const home = mkdtempSync(join(tmpdir(), "vt-occ-"));
    cleanups.push(() => rmSync(home, { recursive: true, force: true }));
    const host = new LocalSessionHost(fakeAuthority());
    cleanups.push(async () => {
      await host.shutdownAll("test");
    });
    const server = await startTermControlServer(host, { home });
    cleanups.push(() => server.close());
    const client = await TermControlClient.connect({
      socketPath: server.socketPath,
      token: server.token,
      timeoutMs: 5_000,
    });
    cleanups.push(() => client.close());

    const first = await client.create({
      bindingId: "bind_occ",
      launch: { kind: "shell" },
    });
    const again = await client.create({
      bindingId: "bind_occ",
      launch: { kind: "shell" },
    });
    expect(again.epoch).toBe(first.epoch);
    expect(host.runningCount()).toBe(1);
  });

  it("rejects bad token", async () => {
    const home = mkdtempSync(join(tmpdir(), "vtb-"));
    cleanups.push(() => rmSync(home, { recursive: true, force: true }));
    const host = new LocalSessionHost(fakeAuthority());
    cleanups.push(async () => {
      await host.shutdownAll("test");
    });
    const server = await startTermControlServer(host, { home });
    cleanups.push(() => server.close());

    await expect(
      TermControlClient.connect({
        socketPath: server.socketPath,
        token: "not-the-token",
        timeoutMs: 3_000,
      }),
    ).rejects.toThrow(/unauth|auth/i);
  });

  it("isLive is false after the socket closes", async () => {
    const home = mkdtempSync(join(tmpdir(), "vtl-"));
    cleanups.push(() => rmSync(home, { recursive: true, force: true }));
    const host = new LocalSessionHost(fakeAuthority());
    cleanups.push(async () => {
      await host.shutdownAll("test");
    });
    const server = await startTermControlServer(host, { home });
    cleanups.push(() => server.close());
    const client = await TermControlClient.connect({
      socketPath: server.socketPath,
      token: server.token,
      timeoutMs: 5_000,
    });
    expect(client.isLive()).toBe(true);
    client.close();
    await client.whenClosed();
    expect(client.isLive()).toBe(false);
  });

  it("caps accepted peers before frame admission and recovers after close", async () => {
    const home = mkdtempSync(join(tmpdir(), "vtc-"));
    cleanups.push(() => rmSync(home, { recursive: true, force: true }));
    const host = new LocalSessionHost(fakeAuthority());
    cleanups.push(async () => { await host.shutdownAll("test"); });
    const server = await startTermControlServer(host, { home, maxActiveClients: 1 });
    cleanups.push(() => server.close());
    const first = createConnection(server.socketPath);
    await new Promise<void>((resolve, reject) => { first.once("connect", resolve); first.once("error", reject); });
    const excess = createConnection(server.socketPath);
    await new Promise<void>((resolve) => excess.once("close", resolve));
    first.destroy();
    await new Promise<void>((resolve) => first.once("close", resolve));
    const recovered = createConnection(server.socketPath);
    await new Promise<void>((resolve, reject) => { recovered.once("connect", resolve); recovered.once("error", reject); });
    recovered.destroy();
  });

  it("boundedly drains an active client when the control server closes", async () => {
    const home = mkdtempSync(join(tmpdir(), "vtcl-"));
    cleanups.push(() => rmSync(home, { recursive: true, force: true }));
    const host = new LocalSessionHost(fakeAuthority());
    cleanups.push(async () => {
      await host.shutdownAll("test");
    });
    const server = await startTermControlServer(host, { home });

    const socket = createConnection(server.socketPath);
    await new Promise<void>((resolve, reject) => {
      socket.once("connect", resolve);
      socket.once("error", reject);
    });
    socket.write(`${JSON.stringify({ token: server.token })}\n`);

    await expect(
      Promise.race([
        server.close(),
        new Promise<never>((_, reject) => setTimeout(() => reject(new Error("close timed out")), 1_000)),
      ]),
    ).resolves.toBeUndefined();
    expect(socket.destroyed).toBe(true);
  });

  it("stops accepting late clients and commands when close begins", async () => {
    setProcessIdentityMapForTests(makeProcessIdentityMap());
    const home = mkdtempSync(join(tmpdir(), "vtl-"));
    cleanups.push(() => rmSync(home, { recursive: true, force: true }));
    const host = new LocalSessionHost(fakeAuthority());
    cleanups.push(async () => {
      await host.shutdownAll("test");
    });
    const server = await startTermControlServer(host, { home });
    const active = createConnection(server.socketPath);
    await new Promise<void>((resolve, reject) => {
      active.once("connect", resolve);
      active.once("error", reject);
    });

    const closing = server.close();
    active.write(`${JSON.stringify({ token: server.token })}\n`);
    active.write(`${JSON.stringify({ v: 1, id: "late", op: "create", bindingId: "late" })}\n`);
    const late = createConnection(server.socketPath);
    const lateOutcome = await new Promise<"connected" | "rejected">((resolve) => {
      late.once("connect", () => resolve("connected"));
      late.once("error", () => resolve("rejected"));
    });
    if (lateOutcome === "connected") late.destroy();

    await closing;
    expect(host.list()).toEqual([]);
  });

  it("connect then subscribe still sees the current working seat", async () => {
    const home = mkdtempSync(join(tmpdir(), "vtss-"));
    cleanups.push(() => rmSync(home, { recursive: true, force: true }));
    const host = new LocalSessionHost(fakeAuthority());
    cleanups.push(async () => {
      await host.shutdownAll("test");
    });
    seatStateRuntime.bindHarness("uds_auth_snap", "claude", "e-uds");
    seatStateRuntime.machine.force(
      "uds_auth_snap",
      "working",
      "rule:grid_thinking_working",
      "high",
    );
    cleanups.push(() => {
      seatStateRuntime.unbind("uds_auth_snap", "e-uds");
    });

    const server = await startTermControlServer(host, { home });
    cleanups.push(() => server.close());
    const client = await TermControlClient.connect({
      socketPath: server.socketPath,
      token: server.token,
      timeoutMs: 5_000,
    });
    cleanups.push(() => client.close());

    const seen = new Promise<LocalHostEvent>((resolve) => {
      client.on("event", (ev: LocalHostEvent) => {
        if (ev.type === "seat-state" && ev.event.bindingId === "uds_auth_snap") {
          resolve(ev);
        }
      });
    });
    const ev = await Promise.race([
      seen,
      new Promise<never>((_, reject) =>
        setTimeout(() => reject(new Error("missing seat-state snapshot")), 1_000),
      ),
    ]);
    expect(ev.type).toBe("seat-state");
    if (ev.type !== "seat-state") return;
    expect(ev.event.state).toBe("working");
    expect(ev.event.reason).toBe("rule:grid_thinking_working");
    expect(ev.event.epoch).toBe("e-uds");
  });

  it("rejects raw create frames containing actor identity fields", async () => {
    setProcessIdentityMapForTests(makeProcessIdentityMap());
    const home = mkdtempSync(join(tmpdir(), "vtcf-"));
    cleanups.push(() => rmSync(home, { recursive: true, force: true }));
    const host = new LocalSessionHost(fakeAuthority());
    cleanups.push(async () => {
      await host.shutdownAll("test");
    });
    const server = await startTermControlServer(host, { home });
    cleanups.push(() => server.close());

    const requests = [
      {
        v: 1,
        id: "raw-create-harness",
        op: "create",
        bindingId: "uds_raw_create_harness",
        harness: "grok",
      },
      {
        v: 1,
        id: "raw-create-agent-key",
        op: "create",
        bindingId: "uds_raw_create_agent_key",
        agentKey: "mini:grok",
      },
      {
        v: 1,
        id: "raw-create-both",
        op: "create",
        bindingId: "uds_raw_create_both",
        harness: "grok",
        agentKey: "mini:grok",
      },
    ] as const;

    for (const request of requests) {
      const response = await rawRequest(server.socketPath, server.token, request);
      expect(response).toMatchObject({ id: request.id, ok: false });
      if (response.ok) throw new Error("raw actor create was unexpectedly accepted");
      expect(response.error).toMatch(/use createAgentSeat/);
    }
    expect(host.list()).toEqual([]);
  });

  it("createAgentSeat occupies an actor seat and adopts the same identity as a no-op", async () => {
    setProcessIdentityMapForTests(makeProcessIdentityMap());
    const home = mkdtempSync(join(tmpdir(), "vtcas-"));
    cleanups.push(() => rmSync(home, { recursive: true, force: true }));
    const host = new LocalSessionHost(fakeAuthority());
    cleanups.push(async () => {
      await host.shutdownAll("test");
    });
    const server = await startTermControlServer(host, { home });
    cleanups.push(() => server.close());
    const client = await TermControlClient.connect({
      socketPath: server.socketPath,
      token: server.token,
      timeoutMs: 5_000,
    });
    cleanups.push(() => client.close());

    const created = await client.createAgentSeat({
      bindingId: "uds_cas",
      harness: "grok",
      agentKey: "mini:grok",
      launch: { kind: "harness", argv: ["grok"] },
      cols: 80,
      rows: 24,
    });
    expect(created.status).toBe("running");
    expect(created.harness).toBe("grok");
    expect(created.agentKey).toBe("mini:grok");
    expect(
      seatStateRuntime.currentEvents().some((event) => event.bindingId === "uds_cas"),
    ).toBe(true);

    const again = await client.createAgentSeat({
      bindingId: "uds_cas",
      harness: "grok",
      agentKey: "mini:grok",
    });
    expect(again.epoch).toBe(created.epoch);
    expect(again.harness).toBe("grok");
    expect(again.agentKey).toBe("mini:grok");
    expect(host.runningCount()).toBe(1);
  });

  it("geography create still works and does not bind a harness", async () => {
    setProcessIdentityMapForTests(makeProcessIdentityMap());
    const home = mkdtempSync(join(tmpdir(), "vtgeo-"));
    cleanups.push(() => rmSync(home, { recursive: true, force: true }));
    const host = new LocalSessionHost(fakeAuthority());
    cleanups.push(async () => {
      await host.shutdownAll("test");
    });
    const server = await startTermControlServer(host, { home });
    cleanups.push(() => server.close());
    const client = await TermControlClient.connect({
      socketPath: server.socketPath,
      token: server.token,
      timeoutMs: 5_000,
    });
    cleanups.push(() => client.close());

    const created = await client.create({
      bindingId: "uds_geo",
      launch: { kind: "shell" },
      cols: 80,
      rows: 24,
    });
    expect(created.status).toBe("running");
    expect(created.harness).toBeUndefined();
    expect(created.agentKey).toBeUndefined();
    expect(
      seatStateRuntime.currentEvents().some((event) => event.bindingId === "uds_geo"),
    ).toBe(false);
  });

  it("createAgentSeat with only harness fails", async () => {
    setProcessIdentityMapForTests(makeProcessIdentityMap());
    const home = mkdtempSync(join(tmpdir(), "vtcasx-"));
    cleanups.push(() => rmSync(home, { recursive: true, force: true }));
    const host = new LocalSessionHost(fakeAuthority());
    cleanups.push(async () => {
      await host.shutdownAll("test");
    });
    const server = await startTermControlServer(host, { home });
    cleanups.push(() => server.close());
    const client = await TermControlClient.connect({
      socketPath: server.socketPath,
      token: server.token,
      timeoutMs: 5_000,
    });
    cleanups.push(() => client.close());

    await expect(
      client.createAgentSeat({
        bindingId: "uds_cas_xor",
        harness: "grok",
      } as { bindingId: string; harness: string; agentKey: string }),
    ).rejects.toThrow(/harness and agentKey/);
  });
});
