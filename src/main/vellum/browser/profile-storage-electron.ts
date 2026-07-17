import { app, session } from "electron";
import type { BrowserProfileStoragePlatform } from "./profile-storage";

/** Thin production seam. Cold recovery calls currentRoots only. */
export const makeElectronBrowserProfileStoragePlatform =
  (): BrowserProfileStoragePlatform =>
    Object.freeze({
      currentRoots: () =>
        Object.freeze({
          userDataPath: app.getPath("userData"),
          sessionDataPath: app.getPath("sessionData"),
        }),
      sessionForPartition: (partition: string) => session.fromPartition(partition),
    });
