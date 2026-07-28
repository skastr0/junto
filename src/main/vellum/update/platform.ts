import { makeLinuxUpdateProvider, makeUnsupportedUpdateProvider } from "./linux";
import { makeMacUpdateProvider } from "./mac";
import type { UpdateProvider } from "./provider";

export const makePlatformUpdateProvider = (options: {
  readonly platform: NodeJS.Platform;
  readonly isPackaged: boolean;
}): UpdateProvider => {
  switch (options.platform) {
    case "darwin":
      return makeMacUpdateProvider({ isPackaged: options.isPackaged });
    case "linux":
      return makeLinuxUpdateProvider();
    default:
      return makeUnsupportedUpdateProvider(options.platform);
  }
};
