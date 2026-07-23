/**
 * Remote station: pull full canvas documents from the Command Center over SSH.
 *
 * Read-only foundation — never mutates Command Center files. Writes only the
 * local ~/.vellum/canvases plane (atomic replace of each pulled .canvas).
 * Authorial writeCanvas remains denied for role=remote (ipc denyIfRemoteAuthorial).
 */

import { lstat, open, readFile, readdir, rename, rm } from "node:fs/promises";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { posix } from "node:path";
import type { Context } from "effect";
import { Effect, Either } from "effect";
import {
  canvasNameFromListingEntry,
  canvasPullFileName,
  canvasPullResult,
  parseRemoteCanvasListing,
  resolveCommandCenterEndpoint,
  type CanvasPullFileFailure,
  type CanvasPullFileResult,
  type CanvasPullResult,
} from "@shared/canvas-pull";
import { pullRecordFromResult } from "@shared/station-status";
import { applyMirrorLaw, decodeCanvasDoc, serializeCanvas } from "@shared/canvas";
import type { StationSettings } from "@shared/settings";
import type { RemoteHost } from "@shared/remote-hosts";
import { SettingsService } from "./settings/service";
import { HostsService } from "./hosts/service";
import {
  CanvasError,
  canvasNameFrom,
  ensureCanvasesDir,
} from "./canvases";
import { recordStationPull } from "./station-status-store";
import {
  makeStationPullAdmissionWitness,
  readLocalCanvasMirrorWitness,
  stationSettingsWitness,
} from "./station-witness";
import {
  makeRemoteCommand,
  parseSshEndpoint,
  SshTimeoutError,
  type SshError,
} from "./ssh/domain";
import { homeDirectoryLookup, oneShot } from "./ssh/program";
import { SshTransport } from "./ssh/service";

const PROBE_TIMEOUT_MS = 10_000;

type Ssh = Context.Tag.Service<typeof SshTransport>;

const pullStationContext = Symbol("vellum.pull-station-context");
type StationBoundCanvasPullResult = CanvasPullResult & {
  readonly [pullStationContext]?: StationSettings;
};

const stationBoundPullResult = (
  station: StationSettings,
  partial: Parameters<typeof canvasPullResult>[0],
): StationBoundCanvasPullResult => {
  const result = canvasPullResult(partial) as StationBoundCanvasPullResult;
  Object.defineProperty(result, pullStationContext, {
    value: Object.freeze({ ...station }),
    enumerable: false,
    configurable: false,
    writable: false,
  });
  return result;
};

const classifySshFailure = (message: string): string => {
  if (/Permission denied|publickey|Authentication failed/i.test(message)) {
    return "Permission denied — check SSH keys / ssh-agent.";
  }
  if (/Could not resolve hostname|Name or service not known|nodename nor servname/i.test(message)) {
    return "Unknown host — add a Host entry in ~/.ssh/config or use a resolvable hostname.";
  }
  if (/Connection timed out|Operation timed out|ETIMEDOUT|ConnectTimeout/i.test(message)) {
    return "Timeout — Command Center unreachable (VPN/Tailscale down, wrong endpoint, or firewall).";
  }
  if (/Host key verification failed/i.test(message)) {
    return "Host key rejected — verify fingerprint then `ssh-keygen -R <host>` if rebuilt.";
  }
  if (/Connection refused/i.test(message)) {
    return "Connection refused — sshd not listening on the Command Center, or wrong port.";
  }
  return message;
};

const describeSshError = (error: SshError): string => {
  switch (error._tag) {
    case "SshTimeoutError":
      return classifySshFailure(`Connection timed out after ${error.timeoutMs}ms`);
    case "SshExitError":
      return classifySshFailure(`ssh exited with code ${error.code}`);
    case "SshInputError":
      return `Invalid endpoint: ${error.message}`;
    case "SshOutputLimitError":
      return `Remote canvas exceeded ${error.limitBytes} byte transport limit (${error.stream})`;
    default:
      return classifySshFailure(error.message);
  }
};

const formatUnknown = (error: unknown): string => {
  if (error && typeof error === "object" && "_tag" in error) {
    return describeSshError(error as SshError);
  }
  return error instanceof Error ? error.message : String(error);
};

const syncCanvasDirectoryBestEffort = async (
  targetDir: string,
  operation: "install" | "delete",
): Promise<void> => {
  let directory: Awaited<ReturnType<typeof open>> | undefined;
  try {
    directory = await open(targetDir, "r");
    await directory.sync();
  } catch (error) {
    console.error(
      `[canvas-pull] directory sync failed after committed ${operation}:`,
      error,
    );
  } finally {
    await directory?.close().catch(() => undefined);
  }
};

/**
 * Atomic install of validated canvas file bytes into the local canvases dir.
 * Replace-entire-file semantics (no merge). Returns whether content changed.
 */
export const atomicInstallCanvasFile = async (
  name: string,
  contents: string,
): Promise<{ readonly bytes: number; readonly changed: boolean }> => {
  const canonicalName = canvasNameFrom(name);
  const prepared = preparePulledCanvasBody(canonicalName, contents);
  if (!prepared.ok) throw new CanvasError({ message: prepared.detail });

  const targetDir = await ensureCanvasesDir();
  const path = join(targetDir, canvasPullFileName(canonicalName));
  try {
    const info = await lstat(path);
    if (!info.isFile() || info.isSymbolicLink()) {
      throw new CanvasError({
        message: `refusing non-regular canvas file: ${canvasPullFileName(canonicalName)}`,
      });
    }
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
  }

  let previous: string | undefined;
  try {
    previous = await readFile(path, "utf8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
  }
  if (previous === prepared.body) {
    return { bytes: Buffer.byteLength(prepared.body, "utf8"), changed: false };
  }
  const tmpPath = `${path}.${randomUUID()}.tmp`;
  const file = await open(tmpPath, "wx", 0o600);
  let ownsTemp = true;
  try {
    await file.writeFile(prepared.body, { encoding: "utf8" });
    await file.sync();
    await file.close();
    await rename(tmpPath, path);
    ownsTemp = false;
  } catch (error) {
    await file.close().catch(() => undefined);
    if (ownsTemp) await rm(tmpPath, { force: true }).catch(() => undefined);
    throw error;
  }

  await syncCanvasDirectoryBestEffort(targetDir, "install");
  return { bytes: Buffer.byteLength(prepared.body, "utf8"), changed: true };
};

/**
 * Validate remote raw JSON as a canvas document and re-serialize canonically
 * so local files always pass decodeCanvasDoc after pull.
 */
export const preparePulledCanvasBody = (
  name: string,
  raw: string,
): { readonly ok: true; readonly body: string } | { readonly ok: false; readonly detail: string } => {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (error) {
    return {
      ok: false,
      detail: `${canvasPullFileName(name)} is not valid JSON: ${
        error instanceof Error ? error.message : String(error)
      }`,
    };
  }
  const decoded = decodeCanvasDoc(parsed);
  if (Either.isLeft(decoded)) {
    return {
      ok: false,
      detail: `${canvasPullFileName(name)} failed validation: ${decoded.left.message}`,
    };
  }
  try {
    // Same canonical path as CanvasesService.write (mirror law + serialize).
    const body = serializeCanvas(applyMirrorLaw(decoded.right));
    return { ok: true, body };
  } catch (error) {
    return {
      ok: false,
      detail: `${canvasPullFileName(name)} serialize failed: ${
        error instanceof Error ? error.message : String(error)
      }`,
    };
  }
};

const listRemoteCanvasNames = (
  ssh: Ssh,
  endpoint: Parameters<typeof oneShot>[0],
  remoteCanvasesDir: string,
): Effect.Effect<ReadonlyArray<string>, SshError> =>
  makeRemoteCommand("ls", ["-1", remoteCanvasesDir]).pipe(
    Effect.flatMap((command) => ssh.run(oneShot(endpoint, command, { budget: "list" }))),
    Effect.map((result) => parseRemoteCanvasListing(result.stdout)),
  );

const catRemoteCanvas = (
  ssh: Ssh,
  endpoint: Parameters<typeof oneShot>[0],
  remotePath: string,
): Effect.Effect<string, SshError> =>
  makeRemoteCommand("cat", [remotePath]).pipe(
    Effect.flatMap((command) => ssh.run(oneShot(endpoint, command, { budget: "bulk" }))),
    Effect.map((result) => result.stdout),
  );

type CanvasMirrorDeletionResult = {
  readonly deleted: ReadonlyArray<string>;
  readonly failed: ReadonlyArray<CanvasPullFileFailure>;
};

/**
 * Reconcile the local document set to an authoritative successful remote
 * listing. Only canonical, regular `.canvas` files inside the configured
 * canvas directory are eligible for removal; sidecars and unknown entries
 * are not part of this authority.
 */
const deleteLocalCanvasesAbsentFrom = async (
  remoteNames: ReadonlyArray<string>,
): Promise<CanvasMirrorDeletionResult> => {
  const targetDir = await ensureCanvasesDir();
  const remoteFiles = new Set(remoteNames.map(canvasPullFileName));
  const entries = await readdir(targetDir, { withFileTypes: true });
  const stale = entries
    .filter((entry) => entry.isFile() && !remoteFiles.has(entry.name))
    .flatMap((entry) => {
      const name = canvasNameFromListingEntry(entry.name);
      return name === undefined ? [] : [{ name, fileName: entry.name }];
    })
    .sort((a, b) => a.name.localeCompare(b.name));

  const deleted: string[] = [];
  const failed: CanvasPullFileFailure[] = [];
  for (const candidate of stale) {
    const path = join(targetDir, candidate.fileName);
    try {
      const info = await lstat(path);
      if (!info.isFile() || info.isSymbolicLink()) {
        throw new CanvasError({
          message: `refusing non-regular canvas file: ${candidate.fileName}`,
        });
      }
      await rm(path);
      deleted.push(candidate.name);
    } catch (error) {
      failed.push({
        name: candidate.name,
        detail: `failed to remove local canvas absent from Command Center: ${formatUnknown(error)}`,
      });
    }
  }

  if (deleted.length > 0) {
    await syncCanvasDirectoryBestEffort(targetDir, "delete");
  }
  return { deleted, failed };
};

/**
 * Pull all .canvas documents from the Command Center into the local canvases dir.
 * Only meaningful when station.role === "remote". On SSH failure, keeps last local files.
 */
export const pullCanvasesFromCommandCenter = Effect.gen(function* () {
    const settingsSvc = yield* SettingsService;
    const hostsSvc = yield* HostsService;
    const ssh = yield* SshTransport;

    const settingsEither = yield* Effect.either(settingsSvc.get);
    if (settingsEither._tag === "Left") {
      return canvasPullResult({
        ok: false,
        status: "misconfigured",
        detail: `settings unreadable: ${settingsEither.left.message}`,
        commandCenterRef: "",
        pulled: [],
        failed: [],
        keptLocal: true,
      });
    }

    const station = settingsEither.right.station;
    const ref = station.commandCenterRef;

    if (station.role !== "remote") {
      return stationBoundPullResult(station, {
        ok: false,
        status: "skipped_not_remote",
        detail:
          station.role === "command-center"
            ? "This station is Command Center — canvas pull is Remote-only"
            : "Station role is not set to Remote — complete onboarding first",
        commandCenterRef: ref,
        pulled: [],
        failed: [],
        keptLocal: true,
      });
    }

    const hostsResult = yield* Effect.either(hostsSvc.list);
    const hosts: ReadonlyArray<RemoteHost> =
      hostsResult._tag === "Right" ? hostsResult.right : [];

    const resolved = resolveCommandCenterEndpoint(ref, hosts);
    if (!resolved.ok) {
      return stationBoundPullResult(station, {
        ok: false,
        status: "misconfigured",
        detail: resolved.detail,
        commandCenterRef: ref,
        pulled: [],
        failed: [],
        keptLocal: true,
      });
    }

    const endpointEffect = yield* Effect.either(parseSshEndpoint(resolved.endpoint));
    if (endpointEffect._tag === "Left") {
      return stationBoundPullResult(station, {
        ok: false,
        status: "misconfigured",
        detail: `Invalid Command Center endpoint: ${endpointEffect.left.message}`,
        commandCenterRef: ref,
        endpoint: resolved.endpoint,
        pulled: [],
        failed: [],
        keptLocal: true,
      });
    }
    const endpoint = endpointEffect.right;

    const warmResult = yield* Effect.either(
      ssh.warm(endpoint).pipe(
        Effect.timeoutFail({
          duration: PROBE_TIMEOUT_MS,
          onTimeout: () =>
            new SshTimeoutError({
              endpoint: resolved.endpoint,
              operation: "pull-warm",
              timeoutMs: PROBE_TIMEOUT_MS,
            }),
        }),
      ),
    );
    if (warmResult._tag === "Left") {
      return stationBoundPullResult(station, {
        ok: false,
        status: "unreachable",
        detail: `Command Center unreachable — kept last local canvases. ${formatUnknown(warmResult.left)}`,
        commandCenterRef: ref,
        endpoint: resolved.endpoint,
        pulled: [],
        failed: [],
        keptLocal: true,
      });
    }

    const homeResult = yield* Effect.either(ssh.run(homeDirectoryLookup(endpoint)));
    if (homeResult._tag === "Left") {
      return stationBoundPullResult(station, {
        ok: false,
        status: "unreachable",
        detail: `Command Center unreachable — kept last local canvases. ${formatUnknown(homeResult.left)}`,
        commandCenterRef: ref,
        endpoint: resolved.endpoint,
        pulled: [],
        failed: [],
        keptLocal: true,
      });
    }

    const homePath = homeResult.right.stdout.trim();
    if (!homePath.startsWith("/")) {
      return stationBoundPullResult(station, {
        ok: false,
        status: "unreachable",
        detail: `Command Center home not readable (got ${JSON.stringify(homePath)}) — kept last local canvases`,
        commandCenterRef: ref,
        endpoint: resolved.endpoint,
        pulled: [],
        failed: [],
        keptLocal: true,
      });
    }

    const remoteCanvasesDir = posix.join(homePath, ".vellum", "canvases");

    const listResult = yield* Effect.either(
      listRemoteCanvasNames(ssh, endpoint, remoteCanvasesDir),
    );
    if (listResult._tag === "Left") {
      return stationBoundPullResult(station, {
        ok: false,
        status: "unreachable",
        detail: `Failed to list Command Center canvases — kept last local. ${formatUnknown(listResult.left)}`,
        commandCenterRef: ref,
        endpoint: resolved.endpoint,
        pulled: [],
        failed: [],
        keptLocal: true,
      });
    }

    const names = listResult.right;
    const pulled: CanvasPullFileResult[] = [];
    const failed: CanvasPullFileFailure[] = [];

    for (const name of names) {
      const remotePath = posix.join(remoteCanvasesDir, canvasPullFileName(name));
      const catResult = yield* Effect.either(catRemoteCanvas(ssh, endpoint, remotePath));
      if (catResult._tag === "Left") {
        failed.push({
          name,
          detail: formatUnknown(catResult.left),
        });
        continue;
      }

      const prepared = preparePulledCanvasBody(name, catResult.right);
      if (!prepared.ok) {
        failed.push({ name, detail: prepared.detail });
        continue;
      }

      const install = yield* Effect.either(
        Effect.tryPromise({
          try: () => atomicInstallCanvasFile(name, prepared.body),
          catch: (error) =>
            error instanceof Error ? error : new Error(String(error)),
        }),
      );
      if (install._tag === "Left") {
        failed.push({
          name,
          detail: install.left.message,
        });
        continue;
      }

      pulled.push({
        name,
        bytes: install.right.bytes,
        changed: install.right.changed,
      });
    }

    const mirrorResult = yield* Effect.either(
      Effect.tryPromise({
        try: () => deleteLocalCanvasesAbsentFrom(names),
        catch: (error) =>
          error instanceof Error ? error : new Error(String(error)),
      }),
    );
    const deleted =
      mirrorResult._tag === "Right" ? mirrorResult.right.deleted : [];
    if (mirrorResult._tag === "Right") {
      failed.push(...mirrorResult.right.failed);
    } else {
      failed.push({
        name: "local-mirror",
        detail: `failed to reconcile the local canvas mirror: ${mirrorResult.left.message}`,
      });
    }

    if (names.length === 0 && failed.length === 0) {
      return stationBoundPullResult(station, {
        ok: true,
        status: "empty",
        detail:
          `No .canvas files on Command Center at ${remoteCanvasesDir}` +
          ` (${deleted.length} stale local removed)`,
        commandCenterRef: ref,
        endpoint: resolved.endpoint,
        pulled: [],
        failed: [],
        keptLocal: false,
      });
    }

    if (pulled.length === 0 && failed.length > 0) {
      return stationBoundPullResult(station, {
        ok: false,
        status: "partial",
        detail:
          `Pulled 0/${names.length} canvases from Command Center — all failed` +
          ` (${deleted.length} stale local removed)`,
        commandCenterRef: ref,
        endpoint: resolved.endpoint,
        pulled,
        failed,
        keptLocal: deleted.length === 0,
      });
    }

    if (failed.length > 0) {
      return stationBoundPullResult(station, {
        ok: false,
        status: "partial",
        detail:
          `Pulled ${pulled.length}/${names.length} canvases from Command Center` +
          ` (${failed.length} failed; ${deleted.length} stale local removed)`,
        commandCenterRef: ref,
        endpoint: resolved.endpoint,
        pulled,
        failed,
        keptLocal: false,
      });
    }

    const changed = pulled.filter((row) => row.changed).length;
    return stationBoundPullResult(station, {
      ok: true,
      status: "ok",
      detail:
        `Pulled ${pulled.length} canvas(es) from Command Center` +
        ` (${changed} updated; ${deleted.length} stale local removed)`,
      commandCenterRef: ref,
      endpoint: resolved.endpoint,
      pulled,
      failed: [],
      keptLocal: false,
    });
}).pipe(
  Effect.catchAll((error) =>
    Effect.succeed(
      canvasPullResult({
        ok: false,
        status: "unreachable",
        detail: `Pull failed — kept last local canvases. ${formatUnknown(error)}`,
        commandCenterRef: "",
        pulled: [],
        failed: [],
        keptLocal: true,
      }),
    ),
  ),
  Effect.tap((result: StationBoundCanvasPullResult) =>
    Effect.gen(function* () {
      const settingsSvc = yield* SettingsService;
      const stationAtPull = result[pullStationContext];
      let admission: ReturnType<typeof makeStationPullAdmissionWitness> | undefined;
      const complete =
        result.ok &&
        !result.keptLocal &&
        result.failed.length === 0 &&
        (result.status === "ok" || result.status === "empty");

      if (complete && stationAtPull?.role === "remote") {
        const currentSettings = yield* Effect.either(settingsSvc.get);
        if (
          currentSettings._tag === "Right" &&
          currentSettings.right.station.role === "remote" &&
          stationSettingsWitness(currentSettings.right.station) ===
            stationSettingsWitness(stationAtPull) &&
          result.commandCenterRef === stationAtPull.commandCenterRef
        ) {
          const mirror = yield* Effect.either(
            Effect.tryPromise({
              try: readLocalCanvasMirrorWitness,
              catch: (error) =>
                error instanceof Error ? error : new Error(String(error)),
            }),
          );
          if (
            mirror._tag === "Right" &&
            mirror.right.canvasCount === result.pulled.length
          ) {
            admission = makeStationPullAdmissionWitness(
              stationAtPull,
              mirror.right,
            );
          }
        }
      }

      yield* Effect.promise(() =>
        recordStationPull(pullRecordFromResult(result, admission)).catch(
          () => undefined,
        ),
      );
    }),
  ),
);
