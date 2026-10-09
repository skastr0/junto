import { Effect, Layer, ManagedRuntime } from "effect";
import { ObservabilityLoggerLive } from "./junto/observability";
import {
  ChatServiceFromHermesLive,
  HermesPlaneLive,
} from "./junto/hermes/plane";
import { HermesTransportLive } from "./junto/hermes/transport";
import { KernelLive } from "./junto/kernel/service";
import { KernelStateRepositoryLive } from "./junto/kernel/repository";
import { PausePlaneLive } from "./junto/pause-plane";
import { FactoryPauseRepositoryLive } from "./junto/pause/repository";
import { SchedulerRepositoryLive } from "./junto/scheduler/repository";
import { WorkLive } from "./junto/work/service";
import { ModelLive } from "./junto/model/layer";
import { WorkModelDependentsLive } from "./junto/work/model-dependents";
import { WorkRepositoryLive } from "./junto/work/repository";
import { CrewRepositoryLive } from "./junto/work/crew-repository";
import { makeContentServiceLive } from "./junto/content/service";
import { InstallOpsLive } from "./junto/install-ops/engine";
import { makeSettingsLive } from "./junto/settings/service";
import { SnapshotsLive } from "./junto/snapshots";
import { UsageLive } from "./junto/usage/live";
import { HostsServiceLive } from "./junto/hosts";
import { SshTransportLive } from "./junto/ssh";
import { StateEngineLive } from "./junto/state/engine";
import { MachineRepositoryLive } from "./junto/machines/repository";
import { SeatSessionRepositoryLive } from "./junto/seat-sessions/repository";
import { ActorSeatOccupyLive } from "./junto/term/actor-seat-occupy-live";
import {
  resolveCandidateRuntimeRootFromRemoteBinary,
  resolveReleaseDirectoryFromRemoteBinary,
} from "./junto/supervision/install-user-service";
import { resolve } from "node:path";

// ---------------------------------------------------------------------------
// Packaged / product identity (Node-safe — never electron.app)
// ---------------------------------------------------------------------------

export const isRemotePackaged = (
  binaryPath: string = process.argv[1] ?? process.execPath,
): boolean => {
  if (process.env.JUNTO_PACKAGED === "1") return true;
  const absolute = resolve(binaryPath);
  try {
    resolveReleaseDirectoryFromRemoteBinary(absolute);
    return true;
  } catch {
    // fall through to staging candidate
  }
  try {
    resolveCandidateRuntimeRootFromRemoteBinary(absolute);
    return true;
  } catch {
    return false;
  }
};

declare const __JUNTO_APP_VERSION__: string | undefined;

export const remoteAppVersion = (): string => {
  if (
    typeof process.env.JUNTO_APP_VERSION === "string" &&
    process.env.JUNTO_APP_VERSION.trim().length > 0
  ) {
    return process.env.JUNTO_APP_VERSION.trim();
  }
  if (
    typeof __JUNTO_APP_VERSION__ === "string" &&
    __JUNTO_APP_VERSION__.trim().length > 0
  ) {
    return __JUNTO_APP_VERSION__.trim();
  }
  return "0.0.0";
};

// ---------------------------------------------------------------------------
// Memoized StateEngine owner — same reference for every repository plane
// ---------------------------------------------------------------------------

// One shared settings layer reference: the usage plane's operator-credential
// reader and every other consumer get the same memoized SettingsService.
const RemoteSettingsLive = makeSettingsLive();

const StateRepositoriesLive = Layer.provideMerge(
  Layer.mergeAll(
    KernelStateRepositoryLive,
    FactoryPauseRepositoryLive,
    WorkRepositoryLive,
    CrewRepositoryLive,
    Layer.provideMerge(UsageLive, RemoteSettingsLive),
    RemoteSettingsLive,
    SchedulerRepositoryLive,
    MachineRepositoryLive,
    SeatSessionRepositoryLive,
    makeContentServiceLive(),
  ),
  Layer.provideMerge(Layer.provide(ModelLive, WorkModelDependentsLive), Layer.mergeAll(StateEngineLive, InstallOpsLive)),
);

// The registry and SSH share the same product repositories.
const HostsWithSshLive = Layer.provideMerge(
  HostsServiceLive,
  Layer.mergeAll(
    SshTransportLive,
    StateRepositoriesLive,
  ),
);

const ProductTransportsLive = Layer.provideMerge(
  HermesTransportLive,
  HostsWithSshLive,
);

export const RemoteProductPlanesLive = Layer.provideMerge(
  HermesPlaneLive,
  ProductTransportsLive,
);

// Overseer operations use the chat service owned by the hermes plane.
const ProductPlanesWithChatLive = Layer.provideMerge(
  ChatServiceFromHermesLive,
  RemoteProductPlanesLive,
);

const SnapshotsWithProductsLive = Layer.provideMerge(
  SnapshotsLive,
  ProductPlanesWithChatLive,
);

const BaseLayer = Layer.mergeAll(
  SnapshotsWithProductsLive,
  HostsWithSshLive,
);

const BaseWithPauseLive = Layer.provideMerge(PausePlaneLive, BaseLayer);

// The base provides this machine identity to the per-call actor admission while
// retaining ActorSeatOccupy as a root service for KernelLive and other ingress.
const BaseWithActorSeatOccupyLive = Layer.provideMerge(
  ActorSeatOccupyLive,
  BaseWithPauseLive,
);

const KernelWithWorkLive = Layer.provideMerge(KernelLive, WorkLive);

const RemoteRootLayer = Layer.provideMerge(
  KernelWithWorkLive,
  Layer.provideMerge(
    BaseWithActorSeatOccupyLive,
    Layer.mergeAll(ProductPlanesWithChatLive, StateRepositoriesLive),
  ),
);

const RemoteAppLayer = Layer.mergeAll(RemoteRootLayer, ObservabilityLoggerLive);
export const RemoteRuntime = ManagedRuntime.make(
  RemoteAppLayer as Layer.Layer<
    Layer.Success<typeof RemoteAppLayer>,
    Layer.Error<typeof RemoteAppLayer>,
    never
  >,
);

