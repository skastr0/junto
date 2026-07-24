/**
 * Command Center product path: compile live canvases and push frames to
 * configured remote Stations via SshTransport + named projection recipe.
 *
 * Cut 4: projection generation = canvas-authority generation; one frame per
 * configured Station stamped with that station's expected witness. Inventory-
 * only hosts (enrolled but never successfully configured) are skipped.
 *
 * Cut 5: after stage, reconcile remote applied.ack → applied; reconvergence
 * re-pushes when last confirmed gen lags desired authority generation.
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
import {
  needsProjectionRepush,
  promoteHostDeliveryFromAck,
  reconcileStagedProjectionAcks,
} from "./reconcile";

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

export type ProductProjectionReconcileResult =
  | {
      readonly ok: true;
      readonly promoted: number;
      readonly pushed: boolean;
      readonly push?: ProductProjectionPushResult;
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
 * After staging, reads remote applied.ack and promotes matching hosts.
 *
 * Skips hosts already `applied` at the desired authority generation so
 * reconvergence ticks do not thrash.
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
  let skippedCurrent = 0;

  // One frame per configured Station, stamped with that station's expected witness.
  for (const target of configuredTargets) {
    const existing = status.projections?.[target.hostId];
    // Already applied at desired gen — no re-stage unless reconvergence forces.
    if (
      existing &&
      existing.status === "applied" &&
      existing.generation === generation
    ) {
      skippedCurrent += 1;
      outcomes.push({ hostId: target.hostId, record: existing });
      continue;
    }
    // Staged at desired gen — try ack promote first; re-stage only if needed later.
    if (
      existing &&
      existing.status === "staged" &&
      existing.generation === generation &&
      existing.endpoint
    ) {
      const promoted = yield* promoteHostDeliveryFromAck(ssh, {
        hostId: target.hostId,
        endpoint: existing.endpoint,
        staged: existing,
      });
      if (promoted.status === "applied") {
        skippedCurrent += 1;
        outcomes.push({ hostId: target.hostId, record: promoted.record });
        continue;
      }
      // Still staged without matching ack — leave staged, do not re-push same gen
      // (Remote inbox will apply; next reconcile tick promotes).
      if (!needsProjectionRepush(generation, existing)) {
        skippedCurrent += 1;
        outcomes.push({ hostId: target.hostId, record: existing });
        continue;
      }
    }

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
    const hostOutcomes = [...pushEither.right.outcomes];

    // Immediately try ack promote for staged deliveries (Remote may have
    // applied between prior push and this tick, or very fast inbox).
    for (let i = 0; i < hostOutcomes.length; i++) {
      const outcome = hostOutcomes[i]!;
      if (outcome.record.status !== "staged" || !outcome.record.endpoint) {
        continue;
      }
      const promoted = yield* promoteHostDeliveryFromAck(ssh, {
        hostId: outcome.hostId,
        endpoint: outcome.record.endpoint,
        staged: outcome.record,
      });
      if (promoted.status === "applied") {
        hostOutcomes[i] = {
          hostId: outcome.hostId,
          record: promoted.record,
        };
      }
    }

    outcomes.push(...hostOutcomes);
  }

  if (lastResult === undefined && outcomes.length === 0) {
    return {
      ok: true,
      skipped: true,
      detail: "no configured remote stations with expected witness",
    } satisfies ProductProjectionPushResult;
  }

  if (lastResult === undefined) {
    // All hosts already current — synthesize result from desired generation.
    const first = outcomes[0]?.record;
    return {
      ok: true,
      result: {
        generation,
        manifestSha256: first?.manifestSha256 ?? "0".repeat(64),
        frameSha256: first?.frameSha256 ?? "0".repeat(64),
        outcomes,
      },
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

/**
 * CC reconvergence tick: promote staged→applied from remote acks, then
 * re-push newest authority generation where last confirmed gen lags.
 * Does not require a canvas edit.
 */
export const reconcileLiveProjectionWithRemotes = Effect.gen(function* () {
  if (!RELEASE_CAPABILITIES.stationProjection) {
    return {
      ok: true as const,
      promoted: 0,
      pushed: false,
      detail: "stationProjection capability is disabled",
    } satisfies ProductProjectionReconcileResult;
  }

  const settings = yield* SettingsService;
  const settingsEither = yield* Effect.either(settings.get);
  if (settingsEither._tag === "Left") {
    return {
      ok: false as const,
      detail: `settings unreadable: ${settingsEither.left.message}`,
    } satisfies ProductProjectionReconcileResult;
  }
  if (settingsEither.right.station.role !== "command-center") {
    return {
      ok: true as const,
      promoted: 0,
      pushed: false,
      detail: "projection reconcile is Command Center only",
    } satisfies ProductProjectionReconcileResult;
  }

  const ssh = yield* SshTransport;
  const ackOutcomes = yield* reconcileStagedProjectionAcks(ssh);
  const promoted = ackOutcomes.filter((o) => o.result.status === "applied")
    .length;

  // Re-push where desired gen is ahead of last receipt (unreachable reconnect
  // or never-acked stage of an older gen). pushLiveProjectionToEnrolledRemotes
  // skips already-applied matching gens.
  const push = yield* pushLiveProjectionToEnrolledRemotes;
  const pushed = push.ok && !push.skipped;

  return {
    ok: true as const,
    promoted,
    pushed: Boolean(pushed),
    push,
    detail: `promoted ${promoted} ack(s); push ${
      push.ok ? (push.skipped ? "skipped" : "ran") : "failed"
    }`,
  } satisfies ProductProjectionReconcileResult;
});
