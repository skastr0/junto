import type { UpdateProvider, UpdateProviderListener } from "./provider";

/**
 * Linux Command Center self-update is out of scope for this branch.
 * Refuse with a clear status; fleet Linux uses the separate release installer.
 */
export const makeLinuxUpdateProvider = (): UpdateProvider => {
  let listener: UpdateProviderListener | undefined;
  return {
    kind: "linux",
    start: (next) => {
      listener = next;
    },
    stop: () => {
      listener = undefined;
    },
    check: async () => {
      listener?.({
        _tag: "error",
        message:
          "Linux Command Center self-update is not available; use the Linux release installer",
      });
    },
    quitAndInstall: () => {
      listener?.({
        _tag: "error",
        message: "Linux Command Center self-update is not available",
      });
    },
  };
};

export const makeUnsupportedUpdateProvider = (
  platform: string,
): UpdateProvider => {
  let listener: UpdateProviderListener | undefined;
  return {
    kind: "unsupported",
    start: (next) => {
      listener = next;
    },
    stop: () => {
      listener = undefined;
    },
    check: async () => {
      listener?.({
        _tag: "error",
        message: `auto-update is not supported on ${platform}`,
      });
    },
    quitAndInstall: () => {
      listener?.({
        _tag: "error",
        message: `auto-update is not supported on ${platform}`,
      });
    },
  };
};
