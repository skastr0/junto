/**
 * In-process both-ends actor occupy. No SSH, no network host.
 * Command Center side = ActorSeatOccupy + TermControlClient.
 * Spawn-host side = startTermControlServer + LocalSessionHost.
 */
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { createConnection } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Effect } from "effect";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { makeActorSeatOccupy } from "../src/main/vellum-command/term/actor-seat-occupy";
import { seatStateRuntime } from "../src/main/vellum-command/term/agent-state";
import { TermControlClient } from "../src/main/vellum-command/term/control-client";
import { startTermControlServer } from "../src/main/vellum-command/term/control-server";
import { LocalSessionHost } from "../src/main/vellum-command/term/local-host";
import {
  peekFirstTypedMessage,
  resetFirstTypedForTest,
} from "../src/main/vellum-command/term/first-typed";
import { makeManagedSpawnIntent } from "../src/main/vellum-command/term/managed-spawn-plan";
import { setProcessEpochReaderForTests } from "../src/main/vellum-command/process-epoch";
import { __setSessionExistenceHomeForTest } from "../src/main/vellum-command/term/session-existence";
import {
  makeProcessIdentityMap,
  setProcessIdentityMapForTests,
} from "../src/main/vellum-command/process-identity";
import { TERM_CONTROL_PROTOCOL } from "../src/shared/term-control";
import { SeatIdentityConflictError } from "../src/shared/terminal-seat-occupancy";
import { makeFakeTerminalProcessAuthority } from "./helpers/fake-terminal-process-authority";

const cleanups: Array<() => Promise<void> | void> = [];

/** These tests exercise the wire protocol, not the projection barrier. */
const passThroughAdmission = () => Effect.void;

const actorSpawnIntent = () => ({
  documentLaunch: { kind: "harness", argv: ["grok"] },
  resumeRequested: false,
  injection: { seatBound: true, connected: false },
} as const);

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
  __setSessionExistenceHomeForTest(undefined);
  resetFirstTypedForTest();
  setProcessEpochReaderForTests(undefined);
  setProcessIdentityMapForTests(undefined);
});

const startPair = async () => {
  setProcessIdentityMapForTests(makeProcessIdentityMap({
    processAlive: () => true,
    readProcessStartKey: (pid) => `synthetic-${pid}`,
  }));
  const home = mkdtempSync(join(tmpdir(), "vt-actor-"));
  cleanups.push(() => rmSync(home, { recursive: true, force: true }));
  const fake = makeFakeTerminalProcessAuthority(() => ({
    pid: 9101,
    output: "ready\r\n",
    exitOnSignal: "SIGTERM",
  }));
  const host = new LocalSessionHost(fake.authority);
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
  return { host, server, client, fake };
};

describe("actor occupy protocol (in-process both ends)", () => {
  it("ActorSeatOccupy other-install layer calls createAgentSeat over UDS", async () => {
    const { host, client } = await startPair();
    const createAgentSeat = vi.spyOn(host, "createAgentSeat");
    const create = vi.spyOn(host, "create");
    const when = makeActorSeatOccupy({
      local: host,
      localHostId: () => Effect.succeed("cc-self"),
      clientForOccupy: async () => client,
      remoteProjectionAdmission: passThroughAdmission,
    });

    const created = await Effect.runPromise(
      when.occupy({
        bindingId: "proto_actor",
        harness: "grok",
        agentKey: "station:grok",
        hostId: "station-a",
        canvasName: "factory",
        nodeId: "actor-node",
        spawnIntent: actorSpawnIntent(),
      }),
    );
    expect(created.harness).toBe("grok");
    expect(created.agentKey).toBe("station:grok");
    expect(created.status).toBe("running");
    expect(created.hostId).toBe("station-a");
    expect(createAgentSeat).toHaveBeenCalledTimes(1);
    expect(create).not.toHaveBeenCalled();
    expect(
      seatStateRuntime
        .currentEvents()
        .some((event) => event.bindingId === "proto_actor"),
    ).toBe(true);

    const activated = await Effect.runPromise(
      when.occupy({
        bindingId: "proto_actor",
        harness: "grok",
        agentKey: "station:grok",
        hostId: "station-a",
        canvasName: "factory",
        nodeId: "actor-node",
        spawnIntent: actorSpawnIntent(),
      }),
    );
    expect(activated.epoch).toBe(created.epoch);
    expect(activated.hostId).toBe("station-a");
    expect(createAgentSeat).toHaveBeenCalledTimes(1);
  });

  it("derives Tier B first-typed doctrine only on the Remote spawn host", async () => {
    const { host, client } = await startPair();
    const createAgentSeat = vi.spyOn(client, "createAgentSeat");
    const when = makeActorSeatOccupy({
      local: host,
      localHostId: () => Effect.succeed("cc-self"),
      clientForOccupy: async () => client,
      remoteProjectionAdmission: passThroughAdmission,
    });
    const spawnIntent = makeManagedSpawnIntent({
      harness: "muse",
      agentKey: "station:muse",
      documentLaunch: { kind: "harness", argv: ["muse"] },
      injection: {
        seatBound: true,
        connected: true,
        seatRef: "actor-kimi",
        connectedTargets: [{ id: "tasks", kind: "task" }],
      },
    });

    await Effect.runPromise(
      when.occupy({
        bindingId: "proto_remote_tier_b",
        harness: "muse",
        agentKey: "station:muse",
        hostId: "station-a",
        canvasName: "factory",
        nodeId: "actor-kimi",
        spawnIntent,
      }),
    );

    expect(peekFirstTypedMessage("proto_remote_tier_b")).toBeUndefined();
    const wire = createAgentSeat.mock.calls[0]?.[0];
    expect(wire).toMatchObject({ spawnIntent });
    expect(wire).not.toHaveProperty("launch");
    expect(wire).not.toHaveProperty("firstTypedMessage");
  });

  it("finalizes Remote-only named-session proof on the spawn side of UDS", async () => {
    const priorVellumHome = process.env.VELLUM_COMMAND_HOME;
    delete process.env.VELLUM_COMMAND_HOME;
    const commandCenterHome = mkdtempSync(join(tmpdir(), "vt-actor-cc-home-"));
    const remoteHome = mkdtempSync(join(tmpdir(), "vt-actor-remote-home-"));
    cleanups.push(() => rmSync(commandCenterHome, { recursive: true, force: true }));
    cleanups.push(() => rmSync(remoteHome, { recursive: true, force: true }));
    const sid = "aaaaaaaa-bbbb-cccc-dddd-111111111111";
    const workDir = join(remoteHome, "work");
    mkdirSync(workDir, { recursive: true });
    try {
      __setSessionExistenceHomeForTest(commandCenterHome);
      const spawnIntent = makeManagedSpawnIntent({
        harness: "grok",
        agentKey: "station:grok",
        sessionId: sid,
        resume: true,
        cwd: workDir,
        documentLaunch: {
          kind: "harness",
          argv: ["grok", "--session-id", sid],
          cwd: workDir,
        },
      });

      mkdirSync(
        join(
          remoteHome,
          ".grok",
          "sessions",
          encodeURIComponent(workDir),
          sid,
        ),
        { recursive: true },
      );
      __setSessionExistenceHomeForTest(remoteHome);
      const { host, client, fake } = await startPair();
      const when = makeActorSeatOccupy({
        local: host,
        localHostId: () => Effect.succeed("cc-self"),
        clientForOccupy: async () => client,
        remoteProjectionAdmission: passThroughAdmission,
      });

      await Effect.runPromise(
        when.occupy({
          bindingId: "proto_remote_resume",
          harness: "grok",
          agentKey: "station:grok",
          hostId: "station-a",
          canvasName: "factory",
          nodeId: "actor-node",
          spawnIntent,
        }),
      );

      expect(fake.controllers).toHaveLength(1);
      expect(fake.controllers[0]?.spec.args).toEqual(
        expect.arrayContaining(["-r", sid]),
      );
      expect(fake.controllers[0]?.spec.args).not.toContain("--session-id");
    } finally {
      __setSessionExistenceHomeForTest(undefined);
      if (priorVellumHome === undefined) delete process.env.VELLUM_COMMAND_HOME;
      else process.env.VELLUM_COMMAND_HOME = priorVellumHome;
    }
  });

  it("refuses occupied Remote geography over UDS with a typed identity conflict", async () => {
    const { host, client } = await startPair();
    const geography = host.create({
      bindingId: "proto_geography",
      launch: { kind: "shell" },
    });
    const createAgentSeat = vi.spyOn(host, "createAgentSeat");
    const when = makeActorSeatOccupy({
      local: host,
      localHostId: () => Effect.succeed("cc-self"),
      clientForOccupy: async () => client,
      remoteProjectionAdmission: passThroughAdmission,
    });

    const conflict = await Effect.runPromise(
      Effect.flip(
        when.occupy({
          bindingId: "proto_geography",
          harness: "grok",
          agentKey: "station:grok",
          hostId: "station-a",
          canvasName: "factory",
          nodeId: "actor-geography",
          spawnIntent: actorSpawnIntent(),
        }),
      ),
    );

    expect(conflict).toBeInstanceOf(SeatIdentityConflictError);
    expect(host.get("proto_geography")).toMatchObject({
      epoch: geography.epoch,
      status: "running",
    });
    expect(host.get("proto_geography")?.harness).toBeUndefined();
    expect(host.get("proto_geography")?.agentKey).toBeUndefined();
    expect(createAgentSeat).not.toHaveBeenCalled();
  });

  it("converges racing occupies for the same actor identity on one generation", async () => {
    const { host, client, fake } = await startPair();
    const when = makeActorSeatOccupy({
      local: host,
      localHostId: () => Effect.succeed("cc-self"),
      clientForOccupy: async () => client,
      remoteProjectionAdmission: passThroughAdmission,
    });
    const spec = {
      bindingId: "proto_race_same",
      harness: "grok",
      agentKey: "station:grok",
      hostId: "station-a",
      canvasName: "factory",
      nodeId: "actor-race",
      spawnIntent: actorSpawnIntent(),
    } as const;

    const [first, second] = await Promise.all([
      Effect.runPromise(when.occupy(spec)),
      Effect.runPromise(when.occupy(spec)),
    ]);

    expect(first.epoch).toBe(second.epoch);
    // The fake authority mints a constant pid, so a pid comparison carries no
    // signal here; single-spawn convergence is proven by the controller count
    // and the running count below.
    expect(first.agentKey).toBe("station:grok");
    expect(fake.controllers).toHaveLength(1);
    expect(host.runningCount()).toBe(1);
  });

  it("surfaces a typed conflict when a second occupy names a different actor", async () => {
    const { host, client, fake } = await startPair();
    const when = makeActorSeatOccupy({
      local: host,
      localHostId: () => Effect.succeed("cc-self"),
      clientForOccupy: async () => client,
      remoteProjectionAdmission: passThroughAdmission,
    });
    const spec = {
      bindingId: "proto_race_diff",
      harness: "grok",
      agentKey: "station:grok",
      hostId: "station-a",
      canvasName: "factory",
      nodeId: "actor-one",
      spawnIntent: actorSpawnIntent(),
    } as const;

    const winner = await Effect.runPromise(when.occupy(spec));
    const conflict = await Effect.runPromise(
      Effect.flip(
        when.occupy({
          ...spec,
          agentKey: "station:other",
          nodeId: "actor-two",
        }),
      ),
    );

    expect(conflict).toBeInstanceOf(SeatIdentityConflictError);
    expect(host.get("proto_race_diff")).toMatchObject({
      epoch: winner.epoch,
      agentKey: "station:grok",
      nodeId: "actor-one",
    });
    expect(fake.controllers).toHaveLength(1);
    expect(host.runningCount()).toBe(1);
  });

  it("fuzz: garbage and partial frames do not occupy an actor", async () => {
    const { host, server } = await startPair();
    const createAgentSeat = vi.spyOn(host, "createAgentSeat");
    const before = host.list().length;

    const frames = [
      "{not json\n",
      `${JSON.stringify({ v: TERM_CONTROL_PROTOCOL, id: "a", op: "createAgentSeat" })}\n`,
      `${JSON.stringify({
        v: TERM_CONTROL_PROTOCOL,
        id: "b",
        op: "createAgentSeat",
        bindingId: "fuzz_1",
        harness: "grok",
      })}\n`,
      `${JSON.stringify({
        v: TERM_CONTROL_PROTOCOL,
        id: "c",
        op: "createAgentSeat",
        bindingId: "fuzz_2",
        agentKey: "x",
      })}\n`,
      `${JSON.stringify({
        v: TERM_CONTROL_PROTOCOL,
        id: "d",
        op: "createAgentSeat",
        bindingId: "fuzz_3",
        harness: "not-a-harness",
        agentKey: "x",
      })}\n`,
      `${JSON.stringify({
        v: TERM_CONTROL_PROTOCOL,
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
