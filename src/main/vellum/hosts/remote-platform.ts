import type { RemoteTargetPlatform } from "./remote-deployment";

/**
 * Linux Command Center may prepare a Linux Remote after uname.
 * Darwin Remote still needs a macOS Command Center (local .app).
 */
export const commandCenterMayPrepareRemote = (
  commandCenterPlatform: NodeJS.Platform,
  remotePlatform: RemoteTargetPlatform,
): boolean =>
  remotePlatform === "linux" || commandCenterPlatform === "darwin";
