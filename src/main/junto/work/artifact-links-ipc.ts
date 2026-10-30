/**
 * The window's read of body backlinks (0.11, 02, L1). The read runs in the
 * core, through the same function the CLI uses (`ops/ipc-work.ts`,
 * `junto/work/body-links.ts`), and the core's artifact change tells every
 * window to read again (junto/ipc.ts).
 */
import type { IpcMain } from "electron";
import { ARTIFACT_LINKS_IPC_CHANNELS } from "@shared/artifact-links-ipc";
import { core } from "../../core-process/main-client";

export const registerArtifactLinksIpc = (ipc: Pick<IpcMain, "handle">): void => {
  ipc.handle(ARTIFACT_LINKS_IPC_CHANNELS.list, (_event, input: unknown) =>
    core.call("ipc.work.artifactLinks", { input }),
  );
};
