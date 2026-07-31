/**
 * Node-only Runtime for a Remote station. It intentionally has no Electron,
 * BrowserWindow, renderer, browser-composition, update, or IPC dependencies.
 * The memoized StateEngine layer remains the sole database owner.
 */
import { Effect, Layer, ManagedRuntime } from "effect";
import { CanvasesLive } from "./vellum/canvases";
import { HermesPlaneLive } from "./vellum/hermes/plane";
import { HermesTransportLive } from "./vellum/hermes/transport";
import { HerdrPlaneLive } from "./vellum/herdr/plane";
import { HerdrTransportLive } from "./vellum/herdr/transport";
import { KernelLive } from "./vellum/kernel/service";
import { KernelStateRepositoryLive } from "./vellum/kernel/repository";
import { PausePlaneLive } from "./vellum/pause-plane";
import { FactoryPauseRepositoryLive } from "./vellum/pause/repository";
import { SchedulerRepositoryLive } from "./vellum/scheduler/repository";
import { WorkLive } from "./vellum/work/service";
import { WorkRepositoryLive } from "./vellum/work/repository";
import { RegionRollupLive } from "./vellum/region-rollup";
import { SettingsLive } from "./vellum/settings/service";
import { SnapshotsLive } from "./vellum/snapshots";
import { UsageLive } from "./vellum/usage/live";
import { HostsServiceLive } from "./vellum/hosts";
import { SshTransportLive } from "./vellum/ssh";
import { StationStatusLive } from "./vellum/station-status-store";
import { StateEngineLive } from "./vellum/state/engine";
import { StationFleetTargetRepositoryLive } from "./vellum/station/fleet-target-repository";
import { StationRepositoryLive } from "./vellum/station/repository";
import { StationApiLive } from "./vellum/station/api";
import { StationPropagationLive } from "./vellum/station/propagation";
import { OpenSshStationPeerRouteResolverLive, StationFleetPropagationLive } from "./vellum/station/fleet-propagation";
import { OpenSshStationPeerExchangeLive } from "./vellum/station/openssh-peer-exchange";
import { StationLivePeerRegistryLive } from "./vellum/station/session-registry";
import { CURRENT_STATE_SCHEMA_VERSION } from "./vellum/state/migrations";
import { CURRENT_STATION_PROTOCOL_SUPPORT } from "@shared/station-protocol";
import productMetadata from "../../package.json";
import { StationRepository } from "./vellum/station/repository";

const StateRepositoriesLive = Layer.provideMerge(
  Layer.mergeAll(
    KernelStateRepositoryLive, FactoryPauseRepositoryLive, WorkRepositoryLive,
    UsageLive, SettingsLive, SchedulerRepositoryLive, StationStatusLive,
    StationRepositoryLive, StationFleetTargetRepositoryLive,
  ),
  StateEngineLive,
);

const CanvasesWithStateLive = Layer.provideMerge(CanvasesLive, StateRepositoriesLive);
const StatefulServicesLive = Layer.provideMerge(StationApiLive, CanvasesWithStateLive);
const StationPropagationServicesLive = Layer.provideMerge(StationPropagationLive, StatefulServicesLive);
const OpenSshStationPeerExchangeFromStateLive = Layer.unwrapEffect(
  Effect.gen(function* () {
    const repository = yield* StationRepository;
    const localInstallationId = yield* repository.installationId;
    return OpenSshStationPeerExchangeLive(localInstallationId, {
      appVersion: productMetadata.version,
      stateSchemaVersion: CURRENT_STATE_SCHEMA_VERSION,
      support: CURRENT_STATION_PROTOCOL_SUPPORT,
    });
  }),
);
const StationSessionInfrastructureLive = Layer.provideMerge(
  Layer.mergeAll(StationLivePeerRegistryLive, OpenSshStationPeerRouteResolverLive, OpenSshStationPeerExchangeFromStateLive),
  Layer.mergeAll(StateRepositoriesLive, SshTransportLive),
);
const StationFleetServicesLive = Layer.provideMerge(
  StationFleetPropagationLive,
  Layer.mergeAll(StationPropagationServicesLive, StationSessionInfrastructureLive),
);
const HostsWithSshLive = Layer.provideMerge(
  HostsServiceLive,
  Layer.mergeAll(SshTransportLive, StateRepositoriesLive, StationFleetServicesLive),
);
const ProductTransportsLive = Layer.provideMerge(
  Layer.mergeAll(HerdrTransportLive, HermesTransportLive),
  HostsWithSshLive,
);
export const RemoteProductPlanesLive = Layer.provideMerge(
  Layer.mergeAll(HerdrPlaneLive, HermesPlaneLive), ProductTransportsLive,
);
const BaseWithPauseLive = Layer.provideMerge(
  PausePlaneLive,
  Layer.mergeAll(SnapshotsLive, HostsWithSshLive, StationFleetServicesLive, StateRepositoriesLive),
);
const KernelWithWorkLive = Layer.provideMerge(KernelLive, WorkLive);
const RemoteRootLayer = Layer.provideMerge(
  Layer.mergeAll(KernelWithWorkLive, RegionRollupLive),
  Layer.provideMerge(BaseWithPauseLive, Layer.mergeAll(RemoteProductPlanesLive, CanvasesWithStateLive)),
);

export const RemoteRuntime = ManagedRuntime.make(RemoteRootLayer);
