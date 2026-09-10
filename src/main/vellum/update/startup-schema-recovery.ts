/**
 * Startup recovery when the installed state schema is newer than this binary.
 *
 * Normal auto-update requires a healthy session (check → download → Restart).
 * If an older binary opens a DB already advanced by a newer build, StateEngine
 * refuses to open and the process exits — leaving the operator bricked even
 * when a feed update exists. This path runs *before* AppRuntime, never opens
 * the DB for write, and offers one-shot install-from-feed + quitAndInstall.
 */

import { app, dialog, shell, type App } from "electron";
import { Effect } from "effect";
import { linuxX64UpdateFeed, macArm64UpdateFeed } from "./compiled-config";
import { makePlatformUpdateProvider } from "./platform";
import type { StagedUpdate, UpdateHostHooks, UpdateProvider } from "./provider";
import { releaseStaging } from "./staging";
import type { SchemaCompatibility } from "../state/schema-version-probe";

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
  readonly checkForUpdates: () => Promise<{ readonly version?: string } | null>;
  readonly quitAndInstall: () => void | Promise<void>;
  readonly dispose?: () => void;
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

/**
 * The recovery process has no AppRuntime or database connection to quiesce.
 * It uses the normal provider's signed staging and activation transaction.
 */
export const makeSchemaRecoveryUpdater = (
  provider: UpdateProvider,
  host: UpdateHostHooks,
  timeoutMs = 10 * 60_000,
): SchemaRecoveryUpdater => {
  let staged: StagedUpdate | undefined;
  let started = false;
  let disposed = false;
  let cancelPending: (() => void) | undefined;

  const releaseProof = (candidate: StagedUpdate | undefined): void => {
    Effect.runSync(releaseStaging(candidate?.stagingRoot));
  };

  return {
    checkForUpdates: () => {
      if (started || disposed) {
        return Promise.reject(new Error("schema recovery update check is one-shot"));
      }
      started = true;
      return new Promise((resolve, reject) => {
        let settled = false;
        let staging = false;
        let timer: ReturnType<typeof setTimeout> | undefined;
        const cleanup = () => {
          if (timer !== undefined) clearTimeout(timer);
          cancelPending = undefined;
          provider.stop();
        };
        const finish = (value: { readonly version: string } | null) => {
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
        cancelPending = () => fail(new Error("schema recovery update was cancelled"));
        timer = setTimeout(
          () => fail(new Error("update check timed out while recovering from schema mismatch")),
          timeoutMs,
        );
        try {
          provider.start((event) => {
            if (settled) return;
            if (event._tag === "error") {
              fail(new Error(event.message));
            } else if (event._tag === "not-available") {
              finish(null);
            } else if (event._tag === "downloaded" && !staging) {
              staging = true;
              const stage = provider.stageDownloaded;
              if (stage === undefined) {
                fail(new Error("this platform cannot verify a downloaded update"));
                return;
              }
              void stage(event.downloadedFile, event.release).then((candidate) => {
                if (settled || disposed) {
                  releaseProof(candidate);
                  return;
                }
                staged = candidate;
                finish({ version: event.release.version });
              }, fail);
            }
          });
          void provider.check().catch(fail);
        } catch (error) {
          fail(error);
        }
      });
    },
    quitAndInstall: async () => {
      if (disposed || staged === undefined) {
        throw new Error("no verified update is ready for schema recovery");
      }
      await staged.revalidate?.();
      if (staged.installAfterQuiesce !== undefined) {
        await staged.installAfterQuiesce(host);
      } else {
        releaseProof(staged);
        provider.quitAndInstall();
      }
    },
    dispose: () => {
      disposed = true;
      cancelPending?.();
      provider.stop();
      releaseProof(staged);
      staged = undefined;
    },
  };
};

const recoveryHost = (
  owner: Pick<App, "relaunch" | "exit">,
): UpdateHostHooks => ({
  // The schema probe ran read-only before any product runtime was started.
  quiesceForInstall: async () => {},
  relaunchWithoutInstall: () => {
    owner.relaunch();
    owner.exit(0);
  },
  relaunchInstalled: (executablePath) => {
    owner.relaunch({ execPath: executablePath, args: [] });
    owner.exit(0);
  },
});

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

/** Operator-facing copy only — no schema versions, binaries, or feed jargon. */
const SCHEMA_TOO_NEW_TITLE = "Update required";
const SCHEMA_TOO_NEW_MESSAGE = "A newer version of Vellum Command is required";
const SCHEMA_TOO_NEW_DETAIL = [
  "Your data was last saved by a newer version of Vellum Command.",
  "This version cannot open it.",
  "",
  "Update to the latest Vellum Command, then open the app again.",
].join("\n");

const diagnosticDetail = (
  compatibility: Extract<SchemaCompatibility, { readonly ok: false }>,
  appVersion: string,
): string =>
  [
    `schema user_version=${compatibility.userVersion}`,
    `supported=${compatibility.supportedVersion}`,
    `appVersion=${appVersion}`,
    `path=${compatibility.path}`,
  ].join(" ");

export const runStartupSchemaRecovery = async (input: {
  readonly compatibility: Extract<
    SchemaCompatibility,
    { readonly ok: false }
  >;
  readonly appVersion: string;
  readonly isPackaged: boolean;
  readonly headless: boolean;
  readonly platform?: NodeJS.Platform;
  /** Download-page seam for tests; installed providers use only compiled feeds. */
  readonly feedUrl?: string;
  readonly host?: UpdateHostHooks;
  readonly dialog?: SchemaRecoveryDialog;
  readonly updater?: SchemaRecoveryUpdater;
  readonly openExternal?: (url: string) => Promise<void>;
}): Promise<SchemaRecoveryOutcome> => {
  const {
    compatibility,
    appVersion,
    isPackaged,
    headless,
  } = input;

  const diagnostic = diagnosticDetail(compatibility, appVersion);
  const platform = input.platform ?? process.platform;

  if (headless) {
    console.error(`[startup] schema too new for this app (${diagnostic})`);
    return { action: "quit", reason: "schema-newer-than-supported-headless" };
  }

  const ui = input.dialog ?? defaultDialog();

  // Development and unsupported platforms cannot install an official update.
  if (!isPackaged || (platform !== "darwin" && platform !== "linux")) {
    console.error(`[startup] schema too new for this app (${diagnostic})`);
    await ui.showMessageBox({
      type: "error",
      buttons: ["Quit"],
      defaultId: 0,
      cancelId: 0,
      title: SCHEMA_TOO_NEW_TITLE,
      message: SCHEMA_TOO_NEW_MESSAGE,
      detail: SCHEMA_TOO_NEW_DETAIL,
    });
    return {
      action: "quit",
      reason: isPackaged
        ? "schema-newer-than-supported-platform"
        : "schema-newer-than-supported-dev",
    };
  }

  const choice = await ui.showMessageBox({
    type: "error",
    buttons: ["Update now", "Download latest", "Quit"],
    defaultId: 0,
    cancelId: 2,
    title: SCHEMA_TOO_NEW_TITLE,
    message: SCHEMA_TOO_NEW_MESSAGE,
    detail: SCHEMA_TOO_NEW_DETAIL,
  });

  if (choice.response === 2) {
    return { action: "quit", reason: "operator-quit" };
  }

  const feed = input.feedUrl ?? (platform === "linux"
    ? linuxX64UpdateFeed().url
    : macArm64UpdateFeed().url);

  if (choice.response === 1) {
    const open = input.openExternal ?? ((url: string) => shell.openExternal(url));
    try {
      await open(feed.replace(/\/(?:mac\/arm64|linux\/x64)\/?$/u, "/"));
    } catch {
      await open(feed);
    }
    return { action: "quit", reason: "opened-download-page" };
  }

  // Update now — download from feed and restart into the newer app.
  let updater = input.updater;
  try {
    updater ??= makeSchemaRecoveryUpdater(
      makePlatformUpdateProvider({ platform, isPackaged, currentVersion: appVersion }),
      input.host ?? recoveryHost(app),
    );
    const downloaded = await updater.checkForUpdates();
    if (!feedVersionUnbricks(appVersion, downloaded?.version)) {
      console.error(
        `[startup] no newer update on feed (${diagnostic} feed=${downloaded?.version ?? "none"})`,
      );
      await ui.showMessageBox({
        type: "error",
        buttons: ["Quit"],
        defaultId: 0,
        cancelId: 0,
        title: "Could not update",
        message: "No newer version is available yet",
        detail: [
          "Your data still needs a newer Vellum Command.",
          "Download the latest release from the website, then open that version.",
        ].join("\n"),
      });
      return { action: "quit", reason: "feed-has-no-newer-version" };
    }
    await updater.quitAndInstall();
    return {
      action: "installing",
      targetVersion: downloaded?.version,
    };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    console.error(`[startup] schema recovery update failed: ${message}`);
    await ui.showMessageBox({
      type: "error",
      buttons: ["Quit"],
      defaultId: 0,
      cancelId: 0,
      title: "Could not update",
      message: "The update could not be installed",
      detail:
        "Check your network connection and try again, or download the latest Vellum Command from the website.",
    });
    return { action: "quit", reason: `update-failed:${message}` };
  } finally {
    updater?.dispose?.();
  }
};

/** Convenience for main: probe + recover when needed. */
export const ensureSchemaCompatibleOrRecover = async (input: {
  readonly app: Pick<App, "getVersion" | "isPackaged" | "relaunch" | "exit">;
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
    host: recoveryHost(input.app),
    ...(input.dialog === undefined ? {} : { dialog: input.dialog }),
    ...(input.updater === undefined ? {} : { updater: input.updater }),
  });
};
