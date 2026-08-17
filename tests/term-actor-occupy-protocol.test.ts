/**
 * In-process both-ends actor occupy. No SSH, no network host.
 * Command Center side = ActorSeatOccupy + TermControlClient.
 * Spawn-host side = startTermControlServer + LocalSessionHost.
 */
import { mkdtempSync, rmSync } from "node:fs";
import { createConnection } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Effect, Exit } from "effect";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { makeActorSeatOccupy } from "../src/main/vellum/term/actor-seat-occupy";
import { seatStateRuntime } from "../src/main/vellum/term/agent-state";
import { TermControlClient } from "../src/main/vellum/term/control-client";
import { startTermControlServer } from "../src/main/vellum/term/control-server";
import { LocalSessionHost } from "../src/main/vellum/term/local-host";
import { setProcessEpochReaderForTests } from "../src/main/vellum/process-epoch";
import {
  makeProcessIdentityMap,
  setProcessIdentityMapForTests,
} from "../src/main/vellum/process-identity";
import { makeFakeTerminalProcessAuthority } from "./helpers/fake-terminal-process-authority";

const cleanups: Array<() => Promise<void> | void> = [];

beforeEach(() => {
  setProcessEpochReaderForTests({
    snapshot: () => [
      {
        pid: 9101,
        processGroupId: 9100,
        sessionId: 7,
        startKey: "synthetic-9101",
      },
    ],
  });
});

afterEach(async () => {
  while (cleanups.length > 0) {
    await cleanups.pop()?.();
  }
  setProcessEpochReaderForTests(undefined);
  setProcessIdentityMapForTests(undefined);
});

const startPair = async () => {
  setProcessIdentityMapForTests(makeProcessIdentityMap());
  const home = mkdtempSync(join(tmpdir(), "vt-actor-"));
  cleanups.push(() => rmSync(home, { recursive: true, force: true }));
  const host = new LocalSessionHost(
    makeFakeTerminalProcessAuthority(() => ({
      pid: 9101,
      output: "ready\r\n",
      exitOnSignal: "SIGTERM",
    })).authority,
  );
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
  return { host, server, client };
};

describe("actor occupy protocol (in-process both ends)", () => {
  it("ActorSeatOccupy other-install layer calls createAgentSeat over UDS", async () => {
    const { host, client } = await startPair();
    const createAgentSeat = vi.spyOn(host, "createAgentSeat");
    const create = vi.spyOn(host, "create");
    const when = makeActorSeatOccupy({
      local: host,
      isLocalHostId: () => false,
      clientFor: async () => ({
        get: (id) => client.get(id),
        createAgentSeat: (spec) =>
          client.createAgentSeat({
            bindingId: spec.bindingId,
            harness: spec.harness,
            agentKey: spec.agentKey,
            launch: spec.launch,
          }),
      }),
    });

    const created = await Effect.runPromise(
      when.occupy({
        bindingId: "proto_actor",
        harness: "grok",
        agentKey: "station:grok",
        hostId: "station-a",
        launch: { kind: "harness", argv: ["grok"] },
      }),
    );
    expect(created.harness).toBe("grok");
    expect(created.agentKey).toBe("station:grok");
    expect(created.status).toBe("running");
    expect(createAgentSeat).toHaveBeenCalledTimes(1);
    expect(create).not.toHaveBeenCalled();
    expect(
      seatStateRuntime
        .currentEvents()
        .some((event) => event.bindingId === "proto_actor"),
    ).toBe(true);

    const refused = await Effect.runPromiseExit(
      when.occupy({
        bindingId: "proto_actor",
        harness: "grok",
        agentKey: "station:grok",
        hostId: "station-a",
      }),
    );
    expect(Exit.isFailure(refused)).toBe(true);
    expect(createAgentSeat).toHaveBeenCalledTimes(1);
  });

  it("fuzz: garbage and partial frames do not occupy an actor", async () => {
    const { host, server } = await startPair();
    const createAgentSeat = vi.spyOn(host, "createAgentSeat");
    const before = host.list().length;

    const frames = [
      "{not json\n",
      `${JSON.stringify({ v: 1, id: "a", op: "createAgentSeat" })}\n`,
      `${JSON.stringify({
        v: 1,
        id: "b",
        op: "createAgentSeat",
        bindingId: "fuzz_1",
        harness: "grok",
      })}\n`,
      `${JSON.stringify({
        v: 1,
        id: "c",
        op: "createAgentSeat",
        bindingId: "fuzz_2",
        agentKey: "x",
      })}\n`,
      `${JSON.stringify({
        v: 1,
        id: "d",
        op: "createAgentSeat",
        bindingId: "fuzz_3",
        harness: "not-a-harness",
        agentKey: "x",
      })}\n`,
      `${JSON.stringify({
        v: 1,
        id: "e",
        op: "createAgentSeat",
        bindingId: "fuzz_4",
        harness: "",
        agentKey: "",
      })}\n`,
      "\x00\x01\x02\n",
      `${JSON.stringify({ v: 2, id: "f", op: "createAgentSeat", bindingId: "fuzz_5" })}\n`,
    ];

    for (const frame of frames) {
      const socket = createConnection(server.socketPath);
      await new Promise<void>((resolve, reject) => {
        socket.once("connect", resolve);
        socket.once("error", reject);
      });
      socket.write(`${JSON.stringify({ token: server.token })}\n`);
      await new Promise((resolve) => setTimeout(resolve, 20));
      socket.write(frame);
      await new Promise((resolve) => setTimeout(resolve, 30));
      socket.destroy();
      await new Promise((resolve) => socket.once("close", resolve));
    }

    expect(host.list().length).toBe(before);
    expect(createAgentSeat).not.toHaveBeenCalled();
    expect(
      seatStateRuntime
        .currentEvents()
        .some((event) => event.bindingId.startsWith("fuzz_")),
    ).toBe(false);
  });
});
