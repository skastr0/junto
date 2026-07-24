/**
 * Remote station: pull full canvas documents from the Command Center over SSH.
 *
 * Read-only foundation — never mutates Command Center files. Stages the full
 * set under a temp dir, then promotes to live only on complete success
 * (pairing/role re-check before apply). Authorial writeCanvas remains denied
 * for role=remote (ipc denyIfRemoteAuthorial).
 */

import { lstat, mkdir, open, readFile, readdir, rename, rm } from "node:fs/promises";
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
  CanvasesService,
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
  parseSshEndpoint,
  SshTimeoutError,
  type SshError,
} from "./ssh/domain";
import { homeDirectoryLookup, oneShot } from "./ssh/program";
import { remoteCat, remoteLs } from "./ssh/read-commands";
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

const writeExclusiveCanvasBody = async (
  path: string,
  body: string,
): Promise<void> => {
  const tmpPath = `${path}.${randomUUID()}.tmp`;
  const file = await open(tmpPath, "wx", 0o600);
  let ownsTemp = true;
  try {
    await file.writeFile(body, { encoding: "utf8" });
    await file.sync();
    await file.close();
    await rename(tmpPath, path);
    ownsTemp = false;
  } catch (error) {
    await file.close().catch(() => undefined);
    if (ownsTemp) await rm(tmpPath, { force: true }).catch(() => undefined);
    throw error;
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
  await writeExclusiveCanvasBody(path, prepared.body);
  await syncCanvasDirectoryBestEffort(targetDir, "install");
  return { bytes: Buffer.byteLength(prepared.body, "utf8"), changed: true };
};

type StagedCanvasFile = {
  readonly name: string;
  readonly body: string;
  readonly bytes: number;
};

/**
 * Write a fully-validated canvas body into a pull staging directory. Never
 * touches live authority — stage must succeed completely before apply.
 */
export const writeStagedCanvasFile = async (
  stageDir: string,
  name: string,
  body: string,
): Promise<StagedCanvasFile> => {
  const canonicalName = canvasNameFrom(name);
  const path = join(stageDir, canvasPullFileName(canonicalName));
  await writeExclusiveCanvasBody(path, body);
  return {
    name: canonicalName,
    body,
    bytes: Buffer.byteLength(body, "utf8"),
  };
};

/**
 * Promote a complete staged set into the live canvases directory.
 * Per-file POSIX rename is atomic; the set is only applied after every staged
 * file is present. Callers must not invoke this with a partial stage.
 */
export const applyStagedCanvasProjection = async (
  stageDir: string,
  staged: ReadonlyArray<StagedCanvasFile>,
): Promise<ReadonlyArray<CanvasPullFileResult>> => {
  const targetDir = await ensureCanvasesDir();
  const pulled: CanvasPullFileResult[] = [];

  for (const file of staged) {
    const livePath = join(targetDir, canvasPullFileName(file.name));
    const stagePath = join(stageDir, canvasPullFileName(file.name));
    try {
      const info = await lstat(livePath);
      if (!info.isFile() || info.isSymbolicLink()) {
        throw new CanvasError({
          message: `refusing non-regular canvas file: ${canvasPullFileName(file.name)}`,
        });
      }
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    }

    let previous: string | undefined;
    try {
      previous = await readFile(livePath, "utf8");
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    }
    const changed = previous !== file.body;
    if (changed) {
      // Same-FS rename replaces the live file atomically.
      await rename(stagePath, livePath);
    }
    pulled.push({ name: file.name, bytes: file.bytes, changed });
  }

  if (pulled.some((row) => row.changed)) {
    await syncCanvasDirectoryBestEffort(targetDir, "install");
  }
  return pulled;
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
  remoteLs(remoteCanvasesDir).pipe(
    Effect.flatMap((command) => ssh.run(oneShot(endpoint, command, { budget: "list" }))),
    Effect.map((result) => parseRemoteCanvasListing(result.stdout)),
  );

const catRemoteCanvas = (
  ssh: Ssh,
  endpoint: Parameters<typeof oneShot>[0],
  remotePath: string,
): Effect.Effect<string, SshError> =>
  remoteCat(remotePath).pipe(
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
/**
 * Beta: product canvas-pull is disabled. Fleet intent uses projection push.
 * Module retained only so residual imports/tests compile until deleted.
 */
export const pullCanvasesFromCommandCenter = Effect.gen(function* () {
  const settingsSvc = yield* SettingsService;
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
  return stationBoundPullResult(station, {
    ok: false,
    status: "misconfigured",
    detail:
      "canvas-pull is disabled for beta; fleet intent uses station projection push",
    commandCenterRef: station.commandCenterRef,
    pulled: [],
    failed: [],
    keptLocal: true,
  });
});
