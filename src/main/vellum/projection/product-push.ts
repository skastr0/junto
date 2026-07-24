/**
 * Command Center product path: compile live canvases and push frames to
 * configured remote Stations via SshTransport + named projection recipe.
 *
 * Cut 4: projection generation = canvas-authority generation; one frame per
 * configured Station stamped with that station's expected witness. Inventory-
 * only hosts (enrolled but never successfully configured) are skipped.
 */

import { Effect } from "effect";
import { RELEASE_CAPABILITIES } from "@shared/release-capabilities";
import { CanvasesService } from "../canvases";
import { HostsService } from "../hosts";
import { SettingsService } from "../settings/service";
import { stationSettingsWitness } from "../station-witness";
import { readStationStatus } from "../station-status-store";
import { SshTransport } from "../ssh/service";
import {
  deliverProjectionToHosts,
  type ProjectionHostTarget,
  type ScheduleHostSyncResult,
} from "./delivery";
import { createProjectionDeliveryTransport } from "./remote-delivery";

export type ProductProjectionPushResult =
  | {
      readonly ok: true;
      readonly skipped?: false;
      readonly result: ScheduleHostSyncResult;
    }
  | {
      readonly ok: true;
      readonly skipped: true;
      readonly detail: string;
    }
  | {
      readonly ok: false;
      readonly detail: string;
    };

/**
 * Push the current live canvas set to every *configured* remote Station.
 *
 * Uses `createProjectionDeliveryTransport(ssh)` so remote mode runs the named
 * `compileProjectionFrameDeliver` recipe (never residual without transport).
 * SSH success records `staged` (not `applied`) until Remote applies/acks.
 */
export const pushLiveProjectionToEnrolledRemotes = Effect.gen(function* () {
  if (!RELEASE_CAPABILITIES.stationProjection) {
    return {
      ok: true,
      skipped: true,
      detail: "stationProjection capability is disabled",
    } satisfies ProductProjectionPushResult;
  }

  const settings = yield* SettingsService;
  const hostsSvc = yield* HostsService;
  const canvases = yield* CanvasesService;
  const ssh = yield* SshTransport;

  const settingsEither = yield* Effect.either(settings.get);
  if (settingsEither._tag === "Left") {
    return {
      ok: false,
      detail: `settings unreadable: ${settingsEither.left.message}`,
    } satisfies ProductProjectionPushResult;
  }
  const doc = settingsEither.right;
  if (doc.station.role !== "command-center") {
    return {
      ok: true,
      skipped: true,
      detail: "projection push is Command Center only",
    } satisfies ProductProjectionPushResult;
  }

  const hostsEither = yield* Effect.either(hostsSvc.list);
  if (hostsEither._tag === "Left") {
    return {
      ok: false,
      detail: `host registry unreadable: ${hostsEither.left.message}`,
    } satisfies ProductProjectionPushResult;
  }

  const remotes = hostsEither.right.filter(
    (host) =>
      host.kind === "remote" &&
      typeof host.endpoint === "string" &&
      host.endpoint.trim().length > 0,
  );

  if (remotes.length === 0) {
    return {
      ok: true,
      skipped: true,
      detail: "no enrolled remote hosts with endpoints",
    } satisfies ProductProjectionPushResult;
  }

  const status = yield* Effect.promise(() => readStationStatus());
  const configuredTargets: Array<
    ProjectionHostTarget & { readonly targetWitness: string }
  > = [];
  for (const host of remotes) {
    const configure = status.configures?.[host.id];
    if (
      !configure ||
      !configure.ok ||
      typeof configure.stationWitness !== "string" ||
      configure.stationWitness.length !== 64
    ) {
      continue;
    }
    configuredTargets.push({
      hostId: host.id,
      endpoint: host.endpoint!.trim(),
      mode: "remote",
      targetWitness: configure.stationWitness,
    });
  }

  if (configuredTargets.length === 0) {
    return {
      ok: true,
      skipped: true,
      detail:
        "no configured remote stations with expected witness (run Configure as Remote first)",
    } satisfies ProductProjectionPushResult;
  }

  const liveEither = yield* Effect.either(canvases.liveDocuments());
  if (liveEither._tag === "Left") {
    return {
      ok: false,
      detail: `live canvases unreadable: ${liveEither.left.message}`,
    } satisfies ProductProjectionPushResult;
  }

  const generationEither = yield* Effect.either(
    canvases.liveAuthorityGeneration(),
  );
  if (generationEither._tag === "Left") {
    return {
      ok: false,
      detail: `authority generation unreadable: ${generationEither.left.message}`,
    } satisfies ProductProjectionPushResult;
  }

  const documents = liveEither.right.map((row) => ({
    name: row.canvasName,
    doc: row.doc,
  }));

  // Projection generation is the live canvas-authority generation — not wall clock.
  const generation = generationEither.right;
  const commandCenterWitness = stationSettingsWitness(doc.station);
  const transport = createProjectionDeliveryTransport(ssh);
  const createdAt = new Date().toISOString();

  const outcomes: Array<ScheduleHostSyncResult["outcomes"][number]> = [];
  let lastResult: ScheduleHostSyncResult | undefined;

  // One frame per configured Station, stamped with that station's expected witness.
  for (const target of configuredTargets) {
    const pushEither = yield* Effect.either(
      Effect.tryPromise({
        try: () =>
          deliverProjectionToHosts(
            {
              generation,
              createdAt,
              commandCenterWitness,
              targetWitness: target.targetWitness,
              documents,
              targets: [
                {
                  hostId: target.hostId,
                  endpoint: target.endpoint,
                  mode: "remote",
                },
              ],
            },
            { transport },
          ),
        catch: (error) =>
          error instanceof Error ? error : new Error(String(error)),
      }),
    );

    if (pushEither._tag === "Left") {
      return {
        ok: false,
        detail: `projection push to ${target.hostId} failed: ${pushEither.left.message}`.slice(
          0,
          4_096,
        ),
      } satisfies ProductProjectionPushResult;
    }

    lastResult = pushEither.right;
    outcomes.push(...pushEither.right.outcomes);
  }

  if (lastResult === undefined) {
    return {
      ok: true,
      skipped: true,
      detail: "no configured remote stations with expected witness",
    } satisfies ProductProjectionPushResult;
  }

  return {
    ok: true,
    result: {
      generation: lastResult.generation,
      manifestSha256: lastResult.manifestSha256,
      frameSha256: lastResult.frameSha256,
      outcomes,
    },
  } satisfies ProductProjectionPushResult;
});
