/**
 * Command Center product path: compile live canvases and push frames to
 * enrolled remote hosts via SshTransport + named projection recipe.
 */

import { createHash } from "node:crypto";
import { Effect } from "effect";
import { RELEASE_CAPABILITIES } from "@shared/release-capabilities";
import { CanvasesService } from "../canvases";
import { HostsService } from "../hosts";
import { SettingsService } from "../settings/service";
import { stationSettingsWitness } from "../station-witness";
import { SshTransport } from "../ssh/service";
import {
  deliverProjectionToHosts,
  type ProjectionHostTarget,
  type ScheduleHostSyncResult,
} from "./delivery";
import { createProjectionDeliveryTransport } from "./remote-delivery";

const sha256Hex = (parts: ReadonlyArray<string>): string => {
  const h = createHash("sha256");
  for (const part of parts) {
    h.update(part);
    h.update("\0");
  }
  return h.digest("hex");
};

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
 * Push the current live canvas set to every enrolled remote host.
 *
 * Uses `createProjectionDeliveryTransport(ssh)` so remote mode runs the named
 * `compileProjectionFrameDeliver` recipe (never residual without transport).
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

  const liveEither = yield* Effect.either(canvases.liveDocuments());
  if (liveEither._tag === "Left") {
    return {
      ok: false,
      detail: `live canvases unreadable: ${liveEither.left.message}`,
    } satisfies ProductProjectionPushResult;
  }

  const documents = liveEither.right.map((row) => ({
    name: row.canvasName,
    doc: row.doc,
  }));

  const targets: ProjectionHostTarget[] = remotes.map((host) => ({
    hostId: host.id,
    endpoint: host.endpoint!.trim(),
    mode: "remote" as const,
  }));

  const generation = String(Date.now());
  const commandCenterWitness = stationSettingsWitness(doc.station);
  const targetWitness = sha256Hex([
    "fleet-full-canvas-set",
    ...remotes.map((h) => `${h.id}:${h.endpoint}`).sort(),
  ]);

  const transport = createProjectionDeliveryTransport(ssh);
  const pushEither = yield* Effect.either(
    Effect.tryPromise({
      try: () =>
        deliverProjectionToHosts(
          {
            generation,
            createdAt: new Date().toISOString(),
            commandCenterWitness,
            targetWitness,
            documents,
            targets,
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
      detail: `projection push failed: ${pushEither.left.message}`.slice(
        0,
        4_096,
      ),
    } satisfies ProductProjectionPushResult;
  }

  return {
    ok: true,
    result: pushEither.right,
  } satisfies ProductProjectionPushResult;
});
