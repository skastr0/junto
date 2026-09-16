import type { AvailableRelease, UpdateDownloadProgress, UpdateErrorCode } from "@shared/update";

/**
 * Plastic boundary over electron-updater (or a platform stub).
 * The UpdateService coordinator never imports electron-updater directly.
 */
export type UpdateProviderEvent =
  | { readonly _tag: "checking" }
  | {
      readonly _tag: "available";
      readonly release: AvailableRelease;
    }
  | { readonly _tag: "not-available" }
  | {
      readonly _tag: "progress";
      readonly progress: UpdateDownloadProgress;
    }
  | {
      readonly _tag: "downloaded";
      readonly release: AvailableRelease;
      readonly downloadedFile: string;
    }
  | {
      readonly _tag: "error";
      readonly message: string;
      readonly code?: UpdateErrorCode;
    };

export type UpdateProviderListener = (event: UpdateProviderEvent) => void;

/** Main-owned admission; no paths or installation callbacks enter renderer IPC. */
export interface StagedUpdate {
  readonly executablePath: string;
  /** Disposable proof only. Installed Linux generations never use this field. */
  readonly stagingRoot?: string;
  readonly revalidate?: () => Promise<void>;
  readonly installAfterQuiesce?: (host: UpdateHostHooks) => Promise<void>;
  /** Once activation starts, recovery must never launch the older executable. */
  readonly hasActivated?: () => boolean;
}

export interface UpdateProvider {
  readonly kind: "mac" | "linux" | "unsupported";
  readonly start: (listener: UpdateProviderListener) => void;
  readonly stop: () => void;
  readonly check: () => Promise<void>;
  readonly stageDownloaded?: (downloadedFile: string, release: AvailableRelease) => Promise<StagedUpdate>;
  readonly quitAndInstall: () => void;
}

export type UpdateHostHooks = {
  /**
   * Release the incumbent's SQLite connection and product planes before
   * quitAndInstall. Must not reopen product planes; install or relaunch follows.
   */
  readonly quiesceForInstall: () => Promise<void>;
  /** Relaunch without installing when finalize fails after quiesce. */
  readonly relaunchWithoutInstall: () => void;
  /** Native Electron handoff to the exact admitted generation, with clean args. */
  readonly relaunchInstalled?: (executablePath: string) => void;
};
