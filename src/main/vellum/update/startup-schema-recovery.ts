/**
 * Startup recovery when the installed state schema is newer than this binary.
 *
 * Normal auto-update requires a healthy session (check → download → Restart).
 * If an older binary opens a DB already advanced by a newer build, StateEngine
 * refuses to open and the process exits — leaving the operator bricked even
 * when a feed update exists. This path runs *before* AppRuntime, never opens
 * the DB for write, and offers one-shot install-from-feed + quitAndInstall.
 */

import { createRequire } from "node:module";
import { dialog, shell, type App } from "electron";
import type { AppUpdater } from "electron-updater";
import { macArm64UpdateFeed } from "./compiled-config";
import type { SchemaCompatibility } from "../state/schema-version-probe";

const require = createRequire(import.meta.url);

const loadAutoUpdater = (): AppUpdater => {
  const mod = require("electron-updater") as { autoUpdater: AppUpdater };
  return mod.autoUpdater;
};

export type SchemaRecoveryOutcome =
  | { readonly action: "continue" }
  | { readonly action: "quit"; readonly reason: string }
  | { readonly action: "installing"; readonly targetVersion?: string };

export type SchemaRecoveryDialog = {
  readonly showMessageBox: (options: {
    readonly type: "error";
    readonly buttons: readonly string[];
    readonly defaultId: number;
    readonly cancelId: number;
    readonly title: string;
    readonly message: string;
    readonly detail: string;
  }) => Promise<{ readonly response: number }>;
};

export type SchemaRecoveryUpdater = {
  readonly configureFeed: (url: string) => void;
  readonly checkForUpdates: () => Promise<{ readonly version?: string } | null>;
  readonly quitAndInstall: () => void;
};

const defaultDialog = (): SchemaRecoveryDialog => ({
  showMessageBox: async (options) => {
    const result = await dialog.showMessageBox({
      type: options.type,
      buttons: [...options.buttons],
      defaultId: options.defaultId,
      cancelId: options.cancelId,
      title: options.title,
      message: options.message,
      detail: options.detail,
      noLink: true,
    });
    return { response: result.response };
  },
});

const defaultUpdater = (): SchemaRecoveryUpdater => {
  const updater = loadAutoUpdater();
  return {
    configureFeed: (url) => {
      updater.autoDownload = true;
      // Recovery is an explicit operator choice to leave this broken binary.
      updater.autoInstallOnAppQuit = true;
      updater.allowDowngrade = false;
      updater.logger = null;
      updater.setFeedURL({ provider: "generic", url });
    },
    checkForUpdates: () =>
      new Promise((resolve, reject) => {
        let settled = false;
        const finish = (value: { readonly version?: string } | null) => {
          if (settled) return;
          settled = true;
          cleanup();
          resolve(value);
        };
        const fail = (error: unknown) => {
          if (settled) return;
          settled = true;
          cleanup();
          reject(error instanceof Error ? error : new Error(String(error)));
        };
        const onAvailable = (info: { readonly version: string }) => {
          // Keep waiting for download; surface version for the dialog path.
          availableVersion = info.version;
        };
        const onDownloaded = (event: { readonly version: string }) => {
          finish({ version: event.version });
        };
        const onNotAvailable = () => {
          finish(null);
        };
        const onError = (error: Error) => {
          fail(error);
        };
        let availableVersion: string | undefined;
        const cleanup = () => {
          updater.off("update-available", onAvailable);
          updater.off("update-downloaded", onDownloaded);
          updater.off("update-not-available", onNotAvailable);
          updater.off("error", onError);
        };
        updater.on("update-available", onAvailable);
        updater.on("update-downloaded", onDownloaded);
        updater.on("update-not-available", onNotAvailable);
        updater.on("error", onError);
        void updater.checkForUpdates().catch(fail);
        // Safety: do not hang forever if the feed never answers.
        setTimeout(() => {
          if (!settled) {
            fail(new Error("update check timed out while recovering from schema mismatch"));
          }
        }, 10 * 60_000);
      }),
    quitAndInstall: () => {
      updater.quitAndInstall(false, true);
    },
  };
};

const compareSemver = (left: string, right: string): number => {
  const parts = (value: string): readonly number[] => {
    const match = /^(\d+)\.(\d+)\.(\d+)/u.exec(value.trim());
    if (match === null) return [0, 0, 0];
    return [Number(match[1]), Number(match[2]), Number(match[3])];
  };
  const a = parts(left);
  const b = parts(right);
  for (let i = 0; i < 3; i++) {
    const d = (a[i] ?? 0) - (b[i] ?? 0);
    if (d !== 0) return d < 0 ? -1 : 1;
  }
  return 0;
};

/**
 * Pure decision helper for tests: whether a feed version can unbrick this binary.
 */
export const feedVersionUnbricks = (
  currentVersion: string,
  feedVersion: string | undefined,
): boolean => {
  if (feedVersion === undefined || feedVersion.length === 0) return false;
  return compareSemver(feedVersion, currentVersion) > 0;
};

export const runStartupSchemaRecovery = async (input: {
  readonly compatibility: Extract<
    SchemaCompatibility,
    { readonly ok: false }
  >;
  readonly appVersion: string;
  readonly isPackaged: boolean;
  readonly headless: boolean;
  readonly feedUrl?: string;
  readonly dialog?: SchemaRecoveryDialog;
  readonly updater?: SchemaRecoveryUpdater;
  readonly openExternal?: (url: string) => Promise<void>;
  /** Injected for tests — production uses electron app.getVersion via caller. */
}): Promise<SchemaRecoveryOutcome> => {
  const {
    compatibility,
    appVersion,
    isPackaged,
    headless,
  } = input;

  const detail = [
    `Installed data schema: v${compatibility.userVersion}`,
    `This app build supports up to: v${compatibility.supportedVersion}`,
    `Running version: ${appVersion}`,
    "",
    "A newer Vellum already advanced your local database. This older binary cannot open it,",
    "and normal auto-update never gets a chance to finish while startup crashes.",
    "",
    "Install the latest release from the update feed, then reopen Vellum.",
  ].join("\n");

  if (headless) {
    console.error(`[startup] schema too new for this binary\n${detail}`);
    return { action: "quit", reason: "schema-newer-than-supported-headless" };
  }

  if (!isPackaged) {
    console.error(`[startup] schema too new for this binary (dev)\n${detail}`);
    const ui = input.dialog ?? defaultDialog();
    await ui.showMessageBox({
      type: "error",
      buttons: ["Quit"],
      defaultId: 0,
      cancelId: 0,
      title: "Vellum cannot open",
      message: "Local data was written by a newer Vellum",
      detail:
        detail +
        "\n\nDevelopment builds cannot self-update. Install/run a packaged build that matches the database.",
    });
    return { action: "quit", reason: "schema-newer-than-supported-dev" };
  }

  const ui = input.dialog ?? defaultDialog();
  const choice = await ui.showMessageBox({
    type: "error",
    buttons: ["Install update and restart", "Open download page", "Quit"],
    defaultId: 0,
    cancelId: 2,
    title: "Vellum update required",
    message: "This install is too old for your data",
    detail,
  });

  if (choice.response === 2) {
    return { action: "quit", reason: "operator-quit" };
  }

  const feed = input.feedUrl ?? macArm64UpdateFeed().url;

  if (choice.response === 1) {
    const open = input.openExternal ?? ((url: string) => shell.openExternal(url));
    try {
      await open(feed.replace(/\/mac\/arm64\/?$/u, "/"));
    } catch {
      await open(feed);
    }
    return { action: "quit", reason: "opened-download-page" };
  }

  // Install update and restart
  const updater = input.updater ?? defaultUpdater();
  try {
    updater.configureFeed(feed);
    const downloaded = await updater.checkForUpdates();
    if (!feedVersionUnbricks(appVersion, downloaded?.version)) {
      await ui.showMessageBox({
        type: "error",
        buttons: ["Quit"],
        defaultId: 0,
        cancelId: 0,
        title: "No newer update on the feed",
        message: "The update feed has nothing newer than this build",
        detail: [
          `Running: ${appVersion}`,
          `Feed reported: ${downloaded?.version ?? "(none)"}`,
          "",
          "Your database still needs a newer app. Reinstall from the latest",
          "notarized build, or publish a higher version to the feed.",
        ].join("\n"),
      });
      return { action: "quit", reason: "feed-has-no-newer-version" };
    }
    updater.quitAndInstall();
    return {
      action: "installing",
      targetVersion: downloaded?.version,
    };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    await ui.showMessageBox({
      type: "error",
      buttons: ["Quit"],
      defaultId: 0,
      cancelId: 0,
      title: "Update install failed",
      message: "Could not download or install the update",
      detail: message,
    });
    return { action: "quit", reason: `update-failed:${message}` };
  }
};

/** Convenience for main: probe + recover when needed. */
export const ensureSchemaCompatibleOrRecover = async (input: {
  readonly app: Pick<App, "getVersion" | "isPackaged">;
  readonly headless: boolean;
  readonly compatibility: SchemaCompatibility;
  readonly dialog?: SchemaRecoveryDialog;
  readonly updater?: SchemaRecoveryUpdater;
}): Promise<SchemaRecoveryOutcome> => {
  if (input.compatibility.ok) return { action: "continue" };
  return runStartupSchemaRecovery({
    compatibility: input.compatibility,
    appVersion: input.app.getVersion(),
    isPackaged: input.app.isPackaged,
    headless: input.headless,
    ...(input.dialog === undefined ? {} : { dialog: input.dialog }),
    ...(input.updater === undefined ? {} : { updater: input.updater }),
  });
};
