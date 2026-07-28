import type { AvailableRelease, UpdateDownloadProgress } from "@shared/update";

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
    };

export type UpdateProviderListener = (event: UpdateProviderEvent) => void;

export interface UpdateProvider {
  readonly kind: "mac" | "linux" | "unsupported";
  readonly start: (listener: UpdateProviderListener) => void;
  readonly stop: () => void;
  readonly check: () => Promise<void>;
  readonly quitAndInstall: () => void;
}

export type UpdateHostHooks = {
  /**
   * Release the incumbent's SQLite connection before candidate preflight.
   * Must not reopen product planes; install or relaunch follows.
   */
  readonly quiesceForPreflight: () => Promise<void>;
  /** Relaunch without installing when preflight fails after quiesce. */
  readonly relaunchWithoutInstall: () => void;
};
