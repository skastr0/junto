import { makeLinuxUpdateProvider, makeUnsupportedUpdateProvider } from "./linux";
import { makeMacUpdateProvider } from "./mac";
import type { UpdateProvider } from "./provider";

export const makePlatformUpdateProvider = (options: {
  readonly platform: NodeJS.Platform;
  readonly isPackaged: boolean;
  readonly currentVersion: string;
}): UpdateProvider => {
  switch (options.platform) {
    case "darwin":
      return makeMacUpdateProvider({ isPackaged: options.isPackaged });
    case "linux":
      return makeLinuxUpdateProvider({ isPackaged: options.isPackaged, currentVersion: options.currentVersion });
    default:
      return makeUnsupportedUpdateProvider(options.platform);
  }
};
