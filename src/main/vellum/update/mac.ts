import { autoUpdater } from "electron-updater";
import type { AvailableRelease } from "@shared/update";
import { macArm64UpdateFeed } from "./compiled-config";
import type {
  UpdateProvider,
  UpdateProviderListener,
} from "./provider";

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
 * quitAndInstall. Vellum never redirects the feed at runtime.
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

      autoUpdater.autoDownload = true;
      autoUpdater.autoInstallOnAppQuit = false;
      autoUpdater.allowDowngrade = false;
      // Disable electron-updater's own full-changelog logger noise in production.
      autoUpdater.logger = null;

      if (options.isPackaged) {
        const feed = macArm64UpdateFeed();
        autoUpdater.setFeedURL({
          provider: feed.provider,
          url: feed.url,
        });
      }

      autoUpdater.on("checking-for-update", () => {
        emit({ _tag: "checking" });
      });
      autoUpdater.on("update-available", (info) => {
        emit({ _tag: "available", release: toRelease(info) });
      });
      autoUpdater.on("update-not-available", () => {
        emit({ _tag: "not-available" });
      });
      autoUpdater.on("download-progress", (progress) => {
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
      autoUpdater.on("update-downloaded", (event) => {
        emit({
          _tag: "downloaded",
          release: toRelease(event),
          downloadedFile: event.downloadedFile,
        });
      });
      autoUpdater.on("error", (error) => {
        emit({
          _tag: "error",
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
          message: "updates are only available in packaged builds",
        });
        return;
      }
      await autoUpdater.checkForUpdates();
    },
    quitAndInstall: () => {
      // Explicit operator install only — never force-restart on ordinary quit.
      autoUpdater.quitAndInstall(false, true);
    },
  };
};
