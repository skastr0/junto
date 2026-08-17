/**
 * Live wiring for the fleet managed-update executor.
 *
 * Observation sources are all planes Command Center already maintains:
 * enrolled hosts (HostsService), observed Remote versions (fleet propagation
 * protocol facts), the stable feed (UpdateService), and the live deploy job
 * registry. Deploy attempts go through the one shared hosts operator
 * coordinator; durable receipts land in StationStatusService exactly like
 * every other deployment outcome.
 */

import { Effect } from "effect";
import { computeDeployCapabilities } from "@shared/deploy-capabilities";
import { RELEASE_CAPABILITIES } from "@shared/release-capabilities";
import { deployRecordFromResult } from "@shared/station-status";
import { AppRuntime } from "../../runtime";
import { getDeployJob } from "../hosts/deploy-job-registry";
import { hostsOperatorCoordinator } from "../hosts/operator-coordinator";
import { HostsService } from "../hosts/service";
import { SettingsService } from "../settings/service";
import { StationFleetPropagation } from "../station/fleet-propagation";
import { StationStatusService } from "../station-status-store";
import { UpdateService } from "./service";
import {
  makeFleetUpdateExecutor,
  type FleetExecutorRemote,
  type FleetUpdateExecutor,
} from "./fleet-executor";

const listRemotesEffect = Effect.gen(function* () {
  const hosts = yield* HostsService;
  const fleet = yield* StationFleetPropagation;
  const enrolled = yield* hosts.list;
  const statuses = yield* fleet.statuses;
  const versionByHost = new Map<string, string>();
  for (const status of statuses) {
    const appVersion = status.protocol?.peer?.appVersion;
    if (appVersion !== undefined) {
      versionByHost.set(String(status.hostId), appVersion);
    }
  }
  return enrolled
    .filter(
      (host) => host.kind === "remote" && host.sshEndpoint !== undefined,
    )
    .map(
      (host): FleetExecutorRemote => ({
        hostId: host.id,
        endpoint: host.sshEndpoint ?? "",
        // Best-effort observation only: Box-enrolled machines are Linux;
        // everything else is treated as macOS. HostRuntime re-verifies the
        // real platform (uname) at apply admission and refuses safely, so a
        // misclassified target never installs the wrong package.
        platform: host.id.startsWith("box-") ? "linux" : "darwin",
        installedVersion: versionByHost.get(host.id),
      }),
    );
});

export const makeLiveFleetUpdateExecutor = (): FleetUpdateExecutor =>
  makeFleetUpdateExecutor({
    settings: () =>
      AppRuntime.runPromise(
        Effect.gen(function* () {
          const settings = yield* (yield* SettingsService).get;
          return {
            role: settings.station.role,
            remoteManagedInstalls: settings.fleet.remoteManagedInstalls,
          };
        }),
      ),
    updateFacts: () =>
      AppRuntime.runPromise(
        Effect.gen(function* () {
          const status = yield* (yield* UpdateService).getState;
          return {
            commandCenterVersion: status.currentVersion,
            ...(status.available?.version === undefined
              ? {}
              : { feedVersion: status.available.version }),
          };
        }),
      ),
    listRemotes: () => AppRuntime.runPromise(listRemotesEffect),
    deployJob: (hostId) => getDeployJob(hostId),
    deployRemote: (hostId) =>
      hostsOperatorCoordinator.deployRemote({ id: hostId }),
    releaseDeployAllowed: () =>
      computeDeployCapabilities({
        stationRole: "command-center",
        remoteManagedInstalls: true,
        release: RELEASE_CAPABILITIES,
      }).effective.deployRemote,
    recordRefusal: (input) =>
      AppRuntime.runPromise(
        Effect.gen(function* () {
          const stationStatus = yield* StationStatusService;
          yield* stationStatus.recordDeployment(
            deployRecordFromResult({
              hostId: input.hostId,
              endpoint: input.endpoint,
              ok: false,
              outcome: "failed",
              packageState: "unknown",
              role: "unknown",
              version: input.targetVersion,
              configurationOk: false,
              detail: input.detail,
              stages: input.stages,
              recoveryKind: "retryable",
            }),
          );
        }),
      ),
  });

let liveExecutor: FleetUpdateExecutor | undefined;

/**
 * Boot entry: create the one executor and arm its coarse timers. Idempotent —
 * safe to call again when the station role flips to command-center. The
 * operator kill-switch (remoteManagedInstalls) is re-read on every pass, so
 * turning it off disables the executor without tearing anything down.
 */
export const startLiveFleetUpdateExecutor = (): void => {
  liveExecutor ??= makeLiveFleetUpdateExecutor();
  liveExecutor.start();
};
