/**
 * The window's read of body backlinks (0.11, 02, L1). The read runs in the
 * core, through the same function the CLI uses (the work group,
 * `contract/core/work.ts`, and `core/work/body-links.ts`), and the core's
 * artifact change tells every window to read again (junto/ipc.ts). The
 * renderer's query is decoded here, closed; one that does not decode rejects.
 */
import type { IpcMain } from "electron";
import { Context, Effect, Schema } from "effect";
import { ARTIFACT_LINKS_IPC_CHANNELS, ArtifactLinksInput } from "@shared/artifact-links-ipc";
import { WorkCore } from "../../contract/core/work";
import { AppRuntime } from "../runtime";

export const registerArtifactLinksIpc = (ipc: Pick<IpcMain, "handle">, core: Context.Context<WorkCore>): void => {
  const work = Context.get(core, WorkCore);
  ipc.handle(ARTIFACT_LINKS_IPC_CHANNELS.list, (_event, raw: unknown) =>
    AppRuntime.runPromise(
      Effect.flatMap(Schema.decodeUnknownEffect(ArtifactLinksInput)(raw, { onExcessProperty: "error" }), (input) =>
        work.WorkArtifactLinks(input),
      ),
    ),
  );
};
