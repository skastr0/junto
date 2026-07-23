import { homedir } from "node:os";
import type { Context } from "effect";
import { Effect } from "effect";
import type { StationSettings } from "@shared/settings";
import {
  hermesKeyFor,
  hostHasCapability,
  RemoteHostsError,
  type RemoteHost,
} from "@shared/remote-hosts";
import type { RemoteStationConfigInput } from "@shared/remote-station-config";
import {
  makeStationBrowserTrustStore,
  pinnedTrustForOriginKey,
  provisionStationBrowserTrust,
  type StationBrowserTrustProvisionResponse,
} from "../browser/station-trust";
import { SshTransport } from "../ssh";
import { hostsSnapshot } from "./snapshot";
import {
  deployRemoteHost,
  dispatchRemoteDeployment,
  prepareRemoteDeployment,
  type DeployRemoteResult,
  type RemoteDeploymentAuthorization,
  type RemoteDeploymentPreparation,
  type RemoteDeploymentStationConfiguration,
  type RemoteDeploymentTarget,
} from "./deploy-remote";
import {
  captureRemoteSettingsSnapshot,
  describeRemoteSettingsSnapshot,
  remoteSettingsSnapshotsEqual,
  restoreRemoteSettingsSnapshot,
  stampRemoteSettingsSnapshot,
  type RemoteSettingsSnapshot,
  type StampRemoteSettingsResult,
} from "./remote-settings-transaction";

type Ssh = Context.Tag.Service<typeof SshTransport>;

export type ConfiguredRemoteDeployOutcome =
  | "ready"
  | "failed"
  | "rolled-back"
  | "indeterminate";

export type ConfiguredRemoteDeployResult = DeployRemoteResult & {
  /** False only when the registry never resolved the requested host. */
  readonly hostResolved?: boolean;
  /** Exact registered mutation target used for this attempt. */
  readonly hostEndpoint?: string;
  /** Set by the service when durable attempt finalization was requested. */
  readonly statusRecorded?: boolean;
  readonly outcome: ConfiguredRemoteDeployOutcome;
  readonly packageState: "present" | "previous" | "unknown";
  readonly role: "remote" | "previous" | "unknown";
  readonly lastSeen?: string;
  readonly station?: StationSettings;
  readonly rollback: "not-required" | "restored" | "failed";
  readonly configuration: {
    readonly ok: boolean;
    readonly detail: string;
  };
};

export type ConfiguredRemoteDeployOperations = {
  readonly deploy: (
    ssh: Ssh,
    host: RemoteHost,
    authorization?: RemoteDeploymentAuthorization,
  ) => Effect.Effect<DeployRemoteResult, never>;
  /** Production target admission runs before the settings transaction mutates. */
  readonly prepare?: (
    ssh: Ssh,
    host: RemoteHost,
  ) => Effect.Effect<RemoteDeploymentPreparation, never>;
  /** Paired with prepare; executes only the already-admitted provider. */
  readonly deployPrepared?: (
    ssh: Ssh,
    target: RemoteDeploymentTarget,
    stationConfiguration: RemoteDeploymentStationConfiguration,
    authorization?: RemoteDeploymentAuthorization,
  ) => Effect.Effect<DeployRemoteResult, never>;
  readonly capture: (
    ssh: Ssh,
    host: RemoteHost,
  ) => Effect.Effect<RemoteSettingsSnapshot, RemoteHostsError>;
  readonly stamp: (
    ssh: Ssh,
    host: RemoteHost,
    original: RemoteSettingsSnapshot,
    input: RemoteStationConfigInput,
  ) => Effect.Effect<StampRemoteSettingsResult, RemoteHostsError>;
  readonly restore: (
    ssh: Ssh,
    host: RemoteHost,
    original: RemoteSettingsSnapshot,
    expectedCurrent: RemoteSettingsSnapshot,
  ) => Effect.Effect<void, RemoteHostsError>;
  /**
   * Installs the Command Center's custody-owned browser origin key on the
   * already-packaged Remote. It runs after the final exact role snapshot and
   * before the transaction may publish ready.
   */
  readonly provisionBrowserTrust?: (
    ssh: Ssh,
    host: RemoteHost,
    commandCenterRef: string,
  ) => Effect.Effect<StationBrowserTrustProvisionResponse, Error>;
};

const stationBrowserTrust = makeStationBrowserTrustStore(homedir());

const defaultOperations: ConfiguredRemoteDeployOperations = {
  deploy: deployRemoteHost,
  prepare: prepareRemoteDeployment,
  deployPrepared: (ssh, target, stationConfiguration, authorization) =>
    dispatchRemoteDeployment(
      target,
      ssh,
      stationConfiguration,
      authorization,
    ),
  capture: captureRemoteSettingsSnapshot,
  stamp: stampRemoteSettingsSnapshot,
  restore: restoreRemoteSettingsSnapshot,
  provisionBrowserTrust: (ssh, host, commandCenterRef) =>
    Effect.tryPromise({
      try: () =>
        stationBrowserTrust.loadOrCreateOriginKey(commandCenterRef),
      catch: (error) =>
        error instanceof Error ? error : new Error(String(error)),
    }).pipe(
      Effect.flatMap((key) =>
        provisionStationBrowserTrust(
          ssh,
          hostsSnapshot(),
          host.id,
          pinnedTrustForOriginKey(key, null, key.createdAt),
        ).pipe(
          Effect.mapError((error) =>
            error instanceof Error ? error : new Error(String(error)),
          ),
        ),
      ),
    ),
};

const failedBeforeMutation = (
  host: RemoteHost,
  detail: string,
  code: DeployRemoteResult["code"] = "io",
): ConfiguredRemoteDeployResult => ({
  ok: false,
  detail,
  code,
  message: detail,
  hostEndpoint: host.endpoint,
  stages: [],
  disposition: "not-started",
  outcome: "failed",
  packageState: "previous",
  role: "previous",
  rollback: "not-required",
  configuration: { ok: false, detail },
});

const refusedBeforeMutation = (
  host: RemoteHost,
  result: DeployRemoteResult,
): ConfiguredRemoteDeployResult => ({
  ...result,
  ok: false,
  hostEndpoint: host.endpoint,
  disposition: "not-started",
  outcome: "failed",
  packageState: "previous",
  role: "previous",
  rollback: "not-required",
  configuration: { ok: false, detail: result.detail },
});

const compensate = (
  operations: ConfiguredRemoteDeployOperations,
  ssh: Ssh,
  host: RemoteHost,
  before: RemoteSettingsSnapshot,
  after: RemoteSettingsSnapshot,
): Effect.Effect<"not-required" | "restored" | "failed"> =>
  remoteSettingsSnapshotsEqual(before, after)
    ? Effect.succeed("not-required" as const)
    : operations.restore(ssh, host, before, after).pipe(
        Effect.as("restored" as const),
        Effect.catchAll(() => Effect.succeed("failed" as const)),
      );

const exactRemoteStamp = (
  snapshot: RemoteSettingsSnapshot,
  host: RemoteHost,
  commandCenterRef: string,
): boolean => {
  const stamped = describeRemoteSettingsSnapshot(snapshot);
  return (
    stamped.existed &&
    stamped.station?.role === "remote" &&
    stamped.station.hostId === host.id &&
    stamped.station.agentHostId === hermesKeyFor(host) &&
    stamped.station.commandCenterRef === commandCenterRef
  );
};

const indeterminate = (
  host: RemoteHost,
  detail: string,
  input: {
    readonly packageState: ConfiguredRemoteDeployResult["packageState"];
    readonly role: ConfiguredRemoteDeployResult["role"];
    readonly rollback: ConfiguredRemoteDeployResult["rollback"];
    readonly configuration: ConfiguredRemoteDeployResult["configuration"];
    readonly deployed?: DeployRemoteResult;
    readonly station?: StationSettings;
    readonly version?: string;
    readonly recoveryAction?: DeployRemoteResult["recoveryAction"];
  },
): ConfiguredRemoteDeployResult => ({
  ...(input.deployed ?? { stages: [] }),
  ok: false,
  detail,
  code: "conflict",
  message: detail,
  hostEndpoint: host.endpoint,
  disposition: "indeterminate",
  outcome: "indeterminate",
  packageState: input.packageState,
  role: input.role,
  rollback: input.rollback,
  configuration: input.configuration,
  ...(input.station ? { station: input.station } : {}),
  ...(input.version ? { version: input.version } : { version: undefined }),
  ...(input.recoveryAction === undefined
    ? {}
    : { recoveryAction: input.recoveryAction }),
});

const validBrowserTrustReceipt = (
  value: StationBrowserTrustProvisionResponse,
): boolean =>
  value.version === 1 &&
  value.ok === true &&
  value.status === "active" &&
  Number.isSafeInteger(value.generation) &&
  value.generation > 0 &&
  /^ed25519-[0-9a-f]{24}$/u.test(value.keyId);

/**
 * Configure and launch one Remote as a compensating transaction.
 *
 * The role stamp is a compare-and-swap against the exact captured preimage.
 * Failed package transactions restore only that acknowledged postimage. A
 * final exact snapshot gates the ready receipt, so an intervening settings edit
 * can never be reported as a healthy Remote.
 */
export const deployConfiguredRemoteHost = (
  ssh: Ssh,
  host: RemoteHost,
  options: {
    readonly commandCenterRef: string;
    readonly supervisedPreferred?: boolean;
    readonly authorization?: RemoteDeploymentAuthorization;
  },
  operations: ConfiguredRemoteDeployOperations = defaultOperations,
): Effect.Effect<ConfiguredRemoteDeployResult, never> => {
  let beforeInterruption: RemoteSettingsSnapshot | undefined;
  let afterInterruption: RemoteSettingsSnapshot | undefined;
  let packageCommitted = false;
  let deploymentDisposition:
    | "not-begun"
    | "in-flight"
    | "not-started"
    | "ready"
    | "rolled-back"
    | "indeterminate" = "not-begun";

  const transaction = Effect.gen(function* () {
    const hasPrepare = operations.prepare !== undefined;
    const hasPreparedDeploy = operations.deployPrepared !== undefined;
    if (hasPrepare !== hasPreparedDeploy) {
      return failedBeforeMutation(
        host,
        `${host.label}: Remote deployment operations have an incomplete target-admission contract`,
        "validation",
      );
    }
    const preparation = operations.prepare
      ? yield* operations.prepare(ssh, host)
      : undefined;
    if (preparation && !preparation.ok) {
      return refusedBeforeMutation(host, preparation.result);
    }

    const before = yield* operations.capture(ssh, host).pipe(Effect.either);
    if (before._tag === "Left") {
      return failedBeforeMutation(
        host,
        `${host.label}: could not snapshot Remote settings before deploy — ${before.left.message}`,
        before.left.code,
      );
    }
    beforeInterruption = before.right;

    const stampInput: RemoteStationConfigInput = {
      remoteHostId: host.id,
      agentHostId: hermesKeyFor(host),
      commandCenterRef: options.commandCenterRef,
      supervisedPreferred: options.supervisedPreferred ?? true,
    };
    const stamped = yield* operations
      .stamp(ssh, host, before.right, stampInput)
      .pipe(Effect.either);
    if (stamped._tag === "Left") {
      const current = yield* operations.capture(ssh, host).pipe(Effect.either);
      if (
        current._tag === "Right" &&
        remoteSettingsSnapshotsEqual(before.right, current.right)
      ) {
        return failedBeforeMutation(
          host,
          `${host.label}: Remote settings were not changed — ${stamped.left.message}`,
          stamped.left.code,
        );
      }
      const observation =
        current._tag === "Left"
          ? current.left.message
          : "settings no longer match the captured preimage";
      const detail = `${host.label}: Remote settings stamp outcome is indeterminate — ${stamped.left.message}; ${observation}. Inspect the host before retrying.`;
      return indeterminate(host, detail, {
        packageState: "previous",
        role: "unknown",
        rollback: "failed",
        configuration: { ok: false, detail: stamped.left.message },
      });
    }
    afterInterruption = stamped.right.snapshot;

    if (
      !exactRemoteStamp(
        stamped.right.snapshot,
        host,
        options.commandCenterRef,
      )
    ) {
      const detail = `${host.label}: the acknowledged settings postimage did not prove role Remote, host ${host.id}, and Command Center ${options.commandCenterRef}. Inspect the host before retrying.`;
      return indeterminate(host, detail, {
        packageState: "previous",
        role: "unknown",
        rollback: "failed",
        configuration: { ok: false, detail: stamped.right.detail },
        station: stamped.right.station,
      });
    }

    deploymentDisposition = "in-flight";
    const deployed =
      preparation?.ok && operations.deployPrepared
        ? yield* operations.deployPrepared(
            ssh,
            preparation.target,
            {
              state: "applied",
              remoteHostId: host.id,
              commandCenterRef: options.commandCenterRef,
            },
            options.authorization,
          )
        : yield* operations.deploy(ssh, host, options.authorization);
    deploymentDisposition = deployed.ok
      ? "ready"
      : (deployed.disposition ?? "indeterminate");
    if (deployed.ok || deployed.disposition === "ready") {
      // The package has crossed its commit point. Never restore settings around
      // that running generation, including if final observation is interrupted.
      packageCommitted = true;
      const finalSettings = yield* operations.capture(ssh, host).pipe(Effect.either);
      const roleProven =
        finalSettings._tag === "Right" &&
        remoteSettingsSnapshotsEqual(stamped.right.snapshot, finalSettings.right) &&
        exactRemoteStamp(finalSettings.right, host, options.commandCenterRef);
      if (!deployed.ok || !roleProven) {
        const causes = [
          deployed.detail,
          finalSettings._tag === "Left"
            ? `final settings observation failed: ${finalSettings.left.message}`
            : roleProven
              ? "the deploy lock release was not proven"
              : "settings changed before final readiness observation",
        ];
        const detail = `${host.label}: package is present but the Remote deployment outcome is indeterminate — ${causes.join("; ")}. Inspect the host before retrying.`;
        return indeterminate(host, detail, {
          packageState: "present",
          role: roleProven ? "remote" : "unknown",
          rollback: "not-required",
          configuration: { ok: roleProven, detail: stamped.right.detail },
          deployed,
          station: stamped.right.station,
          version: deployed.version,
        });
      }

      if (hostHasCapability(host, "browser")) {
        const provision = operations.provisionBrowserTrust;
        if (provision === undefined) {
          const detail = `${host.label}: package and Remote role are ready, but browser trust provisioning is unavailable. Retry after restoring the Command Center browser-trust authority.`;
          return indeterminate(host, detail, {
            packageState: "present",
            role: "remote",
            rollback: "not-required",
            configuration: { ok: true, detail: stamped.right.detail },
            deployed,
            station: stamped.right.station,
            version: deployed.version,
            recoveryAction: { kind: "provision-station-browser-trust" },
          });
        }
        const browserTrust = yield* provision(
          ssh,
          host,
          options.commandCenterRef,
        ).pipe(Effect.either);
        if (
          browserTrust._tag === "Left" ||
          !validBrowserTrustReceipt(browserTrust.right)
        ) {
          const cause =
            browserTrust._tag === "Left"
              ? browserTrust.left.message
              : "the Remote returned a malformed browser-trust receipt";
          const detail = `${host.label}: package and Remote role are ready, but browser trust was not proven — ${cause}. Retry the idempotent trust provisioning step.`;
          return indeterminate(host, detail, {
            packageState: "present",
            role: "remote",
            rollback: "not-required",
            configuration: { ok: true, detail: stamped.right.detail },
            deployed,
            station: stamped.right.station,
            version: deployed.version,
            recoveryAction: { kind: "provision-station-browser-trust" },
          });
        }
      }

      const lastSeen = new Date().toISOString();
      const detail = `${stamped.right.detail} · ${deployed.detail}`;
      return {
        ...deployed,
        detail,
        message: deployed.message ?? detail,
        hostEndpoint: host.endpoint,
        disposition: "ready",
        outcome: "ready",
        packageState: "present",
        role: "remote",
        lastSeen,
        station: stamped.right.station,
        rollback: "not-required",
        configuration: { ok: true, detail: stamped.right.detail },
      } satisfies ConfiguredRemoteDeployResult;
    }

    const deploymentIndeterminate =
      deployed.disposition !== "rolled-back" &&
      deployed.disposition !== "not-started";
    if (deploymentIndeterminate) {
      const detail = `${host.label}: deploy outcome is indeterminate — ${deployed.detail}; the package transaction did not prove its final state, so the Remote stamp was retained. Inspect the host before retrying.`;
      return indeterminate(host, detail, {
        packageState: "unknown",
        role: "unknown",
        rollback: "not-required",
        configuration: { ok: true, detail: stamped.right.detail },
        deployed,
        station: stamped.right.station,
      });
    }

    const rollback = yield* compensate(
      operations,
      ssh,
      host,
      before.right,
      stamped.right.snapshot,
    );
    if (rollback === "failed") {
      const causes = [
        deployed.detail,
        "the prior Remote settings could not be restored",
      ];
      const detail = `${host.label}: deploy outcome is indeterminate — ${causes.join("; ")}. Inspect the host before retrying.`;
      return indeterminate(host, detail, {
        packageState: "previous",
        role: "unknown",
        rollback,
        configuration: { ok: true, detail: stamped.right.detail },
        deployed,
        station: stamped.right.station,
      });
    }

    const detail =
      rollback === "restored"
        ? `${deployed.detail} · prior Remote settings restored`
        : deployed.detail;
    return {
      ...deployed,
      ok: false,
      detail,
      message: deployed.message ?? detail,
      hostEndpoint: host.endpoint,
      version: undefined,
      outcome: rollback === "restored" ? "rolled-back" : "failed",
      packageState: "previous",
      role: "previous",
      station: stamped.right.station,
      rollback,
      configuration: { ok: true, detail: stamped.right.detail },
    } satisfies ConfiguredRemoteDeployResult;
  });

  return transaction.pipe(
    Effect.onInterrupt(() => {
      const before = beforeInterruption;
      if (before === undefined || packageCommitted) return Effect.void;
      if (
        deploymentDisposition === "in-flight" ||
        deploymentDisposition === "ready" ||
        deploymentDisposition === "indeterminate"
      ) {
        return Effect.sync(() => {
          console.error(
            `[deploy-remote] ${host.id}: interruption occurred without proof that the package stayed previous; retaining the Remote stamp for manual inspection`,
          );
        });
      }
      return operations.capture(ssh, host).pipe(
        Effect.flatMap((current) => {
          if (remoteSettingsSnapshotsEqual(before, current)) {
            return Effect.succeed("not-required" as const);
          }
          const after = afterInterruption;
          if (
            after === undefined ||
            !remoteSettingsSnapshotsEqual(after, current)
          ) {
            return Effect.succeed("failed" as const);
          }
          return compensate(operations, ssh, host, before, current);
        }),
        Effect.tap((rollback) =>
          rollback === "failed"
            ? Effect.sync(() => {
                console.error(
                  `[deploy-remote] ${host.id}: interruption compensation could not be proven; manual inspection required`,
                );
              })
            : Effect.void,
        ),
        Effect.catchAll((error) =>
          Effect.sync(() => {
            console.error(
              `[deploy-remote] ${host.id}: interruption compensation failed (${error.code}); manual inspection required`,
            );
          }),
        ),
        Effect.asVoid,
      );
    }),
  );
};
