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
import { SquadRepositoryLive } from "./junto/squads/repository";
import { SeatGuidanceRepositoryLive } from "./junto/seat-guidance/repository";
import { ArtifactRepositoryLive } from "./junto/work/artifact-repository";
import { TaskRepositoryLive } from "./junto/work/task-repository";
import { RulingRecorderLive } from "./junto/work/ruling-recorder";
import { ResourceRulerLive } from "./junto/work/resource-ruler";
import { makeAutomationRepositoryLive } from "./junto/automation/repository";
import { AutomationRunnerLive, AutomationRunnerLoopLive } from "./junto/automation/live";
import { SeatStateSourceLive } from "./junto/automation/seat-state-source";
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
      Layer.provideMerge(ReferencesFollowCanvasLive, ReferencesRepositoryLive),
      SeatSessionRepositoryLive,
      ProfileRepositoryLive,
      Layer.provideMerge(UsageLive, settings),
      settings,
      MachineRepositoryLive,
      OpRepositoryLive,
      // The automation store, and the recorder its ruler records each ruling through.
      makeAutomationRepositoryLive(),
      Layer.provide(RulingRecorderLive, WorkRepositoryLive),
      // The artifact store puts each version's bytes in the content store.
      // Each ruling is recorded once, for every machine, through the work store.
      Layer.provideMerge(
        Layer.provide(ArtifactRepositoryLive, Layer.provide(RulingRecorderLive, WorkRepositoryLive)),
        makeContentServiceLive({ home }),
      ),
      // The task ruler records its rulings the same way.
      Layer.provide(TaskRepositoryLive, Layer.provide(RulingRecorderLive, WorkRepositoryLive)),
    ),
    Layer.provideMerge(Layer.provide(ModelLive, WorkModelDependentsLive), Layer.mergeAll(state, installOps)),
  );
  const hosts = Layer.provideMerge(HostsServiceLive, Layer.mergeAll(
    // The editing machine's ruler, over the stores it rules into.
    SshTransportLive, Layer.provideMerge(HostRegistryRows.layer, Layer.provideMerge(ResourceRulerLive, repositories)),
  ));
  const pause = Layer.provideMerge(PausePlaneLaunchPlayingLive, hosts);
  const occupants = Layer.provideMerge(ActorSeatOccupyLive, pause);
  return Layer.provideMerge(
    Layer.mergeAll(
      Layer.provideMerge(KernelLive, WorkLive),
      // The automation runner and its loop, on every canvas this machine edits,
      // with the seat-state firings its seat triggers read.
      Layer.provideMerge(
        AutomationRunnerLoopLive,
        Layer.provideMerge(AutomationRunnerLive, Layer.merge(WorkLive, SeatStateSourceLive)),
      ),
      CanvasControlQueries.layer,
      Layer.provideMerge(NativeConfigLive, HarnessInventoryLive),
    ),
    occupants,
  );
};
