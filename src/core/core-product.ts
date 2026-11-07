import { join } from "node:path";
import { Layer } from "effect";
import { CanvasControlQueries } from "./canvas-control/queries";
import { ActorSeatOccupyLive } from "./term/actor-seat-occupy-live";
import { KernelLive } from "./kernel/service";
import { PausePlaneLaunchPlayingLive } from "./pause-plane-live";
import { FactoryPauseRepositoryLive } from "./pause/repository";
import { AgentSignalRepositoryLive } from "./signals/repository";
import { PortraitOverrideRepositoryLive } from "./portraits/repository";
import { CompanionDeviceRepositoryLive } from "./companion/repository";
import { SquadRepositoryLive } from "./squads/repository";
import { SeatGuidanceRepositoryLive } from "./seat-guidance/repository";
import { ArtifactRepositoryLive } from "./work/artifact-repository";
import { TaskRepositoryLive } from "./work/task-repository";
import { CanvasAuthoritiesLive } from "./fleet/host";
import { SeatReleaseHealLive } from "./work/seat-release";
import { AuthorityOwnerControl, makeAuthorityOwnerActions } from "./hosts/authority-owner";
import { AUTHORITY_ENABLED } from "@shared/features";
import { RulingRecorderLive } from "./work/ruling-recorder";
import { ResourceRulerLive } from "./work/resource-ruler";
import { makeAutomationRepositoryLive } from "./automation/repository";
import { AutomationRunnerLive, AutomationRunnerLoopLive } from "./automation/live";
import { AutomationCodeRunnerLive } from "./automation/code-step";
import { SeatStateSourceLive } from "./automation/seat-state-source";
import { ReferencesRepositoryLive } from "./references/repository";
import { ReferencesFollowCanvasLive } from "./references/follow-canvas";
import { SeatSessionRepositoryLive } from "./seat-sessions/repository";
import { ProfileRepositoryLive } from "./profiles/repository";
import { WorkLive } from "./work/service";
import { WorkRevisionsLive, WorkRepositoryLive } from "./work/repository";
import { CrewRepositoryLive } from "./work/crew-repository";
import { makeContentServiceLive } from "./content/service";
import { makeInstallOpsLive } from "./install-ops/engine";
import { makeSettingsLive } from "./settings/service";
import { UsageLive } from "./usage/live";
import { HostsServiceLive } from "./hosts";
import { HostRegistryRows } from "./hosts/registry";
import { SshTransportLive } from "./ssh";
import { makeStateEngineLive } from "./state/engine";
import { makeMachineRepositoryLive } from "./machines/repository";
import type { Log } from "../node/observability/logger";
import { OpRepositoryLive } from "./work/op-repository";
import { HarnessInventoryLive } from "./term/templates/harness-inventory";
import { NativeConfigLive } from "./native-config/service";
import { ProductModelDependentsLive } from "./view-state/model-dependents";
import { ViewStateRepositoryLive } from "./view-state/repository";
import { ModelLive } from "./model/layer";
import { VaultTokensLive } from "./vault/repository";
import { CodexLive } from "./services/codex";
import { SeatAwarenessLive } from "./term/seat-awareness-live";

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
export const makeCoreProductLayer = (home: string, log: Log) => {
  const state = makeStateEngineLive(join(home, ".junto", "state", "junto.db"));
  const installOps = makeInstallOpsLive(join(home, ".junto", "state", "install-ops.db"));
  const settings = makeSettingsLive();
  // One host of this machine's canvas authorities, shared by every ruler that judges on it: a
  // second would open a canvas the first holds (fleet/driver.ts). It records through the ruling recorder.
  const authorities = Layer.provideMerge(
    Layer.provide(CanvasAuthoritiesLive, makeMachineRepositoryLive({ log })),
    Layer.provide(RulingRecorderLive, Layer.merge(WorkRepositoryLive, makeMachineRepositoryLive({ log }))),
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
      makeMachineRepositoryLive({ log }),
      // This machine's vault scope records: the machine name to vault map a
      // spawn reads before it uses the vault token file.
      VaultTokensLive,
      OpRepositoryLive,
      // The operator's arrangement: machine-local rows, written as it changes.
      ViewStateRepositoryLive,
      // The automation store, and the recorder its ruler records each ruling through.
      makeAutomationRepositoryLive(),
      Layer.provide(RulingRecorderLive, Layer.merge(WorkRepositoryLive, makeMachineRepositoryLive({ log }))),
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
