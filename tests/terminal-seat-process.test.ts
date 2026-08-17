import { mkdtempSync, mkdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Effect, Exit } from "effect";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { LocalSessionHost } from "../src/main/vellum/term/local-host";
import {
  makeLocalSeatProcess,
  makeRemoteSeatProcess,
  type OccupySpec,
  type RemoteAgentSeatCommand,
} from "../src/main/vellum/term/seat-process";
import type { TerminalSessionSummary } from "../src/shared/terminal";
import {
  occupancyFromSession,
  occupyVacantSeat,
  seatAdmission,
} from "../src/shared/terminal-seat-occupancy";
import {
  makeProcessIdentityMap,
  setProcessIdentityMapForTests,
} from "../src/main/vellum/process-identity";
import { setProcessEpochReaderForTests } from "../src/main/vellum/process-epoch";
import { __setSessionExistenceHomeForTest } from "../src/main/vellum/term/session-existence";
import { makeFakeTerminalProcessAuthority } from "./helpers/fake-terminal-process-authority";

const hosts: LocalSessionHost[] = [];
const syntheticEpochs = new Map<number, string>();

const actorSpec = (bindingId: string, hostId?: string): OccupySpec => ({
  bindingId,
  harness: "grok",
  agentKey: "local:grok",
  canvasName: "factory",
  nodeId: `node-${bindingId}`,
  spawnIntent: {
    documentLaunch: { kind: "harness", argv: ["grok"] },
    resumeRequested: false,
    injection: { seatBound: false, connected: false },
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
  canvasName: "factory",
  nodeId: `node-${over.bindingId}`,
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

const vacantCommand = (bindingId: string, placement: "local" | "remote") => {
  const command = occupyVacantSeat(
    occupancyFromSession(bindingId, undefined, placement),
  );
  if (command._tag !== "Success") throw new Error("expected occupy command");
  return command.success;
};

describe("local TerminalSeatProcess", () => {
  it("occupies vacant seats, activates occupied ones, and rejects an occupy race", async () => {
    setProcessIdentityMapForTests(makeProcessIdentityMap({
    processAlive: () => true,
    readProcessStartKey: (pid) => `synthetic-${pid}`,
  }));
    syntheticEpochs.set(42_600, "synthetic-42600");
    const fake = makeFakeTerminalProcessAuthority(() => ({
      pid: 42_600,
      exitOnSignal: false,
    }));
    const host = new LocalSessionHost(fake.authority);
    hosts.push(host);
    const createAgentSeat = vi.spyOn(host, "createAgentSeat");
    const seats = makeLocalSeatProcess(host);
    const occupy = vacantCommand("seat-p", "local");

    const created = await Effect.runPromise(
      seats.occupy(occupy, actorSpec("seat-p")),
    );
    expect(created.status).toBe("running");
    expect(created.harness).toBe("grok");
    expect(created.agentKey).toBe("local:grok");
    expect(fake.controllers).toHaveLength(1);
    expect(createAgentSeat).toHaveBeenCalledOnce();
    const localInput = createAgentSeat.mock.calls[0]?.[0];
    expect(localInput).toMatchObject({ launch: { kind: "harness" } });
    expect(localInput?.launch?.argv).toEqual(expect.arrayContaining(["grok"]));
    expect(localInput).not.toHaveProperty("spawnIntent");
    expect(localInput?.resumeFallbackIntent).toEqual(
      actorSpec("seat-p").spawnIntent,
    );

    const admission = seatAdmission(
      await Effect.runPromise(seats.occupancy("seat-p")),
    );
    if (admission._tag !== "ActivateOccupiedSeat") {
      throw new Error("expected activate");
    }
    const activated = await Effect.runPromise(
      seats.activate(admission, {
        harness: "grok",
        agentKey: "local:grok",
        canvasName: "factory",
        nodeId: "node-seat-p",
      }),
    );
    expect(activated.epoch).toBe(created.epoch);
    expect(fake.controllers).toHaveLength(1);
    expect(fake.controllers[0]?.signals).toEqual([]);

    const raced = await Effect.runPromiseExit(
      seats.occupy(occupy, actorSpec("seat-p")),
    );
    expect(Exit.isFailure(raced)).toBe(true);
    expect(host.runningCount()).toBe(1);
  });

  it("adopts occupied geography with actor process-bind anchors and refuses a different harness", async () => {
    const identities = makeProcessIdentityMap({
      processAlive: () => true,
      readProcessStartKey: (pid) => syntheticEpochs.get(pid),
    });
    setProcessIdentityMapForTests(identities);
    syntheticEpochs.set(42_601, "synthetic-42601");
    const fake = makeFakeTerminalProcessAuthority(() => ({
      pid: 42_601,
      exitOnSignal: false,
    }));
    const host = new LocalSessionHost(fake.authority);
    hosts.push(host);
    const seats = makeLocalSeatProcess(host);
    const geography = host.create({
      bindingId: "seat-g",
      launch: { kind: "shell" },
    });

    const admission = seatAdmission(
      await Effect.runPromise(seats.occupancy("seat-g")),
    );
    if (admission._tag !== "ActivateOccupiedSeat") {
      throw new Error("expected activate");
    }
    const adopted = await Effect.runPromise(
      seats.activate(admission, {
        harness: "grok",
        agentKey: "local:grok",
        canvasName: "factory",
        nodeId: "actor-node",
      }),
    );
    expect(adopted).toMatchObject({
      epoch: geography.epoch,
      harness: "grok",
      agentKey: "local:grok",
      canvasName: "factory",
      nodeId: "actor-node",
    });
    expect(identities.resolve(42_601)).toEqual({
      agentKey: "local:grok",
      canvasName: "factory",
      nodeId: "actor-node",
    });
    expect(fake.controllers).toHaveLength(1);

    const mismatch = await Effect.runPromiseExit(
      seats.activate(admission, {
        harness: "claude",
        agentKey: "local:claude",
        canvasName: "factory",
        nodeId: "actor-node",
      }),
    );
    expect(Exit.isFailure(mismatch)).toBe(true);
    expect(host.get("seat-g")?.harness).toBe("grok");
  });

  it("replans a dead proven resume as a fresh injected generation", async () => {
    const priorVellumHome = process.env.VELLUM_COMMAND_HOME;
    const proofHome = mkdtempSync(join(tmpdir(), "seat-resume-proof-"));
    const workDir = join(proofHome, "work");
    const sessionId = "aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee";
    mkdirSync(workDir, { recursive: true });
    mkdirSync(
      join(
        proofHome,
        ".grok",
        "sessions",
        encodeURIComponent(workDir),
        sessionId,
      ),
      { recursive: true },
    );
    delete process.env.VELLUM_COMMAND_HOME;
    __setSessionExistenceHomeForTest(proofHome);
    try {
      setProcessIdentityMapForTests(makeProcessIdentityMap({
    processAlive: () => true,
    readProcessStartKey: (pid) => `synthetic-${pid}`,
  }));
      const fake = makeFakeTerminalProcessAuthority((_spec, index) => {
        const pid = 42_610 + index;
        syntheticEpochs.set(pid, `synthetic-${pid}`);
        return {
          pid,
          ...(index === 0 ? { exitImmediately: true as const } : {}),
          exitOnSignal: false,
        };
      });
      const host = new LocalSessionHost(fake.authority);
      hosts.push(host);
      const createAgentSeat = vi.spyOn(host, "createAgentSeat");
      const seats = makeLocalSeatProcess(host);

      const returned = await Effect.runPromise(
        seats.occupy(vacantCommand("seat-resume", "local"), {
          bindingId: "seat-resume",
          harness: "grok",
          agentKey: "local:grok",
          canvasName: "factory",
          nodeId: "node-seat-resume",
          spawnIntent: {
            documentLaunch: {
              kind: "harness",
              argv: ["grok", "--session-id", sessionId],
              cwd: workDir,
            },
            cwd: workDir,
            sessionId,
            resumeRequested: true,
            injection: {
              seatBound: true,
              connected: true,
              seatRef: "node-seat-resume",
            },
          },
        }),
      );
      const initiallyReturned = createAgentSeat.mock.results[0]?.value;

      expect(returned.status).toBe("running");
      expect(returned.epoch).toBe(host.get("seat-resume")?.epoch);
      expect(returned.epoch).not.toBe(initiallyReturned?.epoch);
      expect(fake.controllers.length).toBeGreaterThanOrEqual(2);
      expect(fake.controllers[0]?.spec.args).toEqual(
        expect.arrayContaining(["-r", sessionId]),
      );
      expect(fake.controllers[0]?.spec.args).not.toContain("--rules");
      expect(fake.controllers[1]?.spec.args).toContain("--rules");
      expect(fake.controllers[1]?.spec.args).not.toContain("-r");
    } finally {
      __setSessionExistenceHomeForTest(undefined);
      rmSync(proofHome, { recursive: true, force: true });
      if (priorVellumHome === undefined) delete process.env.VELLUM_COMMAND_HOME;
      else process.env.VELLUM_COMMAND_HOME = priorVellumHome;
    }
  });
});

describe("Remote TerminalSeatProcess", () => {
  it("rejects an occupied lower-level occupy race and activates an exact actor", async () => {
    const live = remoteSummary({
      bindingId: "seat-r",
      epoch: "epoch-1",
      status: "running",
      harness: "grok",
      agentKey: "local:grok",
    });
    const createAgentSeat = vi.fn(async () => live);
    const seats = makeRemoteSeatProcess("station-a", {
      get: async () => live,
      createAgentSeat,
    });
    const occupy = vacantCommand("seat-r", "remote");

    const raced = await Effect.runPromiseExit(
      seats.occupy(occupy, actorSpec("seat-r", "station-a")),
    );
    expect(Exit.isFailure(raced)).toBe(true);

    const occupancy = await Effect.runPromise(seats.occupancy("seat-r"));
    expect(occupancy).toMatchObject({
      _tag: "OccupiedSeat",
      placement: "remote",
      epoch: "epoch-1",
    });
    const admission = seatAdmission(occupancy);
    if (admission._tag !== "ActivateOccupiedSeat") {
      throw new Error("expected activate");
    }
    const activated = await Effect.runPromise(
      seats.activate(admission, {
        harness: "grok",
        agentKey: "local:grok",
        canvasName: "factory",
        nodeId: "node-seat-r",
      }),
    );
    expect(activated).toMatchObject({
      epoch: "epoch-1",
      hostId: "station-a",
    });
    expect(createAgentSeat).toHaveBeenCalledWith({
      admission: "activate",
      bindingId: "seat-r",
      expectedEpoch: "epoch-1",
      harness: "grok",
      agentKey: "local:grok",
      canvasName: "factory",
      nodeId: "node-seat-r",
    });
  });

  it.each([
    ["exact actor", { harness: "grok", agentKey: "local:grok" }],
    ["geography", {}],
  ] as const)(
    "rejects a wrong-binding %s get reply before any Remote mutation",
    async (_kind, identity) => {
      const wrongBinding = remoteSummary({
        bindingId: "seat-other",
        epoch: "epoch-other",
        status: "running",
        ...identity,
      });
      const createAgentSeat = vi.fn(async () => wrongBinding);
      const seats = makeRemoteSeatProcess("station-a", {
        get: async () => wrongBinding,
        createAgentSeat,
      });

      const observed = await Effect.runPromiseExit(
        seats.occupancy("seat-requested"),
      );
      const occupied = await Effect.runPromiseExit(
        seats.occupy(
          vacantCommand("seat-requested", "remote"),
          actorSpec("seat-requested", "station-a"),
        ),
      );
      const activation = seatAdmission(
        occupancyFromSession(
          "seat-requested",
          remoteSummary({
            bindingId: "seat-requested",
            epoch: "epoch-requested",
            status: "running",
            harness: "grok",
            agentKey: "local:grok",
          }),
          "remote",
        ),
      );
      if (activation._tag !== "ActivateOccupiedSeat") {
        throw new Error("expected activate");
      }
      const activated = await Effect.runPromiseExit(
        seats.activate(activation, {
          harness: "grok",
          agentKey: "local:grok",
          canvasName: "factory",
          nodeId: "node-seat-requested",
        }),
      );

      expect(Exit.isFailure(observed)).toBe(true);
      expect(Exit.isFailure(occupied)).toBe(true);
      expect(Exit.isFailure(activated)).toBe(true);
      expect(createAgentSeat).not.toHaveBeenCalled();
    },
  );

  it("occupies a vacant actor seat once and projects the requested host", async () => {
    const created = remoteSummary({
      bindingId: "seat-r",
      epoch: "epoch-new",
      status: "running",
      harness: "grok",
      agentKey: "local:grok",
    });
    const createAgentSeat = vi.fn(
      async (_input: RemoteAgentSeatCommand) => created,
    );
    const seats = makeRemoteSeatProcess("station-a", {
      get: async () => undefined,
      createAgentSeat,
    });

    const spec = actorSpec("seat-r", "station-a");
    const summary = await Effect.runPromise(
      seats.occupy(vacantCommand("seat-r", "remote"), spec),
    );
    expect(summary).toMatchObject({
      epoch: "epoch-new",
      hostId: "station-a",
      harness: "grok",
      agentKey: "local:grok",
    });
    expect(createAgentSeat).toHaveBeenCalledTimes(1);
    const forwarded = createAgentSeat.mock.calls[0]?.[0];
    expect(forwarded).toMatchObject({ spawnIntent: spec.spawnIntent });
    expect(forwarded).not.toHaveProperty("launch");
    expect(forwarded).not.toHaveProperty("firstTypedMessage");
  });

  it("returns the Remote host head after an immediate resume replacement", async () => {
    const deadSeed = remoteSummary({
      bindingId: "seat-fail-open",
      epoch: "epoch-dead-resume",
      status: "running",
      harness: "grok",
      agentKey: "local:grok",
    });
    const replacement = remoteSummary({
      bindingId: "seat-fail-open",
      epoch: "epoch-fresh-pin",
      status: "running",
      harness: "grok",
      agentKey: "local:grok",
    });
    let reads = 0;
    const createAgentSeat = vi.fn(async () => deadSeed);
    const seats = makeRemoteSeatProcess("station-a", {
      get: async () => (++reads === 1 ? undefined : replacement),
      createAgentSeat,
    });

    const occupied = await Effect.runPromise(
      seats.occupy(
        vacantCommand("seat-fail-open", "remote"),
        actorSpec("seat-fail-open", "station-a"),
      ),
    );

    expect(occupied).toMatchObject({
      epoch: "epoch-fresh-pin",
      hostId: "station-a",
      status: "running",
    });
    expect(reads).toBe(2);
    expect(createAgentSeat).toHaveBeenCalledOnce();
  });

  it.each([
    ["starting geography", "starting", undefined, undefined],
    ["running geography", "running", undefined, undefined],
    ["same harness with a stale key", "running", "grok", "old:grok"],
  ] as const)(
    "adopts %s through explicit createAgentSeat",
    async (_name, status, harness, agentKey) => {
      let live = remoteSummary({
        bindingId: "seat-adopt",
        epoch: "epoch-adopt",
        status,
        ...(harness === undefined ? {} : { harness }),
        ...(agentKey === undefined ? {} : { agentKey }),
      });
      const createAgentSeat = vi.fn(
        async (input: RemoteAgentSeatCommand) => {
          live = {
            ...live,
            harness: input.harness,
            agentKey: input.agentKey,
            canvasName: input.canvasName,
            nodeId: input.nodeId,
          };
          return live;
        },
      );
      const seats = makeRemoteSeatProcess("station-a", {
        get: async () => live,
        createAgentSeat,
      });
      const admission = seatAdmission(
        await Effect.runPromise(seats.occupancy("seat-adopt")),
      );
      if (admission._tag !== "ActivateOccupiedSeat") {
        throw new Error("expected activate");
      }

      const adopted = await Effect.runPromise(
        seats.activate(admission, {
          harness: "grok",
          agentKey: "local:grok",
          canvasName: "factory",
          nodeId: "actor-node",
        }),
      );

      expect(adopted).toMatchObject({
        bindingId: "seat-adopt",
        epoch: "epoch-adopt",
        hostId: "station-a",
        harness: "grok",
        agentKey: "local:grok",
        canvasName: "factory",
        nodeId: "actor-node",
      });
      expect(createAgentSeat).toHaveBeenCalledWith({
        admission: "activate",
        bindingId: "seat-adopt",
        expectedEpoch: "epoch-adopt",
        harness: "grok",
        agentKey: "local:grok",
        canvasName: "factory",
        nodeId: "actor-node",
      });
    },
  );

  it("refuses a different harness without asking the Remote to mutate", async () => {
    const live = remoteSummary({
      bindingId: "seat-mismatch",
      epoch: "epoch-mismatch",
      status: "running",
      harness: "claude",
      agentKey: "remote:claude",
    });
    const createAgentSeat = vi.fn(async () => live);
    const seats = makeRemoteSeatProcess("station-a", {
      get: async () => live,
      createAgentSeat,
    });
    const admission = seatAdmission(
      await Effect.runPromise(seats.occupancy("seat-mismatch")),
    );
    if (admission._tag !== "ActivateOccupiedSeat") {
      throw new Error("expected activate");
    }

    const mismatch = await Effect.runPromiseExit(
      seats.activate(admission, {
        harness: "grok",
        agentKey: "local:grok",
        canvasName: "factory",
        nodeId: "node-seat-mismatch",
      }),
    );
    expect(Exit.isFailure(mismatch)).toBe(true);
    expect(createAgentSeat).not.toHaveBeenCalled();
  });

  it("rejects an adoption reply that changes epoch or actor identity", async () => {
    const geography = remoteSummary({
      bindingId: "seat-unverified",
      epoch: "epoch-original",
      status: "running",
    });
    const seats = makeRemoteSeatProcess("station-a", {
      get: async () => geography,
      createAgentSeat: async () =>
        remoteSummary({
          bindingId: "seat-unverified",
          epoch: "epoch-replaced",
          status: "running",
          harness: "grok",
          agentKey: "wrong:key",
        }),
    });
    const admission = seatAdmission(
      await Effect.runPromise(seats.occupancy("seat-unverified")),
    );
    if (admission._tag !== "ActivateOccupiedSeat") {
      throw new Error("expected activate");
    }

    const unverified = await Effect.runPromiseExit(
      seats.activate(admission, {
        harness: "grok",
        agentKey: "local:grok",
        canvasName: "factory",
        nodeId: "node-seat-unverified",
      }),
    );
    expect(Exit.isFailure(unverified)).toBe(true);
  });
});
