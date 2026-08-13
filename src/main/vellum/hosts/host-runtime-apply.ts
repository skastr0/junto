/**
 * Shared apply glue. First install configures. Update passes the prior
 * installation id so pair/configure never run again.
 */
import { Effect } from "effect";
import type { InstallationId } from "@shared/installation-id";
import {
  deployConfiguredRemoteHost,
  type ConfiguredRemoteDeployResult,
} from "./deploy-configured-remote";
import type { HostRuntimeApplyContext } from "./host-runtime-platform";

export const applyConfiguredRemoteGap = (
  context: HostRuntimeApplyContext,
): Effect.Effect<ConfiguredRemoteDeployResult> => {
  const prior =
    context.gap === "needRestart" ? context.priorInstallationId : undefined;
  return deployConfiguredRemoteHost(context.ssh, context.host, {
    ...context.configure,
    ...(context.artifactSource === undefined
      ? {}
      : { artifactSource: context.artifactSource }),
    ...(prior === undefined
      ? {}
      : { stationInstallationId: prior as InstallationId }),
    ...(context.onAdmitted === undefined
      ? {}
      : { onAdmitted: context.onAdmitted }),
  }).pipe(
    Effect.flatMap((deployed) => {
      if (context.onCompleted === undefined) return Effect.succeed(deployed);
      return context.onCompleted(context.host, deployed).pipe(
        Effect.map(() => ({ ...deployed, statusRecorded: true })),
        Effect.catch((error) =>
          Effect.succeed({
            ...deployed,
            statusRecorded: false,
            detail: `${deployed.detail} - local deployment receipt could not be persisted: ${error.message}`,
          }),
        ),
      );
    }),
  );
};
