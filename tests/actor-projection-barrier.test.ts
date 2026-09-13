/**
 * Admission barrier for Remote-placed actor seats: occupy holds until the
 * destination host acknowledges the projection compiled from committed
 * authorial state, and never starts the actor early.
 */
import { Effect } from "effect";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  ActorSeatProjectionPending,
  makeActorSeatOccupy,
  makeRemoteProjectionAdmission,
  type ActorOccupySpec,
  type ProjectionAdmissionOutcome,
  type ProjectionAdmissionRef,
  type RemoteProjectionAdmission,
  type RemoteProjectionAdmissionPorts,
} from "../src/main/vellum-command/term/actor-seat-occupy";
import {
  makeLiveProjectionAdmissionPorts,
  projectionAdmissionOutcomeOf,
  type LiveProjectionAdmissionServices,
} from "../src/main/vellum-command/term/actor-seat-occupy-live";
import { compileStationPortfolioBody } from "../src/main/vellum-command/station/portfolio";
import type { StationFleetPeerStatus } from "../src/main/vellum-command/station/fleet-propagation";
import type {
  StationConfigurationRecord,
  StationProjection,
} from "../src/main/vellum-command/station/repository";
import type { StationFleetTarget } from "../src/main/vellum-command/station/fleet-target-repository";
import type { DesiredProjection } from "../src/main/vellum-command/station/propagation";
import { Schema } from "effect";
import { InstallationId } from "../src/shared/installation-id";
import type { CanvasDoc } from "../src/shared/canvas";
import { StationFleetPeerUnavailable } from "../src/main/vellum-command/station/fleet-propagation";
import { LocalSessionHost } from "../src/main/vellum-command/term/local-host";
import type {
  RemoteSeatProcessClient,
} from "../src/main/vellum-command/term/seat-process";
import type { TerminalSessionSummary } from "../src/shared/terminal";
import {
  makeProcessIdentityMap,
  setProcessIdentityMapForTests,
} from "../src/main/vellum-command/process-identity";
import { setProcessEpochReaderForTests } from "../src/main/vellum-command/process-epoch";
import { makeFakeTerminalProcessAuthority } from "./helpers/fake-terminal-process-authority";
import type { FakeTerminalProcessAuthority } from "./helpers/fake-terminal-process-authority";

const SHA = "b".repeat(64);

const ref = (generation: string): ProjectionAdmissionRef => ({
  generation,
  contentSha256: SHA,
});

const ports = (
  over: Partial<RemoteProjectionAdmissionPorts> = {},
): RemoteProjectionAdmissionPorts => ({
  localRole: () => Effect.succeed("command-center"),
  isFleetTarget: () => Effect.succeed(true),
  compileDesired: () => Effect.succeed(ref("7")),
  awaitApplied: (_hostId, desired) =>
    Effect.succeed<ProjectionAdmissionOutcome>({ ok: true, acked: desired }),
  seatProjected: () => Effect.succeed(true),
  ...over,
});

const admit = (
  admission: RemoteProjectionAdmission,
  hostId = "station-a",
  bindingId = "seat-1",
) => Effect.runPromise(Effect.result(admission({ hostId, bindingId })));

describe("makeRemoteProjectionAdmission", () => {
  it("awaits exactly the compiled desired reference, then checks the acked seat", async () => {
    const awaited: Array<{
      readonly hostId: string;
      readonly desired: ProjectionAdmissionRef;
    }> = [];
    const seatChecks: Array<ProjectionAdmissionRef> = [];
    const admission = makeRemoteProjectionAdmission(
      ports({
        awaitApplied: (hostId, desired) =>
          Effect.sync(() => {
            awaited.push({ hostId, desired });
            // The Remote acknowledged a strictly newer covering generation.
            return { ok: true, acked: ref("8") };
          }),
        seatProjected: (acked) =>
          Effect.sync(() => {
            seatChecks.push(acked);
            return true;
          }),
      }),
    );

    const result = await admit(admission);

    expect(result._tag).toBe("Success");
    expect(awaited).toEqual([{ hostId: "station-a", desired: ref("7") }]);
    // Seat presence is confirmed against the acknowledged generation, which
    // may supersede the desired one.
    expect(seatChecks).toEqual([ref("8")]);
  });

  it("passes through untouched off the Command Center role and off the fleet", async () => {
    const compiles = vi.fn(() => Effect.succeed(ref("7")));

    const offRole = makeRemoteProjectionAdmission(
      ports({
        localRole: () => Effect.succeed("remote"),
        compileDesired: compiles,
      }),
    );
    const offFleet = makeRemoteProjectionAdmission(
      ports({
        isFleetTarget: () => Effect.succeed(false),
        compileDesired: compiles,
      }),
    );

    expect((await admit(offRole))._tag).toBe("Success");
    expect((await admit(offFleet))._tag).toBe("Success");
    expect(compiles).not.toHaveBeenCalled();
  });

  it("returns the typed pending verdict when the Remote has not acknowledged", async () => {
    const seatProjected = vi.fn(() => Effect.succeed(true));
    const admission = makeRemoteProjectionAdmission(
      ports({
        awaitApplied: () =>
          Effect.succeed<ProjectionAdmissionOutcome>({
            ok: false,
            reason: "remote-unavailable",
            message: "Remote host station-a is not reachable",
          }),
        seatProjected,
      }),
    );

    const result = await admit(admission);

    expect(result._tag).toBe("Failure");
    if (result._tag === "Failure") {
      expect(result.failure).toBeInstanceOf(ActorSeatProjectionPending);
      expect(result.failure).toMatchObject({
        reason: "remote-unavailable",
        hostId: "station-a",
        bindingId: "seat-1",
      });
    }
    expect(seatProjected).not.toHaveBeenCalled();
  });

  it("refuses when the acknowledged generation does not project the seat", async () => {
    const admission = makeRemoteProjectionAdmission(
      ports({ seatProjected: () => Effect.succeed(false) }),
    );

    const result = await admit(admission);

    expect(result._tag).toBe("Failure");
    if (result._tag === "Failure") {
      expect(result.failure).toMatchObject({
        _tag: "ActorSeatProjectionPending",
        reason: "seat-not-projected",
      });
    }
  });
});

describe("projectionAdmissionOutcomeOf", () => {
  it("maps peer unavailability and deadline to distinct pending reasons", () => {
    const failure = (
      reason: StationFleetPeerUnavailable["reason"],
    ): ProjectionAdmissionOutcome =>
      projectionAdmissionOutcomeOf({
        ok: false,
        hostId: "station-a",
        error: StationFleetPeerUnavailable.make({
          hostId: "station-a",
          reason,
          message: "test failure",
        }),
      } as never);

    expect(failure("connection-failed")).toMatchObject({
      ok: false,
      reason: "remote-unavailable",
    });
    expect(failure("not-running")).toMatchObject({
      ok: false,
      reason: "remote-unavailable",
    });
    expect(failure("deadline")).toMatchObject({
      ok: false,
      reason: "not-acknowledged",
    });
    expect(failure("synchronization-failed")).toMatchObject({
      ok: false,
      reason: "not-acknowledged",
    });
  });
});

describe("ActorSeatOccupy Remote projection barrier", () => {
  const hosts: LocalSessionHost[] = [];
  const syntheticEpochs = new Map<number, string>();

  /**
   * Barrier tests prove admission, never shutdown timing. Stubborn synthetic
   * fakes (exitOnSignal: false) must not pay the production TERM/KILL/late
   * windows in afterEach cleanup.
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

  it("never opens the Remote transport while the barrier is pending", async () => {
    const host = hostWith(makeFakeTerminalProcessAuthority());
    const clientForOccupy = vi.fn(
      async (): Promise<RemoteSeatProcessClient> => {
        throw new Error("barrier must decide before any Remote transport");
      },
    );
    const when = makeActorSeatOccupy({
      local: host,
      localHostId: () => Effect.succeed("cc-self"),
      clientForOccupy,
      remoteProjectionAdmission: ({ hostId, bindingId }) =>
        Effect.fail(
          ActorSeatProjectionPending.make({
            hostId,
            bindingId,
            reason: "not-acknowledged",
            message:
              "Remote host station-a has not acknowledged the latest canvas projection",
          }),
        ),
    });

    const result = await Effect.runPromise(
      Effect.result(when.occupy(actorSpec("seat-r", "station-a"))),
    );

    expect(result._tag).toBe("Failure");
    if (result._tag === "Failure") {
      expect(result.failure).toBeInstanceOf(ActorSeatProjectionPending);
    }
    expect(clientForOccupy).not.toHaveBeenCalled();
  });

  it("proceeds to Remote occupation after the barrier admits", async () => {
    const host = hostWith(makeFakeTerminalProcessAuthority());
    let live: TerminalSessionSummary | undefined;
    const remoteClient: RemoteSeatProcessClient = {
      get: async () => live,
      createAgentSeat: async (input) => {
        live = {
          hostId: "station-a",
          detached: false,
          createdAt: 1,
          bindingId: input.bindingId,
          epoch: "epoch-remote",
          status: "running",
          harness: input.harness,
          agentKey: input.agentKey,
          canvasName: input.canvasName,
          nodeId: input.nodeId,
        };
        return live;
      },
    };
    const admissionCalls: Array<{ hostId: string; bindingId: string }> = [];
    const when = makeActorSeatOccupy({
      local: host,
      localHostId: () => Effect.succeed("cc-self"),
      clientForOccupy: async () => remoteClient,
      remoteProjectionAdmission: (input) =>
        Effect.sync(() => {
          admissionCalls.push(input);
        }),
    });

    const summary = await Effect.runPromise(
      when.occupy(actorSpec("seat-ok", "station-a")),
    );

    expect(summary).toMatchObject({
      bindingId: "seat-ok",
      hostId: "station-a",
      status: "running",
    });
    expect(admissionCalls).toEqual([
      { hostId: "station-a", bindingId: "seat-ok" },
    ]);
  });

  it("keeps local actor seats entirely outside the barrier", async () => {
    setProcessIdentityMapForTests(
      makeProcessIdentityMap({
        processAlive: () => true,
        readProcessStartKey: (pid) => syntheticEpochs.get(pid),
      }),
    );
    syntheticEpochs.set(42_800, "synthetic-42800");
    const fake = makeFakeTerminalProcessAuthority(() => ({
      pid: 42_800,
      exitOnSignal: false,
    }));
    const host = hostWith(fake);
    const admission = vi.fn(() => Effect.void);
    const when = makeActorSeatOccupy({
      local: host,
      localHostId: () => Effect.succeed("cc-self"),
      clientForOccupy: async () => {
        throw new Error("local occupy must not open a Remote client");
      },
      remoteProjectionAdmission: admission,
    });

    const summary = await Effect.runPromise(
      when.occupy(actorSpec("seat-local", "cc-self")),
    );

    expect(summary.status).toBe("running");
    expect(admission).not.toHaveBeenCalled();
  });
});

describe("makeLiveProjectionAdmissionPorts", () => {
  const installation = Schema.decodeUnknownSync(InstallationId)(
    "install-station",
  );
  const configured = (role: "command-center" | "remote") =>
    ({ configuration: { role } }) as StationConfigurationRecord;

  const actorDoc = (bindingId: string): CanvasDoc => ({
    nodes: [
      {
        id: "agent-a",
        type: "text",
        x: 0,
        y: 0,
        width: 240,
        height: 100,
        text: "actor",
        ether: {
          entity: { kind: "agent", name: "station-a:codex" },
          terminal: {
            bindingId,
            launch: { kind: "harness", argv: ["codex"] },
            harness: "codex",
          },
          host: "station-a",
        },
      },
    ],
    edges: [],
  });

  const portfolioBody = compileStationPortfolioBody(
    new Map([["factory", actorDoc("seat-1")]]),
    new Map([["station-a", installation]]),
  );

  const coveringStatus = (generation: string): StationFleetPeerStatus =>
    ({
      hostId: "station-a",
      stationInstallationId: installation,
      lastReceipt: {
        projection: {
          active: { generation, contentSha256: SHA },
        },
      },
    }) as unknown as StationFleetPeerStatus;

  const services = (
    over: {
      readonly [K in keyof LiveProjectionAdmissionServices]?: Partial<
        LiveProjectionAdmissionServices[K]
      >;
    } = {},
  ): LiveProjectionAdmissionServices => ({
    station: {
      configuration: Effect.succeed(configured("command-center")),
      projectionByReference: () =>
        Effect.succeed({ body: portfolioBody } as StationProjection),
      ...over.station,
    },
    propagation: {
      desiredProjectionForHost: () =>
        Effect.succeed({
          generation: "7",
          contentSha256: SHA,
        } as DesiredProjection),
      ...over.propagation,
    },
    fleetPropagation: {
      status: () => Effect.succeed(coveringStatus("7")),
      synchronize: () => Effect.succeed([]),
      ...over.fleetPropagation,
    },
    fleetTargets: {
      get: () => Effect.succeed({} as StationFleetTarget),
      ...over.fleetTargets,
    },
  });

  it("admits through the complete live port chain on an acknowledged projected seat", async () => {
    const admission = makeRemoteProjectionAdmission(
      makeLiveProjectionAdmissionPorts(services()),
    );

    const result = await admit(admission, "station-a", "seat-1");

    expect(result._tag).toBe("Success");
  });

  it("refuses with seat-not-projected when the acknowledged portfolio lacks the seat", async () => {
    const admission = makeRemoteProjectionAdmission(
      makeLiveProjectionAdmissionPorts(services()),
    );

    const result = await admit(admission, "station-a", "seat-unprojected");

    expect(result._tag).toBe("Failure");
    if (result._tag === "Failure") {
      expect(result.failure).toBeInstanceOf(ActorSeatProjectionPending);
      expect(result.failure).toMatchObject({ reason: "seat-not-projected" });
    }
  });

  it("refuses with seat-not-projected when the acknowledged generation is not stored", async () => {
    const admission = makeRemoteProjectionAdmission(
      makeLiveProjectionAdmissionPorts(
        services({
          station: {
            projectionByReference: () => Effect.succeed(undefined),
          },
        }),
      ),
    );

    const result = await admit(admission, "station-a", "seat-1");

    expect(result._tag).toBe("Failure");
    if (result._tag === "Failure") {
      expect(result.failure).toMatchObject({ reason: "seat-not-projected" });
    }
  });

  it("maps an uncovered acknowledgement to the typed not-acknowledged verdict", async () => {
    // No receipt covers the desired generation and reconciliation returns
    // nothing for the host: awaitFleetProjectionApplied times out through the
    // real deadline mapping only in the live plane, so here the fake
    // synchronize answers with a deadline failure result.
    const admission = makeRemoteProjectionAdmission(
      makeLiveProjectionAdmissionPorts(
        services({
          fleetPropagation: {
            status: () => Effect.succeed(undefined),
            synchronize: () =>
              Effect.succeed([
                {
                  ok: false,
                  hostId: "station-a",
                  error: { reason: "deadline" },
                } as never,
              ]),
          },
        }),
      ),
    );

    const result = await admit(admission, "station-a", "seat-1");

    expect(result._tag).toBe("Failure");
    if (result._tag === "Failure") {
      expect(result.failure).toBeInstanceOf(ActorSeatProjectionPending);
      expect(result.failure).toMatchObject({ reason: "not-acknowledged" });
    }
  });

  it("treats an undecodable host id as off the fleet and passes through", async () => {
    const get = vi.fn(() => Effect.succeed({} as StationFleetTarget));
    const admission = makeRemoteProjectionAdmission(
      makeLiveProjectionAdmissionPorts(
        services({ fleetTargets: { get } }),
      ),
    );

    const result = await admit(admission, "-not-a-host-id!", "seat-1");

    expect(result._tag).toBe("Success");
    expect(get).not.toHaveBeenCalled();
  });

  it("passes through when the local role is not Command Center", async () => {
    const desired = vi.fn(() =>
      Effect.succeed({
        generation: "7",
        contentSha256: SHA,
      } as DesiredProjection),
    );
    const admission = makeRemoteProjectionAdmission(
      makeLiveProjectionAdmissionPorts(
        services({
          station: { configuration: Effect.succeed(configured("remote")) },
          propagation: { desiredProjectionForHost: desired },
        }),
      ),
    );

    const result = await admit(admission, "station-a", "seat-1");

    expect(result._tag).toBe("Success");
    expect(desired).not.toHaveBeenCalled();
  });
});
