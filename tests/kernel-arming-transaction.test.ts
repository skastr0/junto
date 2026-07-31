import { Effect, Layer, ManagedRuntime, Schema } from "effect";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

// Arming is transactional: the typed SQLite repository write lands
// before the in-memory arming map is mutated, so a failed persist leaves
// memory and disk in sync (the change did not stick) and the caller learns
// { ok:false } instead of the old fire-and-forget that diverged them and
// discarded the rejection.

import {
  CanvasError,
  CanvasesService,
} from "../src/main/vellum/canvases";
import { SnapshotsService } from "../src/main/vellum/snapshots";
import { ChatService, ChatServiceContext } from "../src/main/vellum/chat/service";
import type { SpawnFn } from "../src/main/vellum/chat/acp-client";
import { KernelLive, KernelService } from "../src/main/vellum/kernel/service";
import {
  KernelStatePersistenceError,
  KernelStateRepository,
} from "../src/main/vellum/kernel/repository";
import { SchedulerRepository } from "../src/main/vellum/scheduler/repository";
import { StationFleetTargetRepository } from "../src/main/vellum/station/fleet-target-repository";
import { StationRepository } from "../src/main/vellum/station/repository";
import { StationLivePeerRegistry } from "../src/main/vellum/station/session-registry";
import {
  PausePlane,
  PausePlaneAllPlaying,
} from "../src/main/vellum/pause-plane";
import {
  __resetKernelMemoryForTest,
  getArmed,
  getPulseLog,
} from "../src/main/vellum/kernel/cycle";
import { WorkService } from "../src/main/vellum/work/service";
import { WorkRepository } from "../src/main/vellum/work/repository";
import { InstallationId } from "../src/shared/installation-id";

const noSpawn: SpawnFn = () => { throw new Error("unexpected ACP spawn"); };
const localInstallationId =
  Schema.decodeUnknownSync(InstallationId)("kernel-test-installation");

const check = (id: string) => ({ id, label: id, status: "ok" as const, detail: "" });
const emptyDoc = (name: string) => ({
  name,
  doc: { nodes: [], edges: [] },
  actorRefs: [],
  revision: `${name}-r1`,
  workRevision: "0",
});

const fakeCanvases = Layer.succeed(
  CanvasesService,
  CanvasesService.of({
    doctor: Effect.succeed(check("canvases")),
    list: Effect.succeed([]),
    read: (name: string) => Effect.succeed(emptyDoc(name)),
    readWithIntentWitness: () =>
      Effect.fail(new CanvasError({ message: "not used" })),
    write: () => Effect.succeed({ revision: "written-r1" }),
    mutate: () => Effect.void,
    create: (name: string) => Effect.succeed(emptyDoc(name)),
    remove: (name: string) => Effect.succeed({ name }),
    ensureSeed: Effect.void,
    writeSidecar: () => Effect.succeed(""),
    start: () => {},
    subscribeChanges: () => () => {},
    liveDocuments: () => Effect.succeed([]),
    liveAuthorityGeneration: () => Effect.succeed("0"),
    authoritySnapshot: () =>
      Effect.succeed({
        generation: "0",
        intentSha256: "a".repeat(64),
        documents: new Map(),
      }),
    activeIntentWitness: () =>
      Effect.succeed({
        generation: "0",
        contentSha256: "a".repeat(64),
      }),
    activeActorRefs: () => Effect.succeed([]),
  }),
);

const fakeSnapshots = Layer.succeed(
  SnapshotsService,
  SnapshotsService.of({
    doctor: Effect.succeed(check("snapshots")),
    current: Effect.succeed({ bundles: [] }),
    refresh: () => Effect.succeed({ bundles: [] }),
    start: () => {},
    subscribe: () => () => {},
  }),
);

type ArmingWrite = {
  readonly canvasName: string;
  readonly regionId: string;
  readonly armed: boolean;
};

type KernelFixtureOptions = {
  readonly setFails?: boolean;
  readonly onPauseStart?: () => void;
};

// A repository whose write can be forced to fail, recording every successful
// domain mutation so the test can assert what actually reached persistence.
const makeKernelState = (
  opts: KernelFixtureOptions,
  writes: ArmingWrite[],
) =>
  Layer.succeed(
    KernelStateRepository,
    KernelStateRepository.of({
      listArmedRegions: Effect.succeed([]),
      setRegionArmed: (canvasName, regionId, armed) =>
        opts.setFails
          ? Effect.fail(
              KernelStatePersistenceError.make({
                operation: "set region armed",
                message: "disk full",
                cause: new Error("disk full"),
              }),
            )
          : Effect.sync(() =>
              void writes.push({ canvasName, regionId, armed })
            ),
      replaceDebugPulseRing: () => Effect.void,
      readDebugPulseRing: Effect.succeed([]),
    }),
  );

const makeKernelRuntime = (
  opts: KernelFixtureOptions,
  writes: ArmingWrite[],
) => {
  const deps = Layer.mergeAll(
    fakeCanvases,
    fakeSnapshots,
    makeKernelState(opts, writes),
    Layer.succeed(ChatServiceContext, new ChatService(noSpawn, (host) => host === "local")),
    Layer.succeed(
      StationRepository,
      StationRepository.of({
        installationId: Effect.succeed(localInstallationId),
        pairing: Effect.succeed(undefined),
        configuration: Effect.succeed(undefined),
        projection: Effect.succeed(undefined),
        projectionByReference: () => Effect.succeed(undefined),
        archiveProjection: () =>
          Effect.dieMessage("unused station repository"),
        pair: () => Effect.dieMessage("unused station repository"),
        configureRemote: () => Effect.dieMessage("unused station repository"),
        installProjection: () => Effect.dieMessage("unused station repository"),
        statusFacts: Effect.dieMessage("unused station repository"),
      }),
    ),
    Layer.succeed(
      StationFleetTargetRepository,
      StationFleetTargetRepository.of({
        bind: () => Effect.dieMessage("unused fleet target repository"),
        get: () => Effect.succeed(undefined),
        list: Effect.succeed([]),
        remove: () => Effect.dieMessage("unused fleet target repository"),
        subscribeChanges: () => () => {},
      }),
    ),
    Layer.succeed(
      StationLivePeerRegistry,
      StationLivePeerRegistry.of({
        activate: () => Effect.dieMessage("unused live peer registry"),
        require: () => Effect.dieMessage("unused live peer registry"),
        isLive: () => Effect.succeed(false),
        subscribe: () => () => {},
        withSession: (_witness, effect) => effect,
      }),
    ),
    Layer.succeed(
      WorkRepository,
      WorkRepository.of({
        readSnapshot: () => Effect.dieMessage("unused work repository"),
        snapshotsForCanvas: () =>
          Effect.dieMessage("unused work repository"),
        itemHome: () => Effect.dieMessage("unused work repository"),
        hasAcceptedDelivery: () =>
          Effect.dieMessage("unused work repository"),
        acceptedDeliveryAt: () =>
          Effect.dieMessage("unused work repository"),
        createTask: () => Effect.dieMessage("unused work repository"),
        createProposal: () => Effect.dieMessage("unused work repository"),
        approveProposal: () => Effect.dieMessage("unused work repository"),
        describeTask: () => Effect.dieMessage("unused work repository"),
        transitionTask: () => Effect.dieMessage("unused work repository"),
        claimLocalTask: () => Effect.dieMessage("unused work repository"),
        createRequest: () => Effect.dieMessage("unused work repository"),
        resolveRequest: () => Effect.dieMessage("unused work repository"),
        appendMessage: () => Effect.dieMessage("unused work repository"),
        publishArtifact: () => Effect.dieMessage("unused work repository"),
        acceptDelivery: () => Effect.dieMessage("unused work repository"),
        createBoardTopic: () => Effect.dieMessage("unused work repository"),
        appendBoardPost: () => Effect.dieMessage("unused work repository"),
        markBoardRead: () => Effect.dieMessage("unused work repository"),
        reserveRemoteTaskClaim: () =>
          Effect.dieMessage("unused work repository"),
        enqueueRemoteCommand: () =>
          Effect.dieMessage("unused work repository"),
        enqueueRemoteProposalApproval: () =>
          Effect.dieMessage("unused work repository"),
        recordsAfter: () => Effect.dieMessage("unused work repository"),
        pendingCommands: Effect.dieMessage("unused work repository"),
        acceptRecords: () => Effect.dieMessage("unused work repository"),
        subscribeChanges: () => () => undefined,
      }),
    ),
    Layer.succeed(SchedulerRepository, {
      claimInterval: () =>
        Effect.succeed({
          _tag: "Ineligible" as const,
          reason: "invalid-state" as const,
        }),
      reconcileHome: () => Effect.succeed(0),
      readIntervalState: () => Effect.succeed(undefined),
    }),
    Layer.succeed(
      WorkService,
      WorkService.of({
        workTaskHome: () => Effect.dieMessage("unused work service"),
        workTaskCreate: () => Effect.dieMessage("unused work service"),
        workTaskPropose: () => Effect.dieMessage("unused work service"),
        workTaskApproveProposal: () => Effect.dieMessage("unused work service"),
        workTaskDescribe: () => Effect.dieMessage("unused work service"),
        workTaskTransition: () => Effect.dieMessage("unused work service"),
        workTaskRespond: () => Effect.dieMessage("unused work service"),
        workTaskClaim: () => Effect.dieMessage("unused work service"),
        workMessageAppend: () => Effect.dieMessage("unused work service"),
        workMessageMarkRead: () => Effect.dieMessage("unused work service"),
        workRequestCreate: () => Effect.dieMessage("unused work service"),
        workRequestResolve: () => Effect.dieMessage("unused work service"),
        workArtifactPublish: () => Effect.dieMessage("unused work service"),
        workBoardList: () => Effect.dieMessage("unused work service"),
        workBoardCreateTopic: () => Effect.dieMessage("unused work service"),
        workBoardPost: () => Effect.dieMessage("unused work service"),
        workBoardMarkRead: () => Effect.dieMessage("unused work service"),
        commandStatus: Effect.dieMessage("unused work service"),
      }),
    ),
  );
  const pauseLayer =
    opts.onPauseStart === undefined
      ? PausePlaneAllPlaying
      : Layer.succeed(PausePlane, {
          start: Effect.sync(opts.onPauseStart),
          stateFor: () => ({
            playing: true,
            everPlayed: true,
            pausedNodes: [],
            pausedRegions: [],
          }),
          setPlaying: () => Effect.void,
          setScopePaused: () => Effect.void,
          subscribe: () => () => {},
        });
  const layer = Layer.provide(KernelLive, Layer.mergeAll(deps, pauseLayer));
  return ManagedRuntime.make(layer);
};

const runArm = (
  opts: KernelFixtureOptions,
  writes: ArmingWrite[],
  canvasName: string,
  regionId: string,
  armed: boolean,
) => {
  const runtime = makeKernelRuntime(opts, writes);
  return runtime
    .runPromise(
      Effect.flatMap(KernelService, (kernel) =>
        kernel.armRegion(canvasName, regionId, armed),
      ),
    )
    .finally(() => runtime.dispose());
};

beforeEach(() => {
  __resetKernelMemoryForTest();
});

afterEach(() => {
  __resetKernelMemoryForTest();
});

describe("KernelService.armRegion — transactional persist-then-mutate", () => {
  it("a successful repository write persists the row and flips the in-memory map", async () => {
    const writes: ArmingWrite[] = [];
    const result = await runArm({}, writes, "ether", "r1", true);

    expect(result).toEqual({ ok: true });
    expect(writes).toEqual([
      { canvasName: "ether", regionId: "r1", armed: true },
    ]);
    expect(getArmed().get("ether::r1")).toBe(true);
  });

  it("a failed repository write returns { ok:false } and leaves memory untouched", async () => {
    const writes: ArmingWrite[] = [];
    const result = await runArm(
      { setFails: true },
      writes,
      "ether",
      "r1",
      true,
    );

    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error).toMatch(/not saved/i);
    // Memory untouched — proves setArmed ran only AFTER a durable write, never before.
    expect(getArmed().has("ether::r1")).toBe(false);
    expect(writes).toEqual([]);
  });

  it("disarm is an explicit act: a successful write persists the key's removal and clears memory", async () => {
    // Arm first (durable), then disarm.
    await runArm({}, [], "ether", "r1", true);
    expect(getArmed().get("ether::r1")).toBe(true);

    const writes: ArmingWrite[] = [];
    const result = await runArm({}, writes, "ether", "r1", false);

    expect(result).toEqual({ ok: true });
    expect(writes).toEqual([
      { canvasName: "ether", regionId: "r1", armed: false },
    ]);
    expect(getArmed().get("ether::r1")).toBeFalsy();
  });

  it("a monotonic suspension refuses later arming mutations, including after repeated suspend calls", async () => {
    const writes: ArmingWrite[] = [];
    const runtime = makeKernelRuntime({}, writes);
    const result = await runtime.runPromise(
      Effect.flatMap(KernelService, (kernel) =>
        Effect.sync(() => {
          kernel.suspend();
          kernel.suspend();
        }).pipe(
          Effect.zipRight(kernel.armRegion("ether", "r1", true)),
        ),
      ),
    );
    await runtime.dispose();

    expect(result).toEqual({
      ok: false,
      error: "kernel suspended — no new arming changes are admitted",
    });
    expect(writes).toEqual([]);
    expect(getArmed().has("ether::r1")).toBe(false);
  });

  it("keeps snapshot fanout alive when one listener throws", async () => {
    const writes: ArmingWrite[] = [];
    const runtime = makeKernelRuntime({}, writes);
    let seen = 0;

    const result = await runtime.runPromise(
      Effect.flatMap(KernelService, (kernel) =>
        Effect.sync(() => {
          kernel.subscribe(() => {
            throw new Error("boom");
          });
          kernel.subscribe(() => {
            seen += 1;
          });
        }).pipe(Effect.zipRight(kernel.armRegion("ether", "r1", true))),
      ),
    );
    await runtime.dispose();

    expect(result).toEqual({ ok: true });
    expect(seen).toBe(1);
    expect(writes).toEqual([
      { canvasName: "ether", regionId: "r1", armed: true },
    ]);
    expect(getArmed().get("ether::r1")).toBe(true);
  });

  it("a manual pulse invoked after suspension is a no-op", async () => {
    const runtime = makeKernelRuntime({}, []);
    await runtime.runPromise(
      Effect.flatMap(KernelService, (kernel) =>
        Effect.sync(() => kernel.suspend()).pipe(
          Effect.zipRight(
            kernel.pulseRegion("ether", "r1", {
              summary: "must not be delivered",
            }),
          ),
        ),
      ),
    );
    await runtime.dispose();

    expect(getPulseLog()).toEqual([]);
  });

  it("start invoked after suspension does not begin kernel hydration or scheduling", async () => {
    let pauseStarts = 0;
    const runtime = makeKernelRuntime(
      {
        onPauseStart: () => {
          pauseStarts += 1;
        },
      },
      [],
    );
    await runtime.runPromise(
      Effect.flatMap(KernelService, (kernel) =>
        Effect.sync(() => {
          kernel.suspend();
          kernel.start();
        }),
      ),
    );
    await Promise.resolve();
    await runtime.dispose();

    expect(pauseStarts).toBe(0);
  });
});
