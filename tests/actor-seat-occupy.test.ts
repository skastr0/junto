import { Effect } from "effect";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  makeActorSeatOccupy,
  type ActorOccupySpec,
} from "../src/main/vellum/term/actor-seat-occupy";
import { LocalSessionHost } from "../src/main/vellum/term/local-host";
import type {
  RemoteAgentSeatCommand,
  RemoteSeatProcessClient,
} from "../src/main/vellum/term/seat-process";
import type { TerminalSessionSummary } from "../src/shared/terminal";
import {
  makeProcessIdentityMap,
  setProcessIdentityMapForTests,
} from "../src/main/vellum/process-identity";
import { setProcessEpochReaderForTests } from "../src/main/vellum/process-epoch";
import { makeFakeTerminalProcessAuthority } from "./helpers/fake-terminal-process-authority";

const hosts: LocalSessionHost[] = [];
const syntheticEpochs = new Map<number, string>();

const actorSpec = (bindingId: string, hostId?: string): ActorOccupySpec => ({
  bindingId,
  harness: "grok",
  agentKey: "local:grok",
  canvasName: "factory",
  nodeId: `node-${bindingId}`,
  spawnIntent: {
    documentLaunch: { kind: "harness", argv: ["grok"] },
    resumeRequested: false,
    injection: { seatBound: true, connected: false },
  },
  ...(hostId === undefined ? {} : { hostId }),
});

const remoteSummary = (
  over: Pick<TerminalSessionSummary, "bindingId" | "epoch" | "status"> &
    Partial<
      Pick<
        TerminalSessionSummary,
        "harness" | "agentKey" | "canvasName" | "nodeId"
      >
    >,
): TerminalSessionSummary => ({
  hostId: "local",
  detached: false,
  createdAt: 1,
  ...over,
});

beforeEach(() => {
  syntheticEpochs.clear();
  setProcessEpochReaderForTests({
    snapshot: () =>
      [...syntheticEpochs].map(([pid, startKey]) => ({
        pid,
        processGroupId: Math.max(2, pid - 1),
        sessionId: 7,
        startKey,
      })),
  });
});

afterEach(async () => {
  for (const host of hosts.splice(0)) {
    await host.shutdownAll("test_cleanup");
  }
  setProcessEpochReaderForTests(undefined);
  setProcessIdentityMapForTests(undefined);
});

describe("ActorSeatOccupy", () => {
  it("occupies then activates the same local actor generation", async () => {
    setProcessIdentityMapForTests(makeProcessIdentityMap());
    syntheticEpochs.set(42_700, "synthetic-42700");
    const fake = makeFakeTerminalProcessAuthority(() => ({
      pid: 42_700,
      exitOnSignal: false,
    }));
    const host = new LocalSessionHost(fake.authority);
    hosts.push(host);
    const createAgentSeat = vi.spyOn(host, "createAgentSeat");
    const create = vi.spyOn(host, "create");
    const clientForOccupy = vi.fn(async (): Promise<RemoteSeatProcessClient> => {
      throw new Error("local occupy must not open a Remote client");
    });
    const localHostId = vi.fn(() => Effect.succeed("cc-self"));
    const when = makeActorSeatOccupy({
      local: host,
      localHostId,
      clientForOccupy,
    });

    const created = await Effect.runPromise(
      when.occupy(actorSpec("seat-p", "cc-self")),
    );
    const activated = await Effect.runPromise(
      when.occupy(actorSpec("seat-p", "cc-self")),
    );

    expect(created.status).toBe("running");
    expect(created.harness).toBe("grok");
    expect(created.agentKey).toBe("local:grok");
    expect(activated.epoch).toBe(created.epoch);
    expect(createAgentSeat).toHaveBeenCalledTimes(1);
    expect(create).not.toHaveBeenCalled();
    expect(clientForOccupy).not.toHaveBeenCalled();
    expect(fake.controllers).toHaveLength(1);

    const occupancy = await Effect.runPromise(
      when.occupancy("seat-p", "cc-self"),
    );
    expect(occupancy._tag).toBe("OccupiedSeat");
    expect(localHostId).toHaveBeenCalledTimes(3);
  });

  it("selects local then Remote HOW per call on one service instance", async () => {
    setProcessIdentityMapForTests(makeProcessIdentityMap());
    syntheticEpochs.set(42_701, "synthetic-42701");
    const fake = makeFakeTerminalProcessAuthority(() => ({
      pid: 42_701,
      exitOnSignal: false,
    }));
    const host = new LocalSessionHost(fake.authority);
    hosts.push(host);

    let remoteLive: TerminalSessionSummary | undefined;
    const remoteClient: RemoteSeatProcessClient = {
      get: async () => remoteLive,
      createAgentSeat: async (input) => {
        remoteLive = remoteSummary({
          bindingId: input.bindingId,
          epoch: "epoch-remote",
          status: "running",
          harness: input.harness,
          agentKey: input.agentKey,
          canvasName: input.canvasName,
          nodeId: input.nodeId,
        });
        return remoteLive;
      },
    };
    const clientForOccupy = vi.fn(async (hostId: string) => {
      expect(hostId).toBe("station-a");
      return remoteClient;
    });
    const localHostId = vi.fn(() => Effect.succeed("cc-self"));
    const when = makeActorSeatOccupy({
      local: host,
      localHostId,
      clientForOccupy,
    });

    const local = await Effect.runPromise(
      when.occupy(actorSpec("seat-local", "cc-self")),
    );
    const remote = await Effect.runPromise(
      when.occupy(actorSpec("seat-remote", "  station-a  ")),
    );

    expect(local.hostId).toBe("cc-self");
    expect(remote).toMatchObject({
      bindingId: "seat-remote",
      epoch: "epoch-remote",
      hostId: "station-a",
      harness: "grok",
      agentKey: "local:grok",
    });
    expect(fake.controllers).toHaveLength(1);
    expect(clientForOccupy).toHaveBeenCalledTimes(1);
    expect(localHostId).toHaveBeenCalledTimes(2);
  });

  it("activates a Remote actor on the second call without spawning again", async () => {
    const host = new LocalSessionHost(
      makeFakeTerminalProcessAuthority().authority,
    );
    hosts.push(host);
    let live: TerminalSessionSummary | undefined;
    const createAgentSeat = vi.fn(async (_command: RemoteAgentSeatCommand) => {
      live = remoteSummary({
        bindingId: "seat-r",
        epoch: "epoch-1",
        status: "running",
        harness: "grok",
        agentKey: "local:grok",
        canvasName: "factory",
        nodeId: "node-seat-r",
      });
      return live;
    });
    const when = makeActorSeatOccupy({
      local: host,
      localHostId: () => Effect.succeed("cc-self"),
      clientForOccupy: async () => ({
        get: async () => live,
        createAgentSeat,
      }),
    });

    const created = await Effect.runPromise(
      when.occupy(actorSpec("seat-r", "station-a")),
    );
    const activated = await Effect.runPromise(
      when.occupy(actorSpec("seat-r", "station-a")),
    );

    expect(created.hostId).toBe("station-a");
    expect(activated.hostId).toBe("station-a");
    expect(activated.epoch).toBe(created.epoch);
    expect(createAgentSeat).toHaveBeenCalledTimes(2);
    expect(
      createAgentSeat.mock.calls.map(([command]) => command.admission),
    ).toEqual(["occupy", "activate"]);
  });

  it("adopts compatible occupied Remote geography and preserves its epoch", async () => {
    const host = new LocalSessionHost(
      makeFakeTerminalProcessAuthority().authority,
    );
    hosts.push(host);
    let live = remoteSummary({
      bindingId: "seat-geo",
      epoch: "epoch-geo",
      status: "running",
    });
    const createAgentSeat = vi.fn(async (input) => {
      live = {
        ...live,
        harness: input.harness,
        agentKey: input.agentKey,
        canvasName: input.canvasName,
        nodeId: input.nodeId,
      };
      return live;
    });
    const when = makeActorSeatOccupy({
      local: host,
      localHostId: () => Effect.succeed("cc-self"),
      clientForOccupy: async () => ({
        get: async () => live,
        createAgentSeat,
      }),
    });

    const adopted = await Effect.runPromise(
      when.occupy(actorSpec("seat-geo", "station-a")),
    );

    expect(adopted).toMatchObject({
      epoch: "epoch-geo",
      hostId: "station-a",
      harness: "grok",
      agentKey: "local:grok",
    });
    expect(createAgentSeat).toHaveBeenCalledOnce();
  });
});
