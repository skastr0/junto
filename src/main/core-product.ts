import { join } from "node:path";
import { Layer } from "effect";
import { CanvasControlQueries } from "./junto/canvas-control/queries";
import { ActorSeatOccupyLive } from "./junto/term/actor-seat-occupy-live";
import { KernelLive } from "./junto/kernel/service";
import { PausePlaneLaunchPlayingLive } from "./junto/pause-plane-live";
import { FactoryPauseRepositoryLive } from "./junto/pause/repository";
import { AgentSignalRepositoryLive } from "./junto/signals/repository";
import { PortraitOverrideRepositoryLive } from "./junto/portraits/repository";
import { CompanionDeviceRepositoryLive } from "./junto/companion/repository";
import { SquadRepositoryLive } from "./junto/squads/repository";
import { SeatGuidanceRepositoryLive } from "./junto/seat-guidance/repository";
import { ArtifactRepositoryLive } from "./junto/work/artifact-repository";
import { TaskRepositoryLive } from "./junto/work/task-repository";
import { CanvasAuthoritiesLive } from "./junto/fleet/host";
import { SeatReleaseHealLive } from "./junto/work/seat-release";
import { AuthorityOwnerControl, makeAuthorityOwnerActions } from "./junto/hosts/authority-owner";
import { AUTHORITY_ENABLED } from "@shared/features";
import { RulingRecorderLive } from "./junto/work/ruling-recorder";
import { ResourceRulerLive } from "./junto/work/resource-ruler";
import { makeAutomationRepositoryLive } from "./junto/automation/repository";
import { AutomationRunnerLive, AutomationRunnerLoopLive } from "./junto/automation/live";
import { AutomationCodeRunnerLive } from "./junto/automation/code-step";
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
import { ProductModelDependentsLive } from "./junto/view-state/model-dependents";
import { ViewStateRepositoryLive } from "./junto/view-state/repository";
import { ModelLive } from "./junto/model/layer";
import { CodexLive } from "./services/codex";
import { SeatAwarenessLive } from "./junto/term/seat-awareness-live";

/**
 * The automation runner and its loop, on every canvas this machine edits or
 * runs an automation of, with the seat-state firings its seat triggers read.
 * It sits over the machine services, not in the product layer: off the
 * editing machine its task writes are queued through their submit path.
 */
export const automationRunnerLayer = Layer.provideMerge(
  AutomationRunnerLoopLive,
  Layer.provideMerge(AutomationRunnerLive, Layer.mergeAll(WorkLive, SeatStateSourceLive, AutomationCodeRunnerLive)),
);

/** The same product services in both shells, over one state connection. */
export const makeCoreProductLayer = (home: string) => {
  const state = makeStateEngineLive(join(home, ".junto", "state", "junto.db"));
  const installOps = makeInstallOpsLive(join(home, ".junto", "state", "install-ops.db"));
  const settings = makeSettingsLive();
  // One host of this machine's canvas authorities, shared by every ruler that judges on it: a
  // second would open a canvas the first holds (fleet/driver.ts). It records through the ruling recorder.
  const authorities = Layer.provideMerge(
    Layer.provide(CanvasAuthoritiesLive, MachineRepositoryLive),
    Layer.provide(RulingRecorderLive, Layer.merge(WorkRepositoryLive, MachineRepositoryLive)),
  );
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
      // The operator's arrangement: machine-local rows, written as it changes.
      ViewStateRepositoryLive,
      // The automation store, and the recorder its ruler records each ruling through.
      makeAutomationRepositoryLive(),
      Layer.provide(RulingRecorderLive, Layer.merge(WorkRepositoryLive, MachineRepositoryLive)),
      // The artifact store puts each version's bytes in the content store.
      // Each ruling is recorded once, for every machine, through the work store,
      // and behind the authority judged on its canvas's (fleet/host.ts).
      Layer.provideMerge(
        Layer.provide(ArtifactRepositoryLive, authorities),
        makeContentServiceLive({ home }),
      ),
      // The task ruler records and judges its rulings the same way.
      Layer.provide(TaskRepositoryLive, authorities),
    ),
    Layer.provideMerge(Layer.provide(ModelLive, ProductModelDependentsLive), Layer.mergeAll(state, installOps)),
  );
  const hosts = Layer.provideMerge(HostsServiceLive, Layer.mergeAll(
    // The editing machine's ruler, over the stores it rules into.
    SshTransportLive, Layer.provideMerge(HostRegistryRows.layer, Layer.provideMerge(ResourceRulerLive, repositories)),
  ));
  // The operator's authority commands answer on the one host, behind this build's flag.
  const authorityOwner = Layer.provide(
    Layer.effect(AuthorityOwnerControl, makeAuthorityOwnerActions({ enabled: AUTHORITY_ENABLED })),
    authorities,
  );
  const pause = Layer.provideMerge(PausePlaneLaunchPlayingLive, hosts);
  const occupants = Layer.provideMerge(ActorSeatOccupyLive, pause);
  return Layer.provideMerge(
    Layer.mergeAll(
      Layer.provideMerge(KernelLive, WorkLive),
      CanvasControlQueries.layer,
      Layer.provideMerge(NativeConfigLive, HarnessInventoryLive),
      // Behind the authority, every canvas's owed seat releases are judged at boot (seat-release.ts).
      SeatReleaseHealLive,
      authorityOwner,
      // The seat awareness plane runs here, where the seats and their windows are, and its
      // events leave as core pushes; main asks it for the snapshot (term/seat-awareness-live.ts).
      Layer.provide(SeatAwarenessLive, settings),
      // The doctor's Codex check runs here too: it is this machine's CLI, and
      // the doctor document is assembled in the core (junto/doctor.ts).
      CodexLive,
    ),
    occupants,
  );
};
