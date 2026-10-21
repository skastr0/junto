import { join } from "node:path";
import { Layer } from "effect";
import { CanvasControlQueries } from "./junto/canvas-control/queries";
import { ActorSeatOccupyLive } from "./junto/term/actor-seat-occupy-live";
import { KernelLive } from "./junto/kernel/service";
import { PausePlaneLaunchPlayingLive } from "./junto/pause-plane";
import { FactoryPauseRepositoryLive } from "./junto/pause/repository";
import { AgentSignalRepositoryLive } from "./junto/signals/repository";
import { PortraitOverrideRepositoryLive } from "./junto/portraits/repository";
import { CompanionDeviceRepositoryLive } from "./junto/companion/repository";
import { SchedulerRepositoryLive } from "./junto/scheduler/repository";
import { SquadRepositoryLive } from "./junto/squads/repository";
import { SeatGuidanceRepositoryLive } from "./junto/seat-guidance/repository";
import { ArtifactRepositoryLive } from "./junto/work/artifact-repository";
import { ReferencesRepositoryLive } from "./junto/references/repository";
import { ReferencesFollowCanvasLive } from "./junto/references/follow-canvas";
import { SeatSessionRepositoryLive } from "./junto/seat-sessions/repository";
import { ProfileRepositoryLive } from "./junto/profiles/repository";
import { WorkLive } from "./junto/work/service";
import { WorkRevisionsLive, WorkRepositoryLive } from "./junto/work/repository";
import { CrewRepositoryLive } from "./junto/work/crew-repository";
import { makeContentServiceLive } from "./junto/content/service";
import { makeInstallOpsLive } from "./junto/install-ops/engine";
import { makeSettingsLive } from "./junto/settings/service";
import { UsageLive } from "./junto/usage/live";
import { HostsServiceLive } from "./junto/hosts";
import { HostRegistryRows } from "./junto/hosts/registry";
import { SshTransportLive } from "./junto/ssh";
import { makeStateEngineLive } from "./junto/state/engine";
import { MachineRepositoryLive } from "./junto/machines/repository";
import { OpRepositoryLive } from "./junto/work/op-repository";
import { HarnessInventoryLive } from "./junto/term/templates/harness-inventory";
import { NativeConfigLive } from "./junto/native-config/service";
import { WorkModelDependentsLive } from "./junto/work/model-dependents";
import { ModelLive } from "./junto/model/layer";

/** The same product services in both shells, over one state connection. */
export const makeCoreProductLayer = (home: string) => {
  const state = makeStateEngineLive(join(home, ".junto", "state", "junto.db"));
  const installOps = makeInstallOpsLive(join(home, ".junto", "state", "install-ops.db"));
  const settings = makeSettingsLive();
  const repositories = Layer.provideMerge(
    Layer.mergeAll(
      FactoryPauseRepositoryLive,
      AgentSignalRepositoryLive,
      PortraitOverrideRepositoryLive,
      CompanionDeviceRepositoryLive,
      WorkRepositoryLive,
      WorkRevisionsLive,
      CrewRepositoryLive,
      SquadRepositoryLive,
      SeatGuidanceRepositoryLive,
      ArtifactRepositoryLive,
      Layer.provideMerge(ReferencesFollowCanvasLive, ReferencesRepositoryLive),
      SeatSessionRepositoryLive,
      ProfileRepositoryLive,
      Layer.provideMerge(UsageLive, settings),
      settings,
      SchedulerRepositoryLive,
      MachineRepositoryLive,
      OpRepositoryLive,
      makeContentServiceLive({ home }),
    ),
    Layer.provideMerge(Layer.provide(ModelLive, WorkModelDependentsLive), Layer.mergeAll(state, installOps)),
  );
  const hosts = Layer.provideMerge(HostsServiceLive, Layer.mergeAll(
    SshTransportLive, Layer.provideMerge(HostRegistryRows.layer, repositories),
  ));
  const pause = Layer.provideMerge(PausePlaneLaunchPlayingLive, hosts);
  const occupants = Layer.provideMerge(ActorSeatOccupyLive, pause);
  return Layer.provideMerge(
    Layer.mergeAll(Layer.provideMerge(KernelLive, WorkLive), CanvasControlQueries.layer, Layer.provideMerge(NativeConfigLive, HarnessInventoryLive)),
    occupants,
  );
};
