import { createHash } from "node:crypto";
import { chmod, mkdtemp, open, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  compareLinuxDesktopVersions,
  LINUX_DESKTOP_UPDATE_FEED_PATH,
  LINUX_DESKTOP_MAX_METADATA_BYTES,
  LINUX_DESKTOP_MAX_ARCHIVE_BYTES,
  LINUX_DESKTOP_MAX_SOURCE_INDEX_BYTES,
  type LinuxDesktopSignedRelease,
} from "@shared/linux-desktop-release";
import {
  verifyLinuxDesktopRelease,
  type VerifiedLinuxDesktopRelease,
} from "@shared/linux-desktop-release-crypto";
import { verifyLinuxDesktopSourceBinding } from "@shared/linux-desktop-release-files";
import { linuxX64UpdateFeed } from "./compiled-config";
import { UpdateError, updateError } from "./errors";
import {
  activateLinuxDesktopRelease,
  LinuxDesktopActivationError,
  revalidateLinuxDesktopRelease,
  stageLinuxDesktopRelease,
  assertLinuxDesktopManagedIncumbent,
} from "./linux-install";
import { assertLinuxInstallDiskAdmission } from "./linux-install-storage";
import { assertLinuxDesktopUpdateTarget, readLinuxDesktopTargetObservation } from "./linux-target";
import type { StagedUpdate, UpdateHostHooks, UpdateProvider, UpdateProviderListener } from "./provider";


export interface LinuxUpdateDependencies {
  readonly fetch: (input: URL | RequestInfo, init?: RequestInit) => Promise<Response>;
  readonly inspectTarget: typeof readLinuxDesktopTargetObservation;
  readonly assertManagedIncumbent: () => Promise<void>;
  readonly verifyRelease: (envelope: unknown, currentVersion: string, requireNewer: boolean) => VerifiedLinuxDesktopRelease;
}

const defaults: LinuxUpdateDependencies = {
  fetch: (...args) => globalThis.fetch(...args),
  inspectTarget: readLinuxDesktopTargetObservation,
  assertManagedIncumbent: () => assertLinuxDesktopManagedIncumbent({ executablePath: process.execPath }),
  verifyRelease: (envelope, currentVersion, requireNewer) => verifyLinuxDesktopRelease(
    envelope, { currentVersion, requireNewer },
  ),
};

async function* responseChunks(body: ReadableStream<Uint8Array>): AsyncGenerator<Uint8Array> {
  const reader = body.getReader();
  try {
    while (true) {
      const next = await reader.read();
      if (next.done) return;
      yield next.value;
    }
  } finally {
    await reader.cancel().catch(() => undefined);
    reader.releaseLock();
  }
}

const boundedBody = async (response: Response, maximum: number): Promise<Uint8Array> => {
  if (!response.ok || response.body === null) throw new Error(`release server returned HTTP ${response.status}`);
  const chunks: Uint8Array[] = [];
  let bytes = 0;
  for await (const chunk of responseChunks(response.body)) {
    bytes += chunk.byteLength;
    if (bytes > maximum) throw new Error("release metadata exceeds its byte limit");
    chunks.push(chunk);
  }
  return Buffer.concat(chunks, bytes);
};

/** Fixed public feed, signed descriptor, bounded streaming download, explicit install. */
export const makeLinuxUpdateProvider = (options: {
  readonly isPackaged: boolean;
  readonly currentVersion: string;
}, dependencies: LinuxUpdateDependencies = defaults): UpdateProvider => {
  let listener: UpdateProviderListener | undefined;
  let flight: Promise<void> | undefined;
  let controller: AbortController | undefined;
  let downloadRoot: string | undefined;
  let downloaded: { readonly path: string; readonly sourcesPath: string; readonly envelope: LinuxDesktopSignedRelease } | undefined;
  const emit: UpdateProviderListener = (event) => listener?.(event);
  const base = new URL(linuxX64UpdateFeed().url);

  const check = async (): Promise<void> => {
    if (!options.isPackaged) {
      emit({ _tag: "error", code: "not-packaged", message: "updates are only available in packaged builds" });
      return;
    }
    let phase: "check-failed" | "download-failed" = "check-failed";
    const requestController = new AbortController();
    controller = requestController;
    try {
      assertLinuxDesktopUpdateTarget(await dependencies.inspectTarget());
      await dependencies.assertManagedIncumbent();
      emit({ _tag: "checking" });
      const response = await dependencies.fetch(new URL(LINUX_DESKTOP_UPDATE_FEED_PATH, base.origin), {
        redirect: "error", signal: AbortSignal.any([requestController.signal, AbortSignal.timeout(30_000)]),
      });
      const envelope: unknown = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(await boundedBody(response, LINUX_DESKTOP_MAX_METADATA_BYTES)));
      const release = dependencies.verifyRelease(envelope, options.currentVersion, false);
      if (compareLinuxDesktopVersions(release.version, options.currentVersion) <= 0) {
        emit({ _tag: "not-available" });
        return;
      }
      const admitted = dependencies.verifyRelease(envelope, options.currentVersion, true);
      if (admitted.archive.bytes > LINUX_DESKTOP_MAX_ARCHIVE_BYTES) throw new Error("release archive exceeds its byte limit");
      await assertLinuxInstallDiskAdmission({ path: tmpdir(), archiveBytes: admitted.archive.bytes });
      emit({ _tag: "available", release: { version: admitted.version, releaseDate: admitted.createdAt } });
      phase = "download-failed";
      if (downloadRoot !== undefined) await rm(downloadRoot, { recursive: true, force: true });
      downloadRoot = await mkdtemp(join(tmpdir(), "junto-linux-update-"));
      await chmod(downloadRoot, 0o700);
      const archivePath = join(downloadRoot, admitted.archive.file);
      const sourcesPath = join(downloadRoot, "sources.json");
      const sourcesResponse = await dependencies.fetch(new URL(admitted.sources.path, base.origin), {
        redirect: "error", signal: AbortSignal.any([requestController.signal, AbortSignal.timeout(30_000)]),
      });
      const sources = await boundedBody(sourcesResponse, Math.min(admitted.sources.bytes, LINUX_DESKTOP_MAX_SOURCE_INDEX_BYTES));
      if (sources.byteLength !== admitted.sources.bytes || createHash("sha256").update(sources).digest("hex") !== admitted.sources.sha256) {
        throw new Error("source index does not match its signed size and SHA-256");
      }
      await writeFile(sourcesPath, sources, { flag: "wx", mode: 0o600 });
      const archiveResponse = await dependencies.fetch(new URL(admitted.archive.path, base.origin), {
        redirect: "error", signal: AbortSignal.any([requestController.signal, AbortSignal.timeout(10 * 60_000)]),
      });
      if (!archiveResponse.ok || archiveResponse.body === null) throw new Error(`release archive returned HTTP ${archiveResponse.status}`);
      const contentLength = archiveResponse.headers.get("content-length");
      if (contentLength !== null && Number(contentLength) !== admitted.archive.bytes) throw new Error("release archive size differs from signed descriptor");
      const archive = await open(archivePath, "wx", 0o600);
      let transferred = 0;
      const startedAt = Date.now();
      let lastProgressAt = 0;
      const hash = createHash("sha256");
      try {
        for await (const chunk of responseChunks(archiveResponse.body)) {
          transferred += chunk.byteLength;
          if (transferred > admitted.archive.bytes) throw new Error("release archive exceeds signed size");
          hash.update(chunk);
          await archive.writeFile(chunk);
          const now = Date.now();
          if (now - lastProgressAt >= 250 || transferred === admitted.archive.bytes) {
            lastProgressAt = now;
            emit({ _tag: "progress", progress: {
              percent: transferred / admitted.archive.bytes * 100,
              transferred, total: admitted.archive.bytes,
              bytesPerSecond: transferred / Math.max(0.001, (now - startedAt) / 1000),
            } });
          }
        }
        await archive.sync();
      } finally {
        await archive.close();
      }
      if (transferred !== admitted.archive.bytes || hash.digest("hex") !== admitted.archive.sha256) {
        throw new Error("release archive does not match its signed size and SHA-256");
      }
      await verifyLinuxDesktopSourceBinding({ archivePath, sourceIndexPath: sourcesPath,
        version: admitted.version, sourceRevision: admitted.sourceRevision });
      downloaded = { path: archivePath, sourcesPath, envelope: envelope as LinuxDesktopSignedRelease };
      emit({ _tag: "downloaded", release: { version: admitted.version, releaseDate: admitted.createdAt }, downloadedFile: archivePath });
    } catch (cause) {
      downloaded = undefined;
      if (downloadRoot !== undefined) await rm(downloadRoot, { recursive: true, force: true }).catch(() => undefined);
      downloadRoot = undefined;
      if (!requestController.signal.aborted) emit({ _tag: "error",
        code: cause instanceof UpdateError ? cause.updateCode : phase,
        message: (cause instanceof Error ? cause.message : "Linux update failed").slice(0, 500),
      });
    } finally {
      controller = undefined;
    }
  };

  return {
    kind: "linux",
    start: (next) => { listener = next; },
    stop: () => {
      listener = undefined;
      controller?.abort();
      if (downloadRoot !== undefined) void rm(downloadRoot, { recursive: true, force: true }).catch(() => undefined);
      downloadRoot = undefined;
    },
    check: () => {
      flight ??= check().finally(() => { flight = undefined; });
      return flight;
    },
    stageDownloaded: async (downloadedFile, release): Promise<StagedUpdate> => {
      if (downloaded === undefined || downloaded.path !== downloadedFile) {
        throw updateError("candidate-mismatch", "Linux update was not downloaded by this provider");
      }
      const envelope = downloaded.envelope;
      const descriptor = dependencies.verifyRelease(envelope, options.currentVersion, true);
      if (descriptor.version !== release.version) throw updateError("candidate-mismatch", "Linux staged release version differs from the authenticated descriptor");
      await dependencies.assertManagedIncumbent();
      const binding = await verifyLinuxDesktopSourceBinding({ archivePath: downloadedFile, sourceIndexPath: downloaded.sourcesPath,
        version: descriptor.version, sourceRevision: descriptor.sourceRevision });
      if (binding.sources.bytes !== descriptor.sources.bytes || binding.sources.sha256 !== descriptor.sources.sha256) {
        throw updateError("candidate-mismatch", "downloaded source index changed after admission");
      }
      const staged = await stageLinuxDesktopRelease({ archivePath: downloadedFile, descriptor });
      let activated = false;
      const revalidate = async () => {
        dependencies.verifyRelease(envelope, options.currentVersion, true);
        await dependencies.assertManagedIncumbent();
        await revalidateLinuxDesktopRelease(staged);
      };
      return Object.freeze({
        executablePath: staged.executablePath,
        revalidate,
        hasActivated: () => activated,
        installAfterQuiesce: async (host: UpdateHostHooks) => {
          if (host.relaunchInstalled === undefined) throw new Error("installed release relaunch is unavailable");
          await revalidate();
          try {
            await activateLinuxDesktopRelease(staged, { mode: "update", expectedIncumbentExecutablePath: process.execPath });
            activated = true;
          } catch (error) {
            if (error instanceof LinuxDesktopActivationError && error.activated) activated = true;
            throw error;
          }
          host.relaunchInstalled(staged.executablePath);
        },
      });
    },
    quitAndInstall: () => { throw updateError("install-refused", "Linux updates require the admitted installation transaction"); },
  };
};

export const makeUnsupportedUpdateProvider = (platform: string): UpdateProvider => {
  let listener: UpdateProviderListener | undefined;
  const refuse = () => listener?.({ _tag: "error", code: "platform-unsupported", message: `auto-update is not supported on ${platform}` });
  return { kind: "unsupported", start: (next) => { listener = next; }, stop: () => { listener = undefined; },
    check: async () => { refuse(); }, quitAndInstall: refuse };
};
