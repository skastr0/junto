/**
 * electron-updater is CommonJS. electron-vite externalizes deps, so a named
 * ESM import dies at packaged main load with
 * "Named export 'autoUpdater' not found". Load via createRequire (same pattern
 * as term/observer/session-observer for @xterm/headless).
 *
 * Lazy: the package's autoUpdater getter constructs MacUpdater immediately,
 * which needs Electron's app. Eager require at module load blows up vitest
 * (and any import graph that only needs types / composition).
 */
import { createRequire } from "node:module";
import type { AppUpdater } from "electron-updater";
import type { AvailableRelease } from "@shared/update";
import { macArm64UpdateFeed } from "./compiled-config";
import { readUpdateArchiveDigest } from "./domain";
import { updateError } from "./errors";
import { expandMacUpdateZip } from "./staging";
import type {
  UpdateProvider,
  UpdateProviderListener,
} from "./provider";

const require = createRequire(import.meta.url);

const autoUpdater = (): AppUpdater => {
  const mod = require("electron-updater") as { autoUpdater: AppUpdater };
  return mod.autoUpdater;
};

const toRelease = (info: {
  readonly version: string;
  readonly releaseDate?: string;
  readonly releaseName?: string | null;
  readonly releaseNotes?: string | Array<unknown> | null;
}): AvailableRelease => {
  const notes =
    typeof info.releaseNotes === "string"
      ? info.releaseNotes
      : Array.isArray(info.releaseNotes)
        ? info.releaseNotes
            .map((entry) =>
              typeof entry === "string"
                ? entry
                : entry !== null &&
                    typeof entry === "object" &&
                    "note" in entry &&
                    typeof (entry as { note: unknown }).note === "string"
                  ? (entry as { note: string }).note
                  : "",
            )
            .filter(Boolean)
            .join("\n")
        : undefined;
  return {
    version: info.version,
    ...(info.releaseDate === undefined ? {} : { releaseDate: info.releaseDate }),
    ...(info.releaseName === undefined || info.releaseName === null
      ? {}
      : { releaseName: info.releaseName }),
    ...(notes === undefined || notes.length === 0 ? {} : { releaseNotes: notes }),
  };
};

/**
 * Mac Command Center adapter: electron-updater owns feed / download / cache /
 * quitAndInstall. Vellum Command never redirects the feed at runtime.
 */
export const makeMacUpdateProvider = (options: {
  readonly isPackaged: boolean;
}): UpdateProvider => {
  let listener: UpdateProviderListener | undefined;
  let started = false;

  const emit: UpdateProviderListener = (event) => {
    listener?.(event);
  };

  return {
    kind: "mac",
    start: (next) => {
      listener = next;
      if (started) return;
      started = true;

      const updater = autoUpdater();
      updater.autoDownload = true;
      updater.autoInstallOnAppQuit = false;
      updater.allowDowngrade = false;
      // Disable electron-updater's own full-changelog logger noise in production.
      updater.logger = null;

      if (options.isPackaged) {
        const feed = macArm64UpdateFeed();
        updater.setFeedURL({
          provider: feed.provider,
          url: feed.url,
        });
      }

      updater.on("checking-for-update", () => {
        emit({ _tag: "checking" });
      });
      updater.on("update-available", (info) => {
        emit({ _tag: "available", release: toRelease(info) });
      });
      updater.on("update-not-available", () => {
        emit({ _tag: "not-available" });
      });
      updater.on("download-progress", (progress) => {
        emit({
          _tag: "progress",
          progress: {
            percent: Math.min(100, Math.max(0, progress.percent)),
            bytesPerSecond: Math.max(0, progress.bytesPerSecond),
            transferred: Math.max(0, progress.transferred),
            total: Math.max(0, progress.total),
          },
        });
      });
      updater.on("update-downloaded", (event) => {
        emit({
          _tag: "downloaded",
          release: toRelease(event),
          downloadedFile: event.downloadedFile,
        });
      });
      updater.on("error", (error) => {
        emit({
          _tag: "error",
          code: "check-failed",
          message: error instanceof Error ? error.message : String(error),
        });
      });
    },
    stop: () => {
      listener = undefined;
      // electron-updater has no public removeAllListeners for our events that
      // is safer than leaving dead handlers; start is one-shot per process.
    },
    check: async () => {
      if (!options.isPackaged) {
        emit({
          _tag: "error",
          code: "not-packaged",
          message: "updates are only available in packaged builds",
        });
        return;
      }
      await autoUpdater().checkForUpdates();
    },
    stageDownloaded: async (downloadedFile, release) => {
      const archiveSha256 = await readUpdateArchiveDigest(downloadedFile);
      const staged = await expandMacUpdateZip(downloadedFile, { expectedVersion: release.version });
      return Object.freeze({
        ...staged,
        revalidate: async () => {
          if (await readUpdateArchiveDigest(downloadedFile) !== archiveSha256) {
            throw updateError("candidate-mismatch", "downloaded update archive changed after admission");
          }
        },
      });
    },
    quitAndInstall: () => {
      // Explicit operator install only — never force-restart on ordinary quit.
      autoUpdater().quitAndInstall(false, true);
    },
  };
};
