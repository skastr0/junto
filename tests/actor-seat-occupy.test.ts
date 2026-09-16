import { Effect } from "effect";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  makeActorSeatOccupy,
  type ActorOccupySpec,
} from "../src/main/junto/term/actor-seat-occupy";
import { LocalSessionHost } from "../src/main/junto/term/local-host";
import {
  makeLocalSeatProcess,
  makeRemoteSeatProcess,
  type RemoteAgentSeatCommand,
  type RemoteSeatProcessClient,
} from "../src/main/junto/term/seat-process";
import type { TerminalSessionSummary } from "../src/shared/terminal";
import {
  SeatAlreadyOccupiedError,
  SeatIdentityConflictError,
  vacantSeat,
  type OccupyVacantSeat,
} from "../src/shared/terminal-seat-occupancy";
import {
  makeProcessIdentityMap,
  setProcessIdentityMapForTests,
} from "../src/main/junto/process-identity";
import { setProcessEpochReaderForTests } from "../src/main/junto/process-epoch";
import { makeFakeTerminalProcessAuthority } from "./helpers/fake-terminal-process-authority";
import type { FakeTerminalProcessAuthority } from "./helpers/fake-terminal-process-authority";

const hosts: LocalSessionHost[] = [];
const syntheticEpochs = new Map<number, string>();

/**
 * Every host here proves occupancy selection, never shutdown timing, so each
 * host defaults to short graces: a stubborn synthetic fake (exitOnSignal:
 * false) must not pay the production TERM/KILL/late windows in afterEach
 * cleanup. Shutdown-deadline proofs set their own explicit graces and live in
 * their own files.
 */
const hostWith = (
  fake: FakeTerminalProcessAuthority,
  options: ConstructorParameters<typeof LocalSessionHost>[1] = {},
): LocalSessionHost => {
  const host = new LocalSessionHost(fake.authority, {
    killGraceMs: 5,
    shutdownGraceMs: 5,
    lateExitGraceMs: 5,
    ...options,
  });
  hosts.push(host);
  return host;
};

/** These tests exercise process selection, not the projection barrier. */
const passThroughAdmission = () => Effect.void;

const actorSpec = (bindingId: string, hostId?: string): ActorOccupySpec => ({
  bindingId,
  harness: "grok",
  agentKey: "local:grok",
  canvasName: "factory",
  nodeId: `node-${bindingId}`,
  spawnIntent: {
    documentLaunch: { kind: "harness", argv: ["grok"], cwd: "/tmp" },
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
    setProcessIdentityMapForTests(
      makeProcessIdentityMap({
        processAlive: () => true,
        readProcessStartKey: (pid) => syntheticEpochs.get(pid),
      }),
    );
    syntheticEpochs.set(42_700, "synthetic-42700");
    const fake = makeFakeTerminalProcessAuthority(() => ({
      pid: 42_700,
      exitOnSignal: false,
    }));
    const host = hostWith(fake);
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
      remoteProjectionAdmission: passThroughAdmission,
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
    setProcessIdentityMapForTests(
      makeProcessIdentityMap({
        processAlive: () => true,
        readProcessStartKey: (pid) => syntheticEpochs.get(pid),
      }),
    );
    syntheticEpochs.set(42_701, "synthetic-42701");
    const fake = makeFakeTerminalProcessAuthority(() => ({
      pid: 42_701,
      exitOnSignal: false,
    }));
    const host = hostWith(fake);

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
      remoteProjectionAdmission: passThroughAdmission,
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
    const host = hostWith(makeFakeTerminalProcessAuthority());
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
      remoteProjectionAdmission: passThroughAdmission,
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

  it("refuses occupied Remote geography with a typed identity conflict", async () => {
    const host = hostWith(makeFakeTerminalProcessAuthority());
    const live = remoteSummary({
      bindingId: "seat-geo",
      epoch: "epoch-geo",
      status: "running",
    });
    const createAgentSeat = vi.fn(async () => live);
    const when = makeActorSeatOccupy({
      local: host,
      localHostId: () => Effect.succeed("cc-self"),
      clientForOccupy: async () => ({
        get: async () => live,
        createAgentSeat,
      }),
      remoteProjectionAdmission: passThroughAdmission,
    });

    const conflict = await Effect.runPromise(
      Effect.flip(when.occupy(actorSpec("seat-geo", "station-a"))),
    );

    expect(conflict).toBeInstanceOf(SeatIdentityConflictError);
    expect(createAgentSeat).not.toHaveBeenCalled();
  });
});

describe("occupy convergence liveness", () => {
  const vacantCommand = (bindingId: string): OccupyVacantSeat => ({
    _tag: "OccupyVacantSeat",
    seat: vacantSeat(bindingId, "remote"),
  });

  const stoppingSummary = (bindingId: string): TerminalSessionSummary =>
    remoteSummary({
      bindingId,
      epoch: "epoch-dying",
      status: "running",
      harness: "grok",
      agentKey: "local:grok",
      canvasName: "factory",
      nodeId: `node-${bindingId}`,
    });

  it("preserves the station failure instead of converging on a stopping incumbent", async () => {
    // Station-side occupation failed fail-closed: createAgentSeat rejects
    // after requestStop, and the dying record stays indexed (stopping: true)
    // until its exit witness settles. The losing re-read must not return it.
    const dying = { ...stoppingSummary("seat-dying"), stopping: true as const };
    let created = false;
    const how = makeRemoteSeatProcess("station-a", {
      get: async () => (created ? dying : undefined),
      createAgentSeat: async () => {
        created = true;
        throw new Error("seat seat-dying occupation failed after spawn");
      },
    });

    const failure = await Effect.runPromise(
      Effect.flip(
        how.occupy(vacantCommand("seat-dying"), actorSpec("seat-dying")),
      ),
    );

    expect(failure).toBeInstanceOf(Error);
    expect(String(failure)).toContain("occupation failed after spawn");
  });

  it("refuses pre-check convergence on a stopping same-identity incumbent", async () => {
    const dying = { ...stoppingSummary("seat-stop"), stopping: true as const };
    const createAgentSeat = vi.fn(async () => dying);
    const how = makeRemoteSeatProcess("station-a", {
      get: async () => dying,
      createAgentSeat,
    });

    const failure = await Effect.runPromise(
      Effect.flip(
        how.occupy(vacantCommand("seat-stop"), actorSpec("seat-stop")),
      ),
    );

    expect(failure).toBeInstanceOf(SeatAlreadyOccupiedError);
    expect(createAgentSeat).not.toHaveBeenCalled();
  });

  it("still converges on a live same-identity incumbent", async () => {
    const live = stoppingSummary("seat-live");
    const createAgentSeat = vi.fn(async () => live);
    const how = makeRemoteSeatProcess("station-a", {
      get: async () => live,
      createAgentSeat,
    });

    const converged = await Effect.runPromise(
      how.occupy(vacantCommand("seat-live"), actorSpec("seat-live")),
    );

    expect(converged.epoch).toBe("epoch-dying");
    expect(createAgentSeat).not.toHaveBeenCalled();
  });

  it("refuses local convergence on a killed generation that has not exited", async () => {
    setProcessIdentityMapForTests(
      makeProcessIdentityMap({
        processAlive: () => true,
        readProcessStartKey: (pid) => syntheticEpochs.get(pid),
      }),
    );
    syntheticEpochs.set(42_710, "synthetic-42710");
    const fake = makeFakeTerminalProcessAuthority(() => ({
      pid: 42_710,
      exitOnSignal: false,
    }));
    const host = hostWith(fake);
    const how = makeLocalSeatProcess(host);
    const spec = actorSpec("seat-local-dying");

    const created = await Effect.runPromise(
      how.occupy(
        {
          _tag: "OccupyVacantSeat",
          seat: vacantSeat("seat-local-dying", "local"),
        },
        spec,
      ),
    );
    expect(created.status).toBe("running");
    expect(host.kill("seat-local-dying")).toBe(true);
    expect(host.get("seat-local-dying")?.stopping).toBe(true);

    const failure = await Effect.runPromise(
      Effect.flip(
        how.occupy(
          {
            _tag: "OccupyVacantSeat",
            seat: vacantSeat("seat-local-dying", "local"),
          },
          spec,
        ),
      ),
    );

    expect(failure).toBeInstanceOf(SeatAlreadyOccupiedError);
  });
});
