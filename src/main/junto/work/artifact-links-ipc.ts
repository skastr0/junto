/**
 * The window's read of body backlinks (0.11, 02, L1). Decoded strictly, read
 * through the same function the CLI uses (`body-links.ts`), and said to every
 * window when an artifact write lands, so a pane reads again.
 */
import type { IpcMain } from "electron";
import { Effect, Schema } from "effect";
import { SqlClient } from "effect/unstable/sql";
import { ARTIFACT_LINKS_IPC_CHANNELS, ArtifactLinksInput, type ArtifactLinksChanged } from "@shared/artifact-links-ipc";
import type { Canvas } from "@shared/model";
import { asNodeId } from "@shared/model";
import type { WorkErrorBody } from "@shared/work-control";
import type { ItemId } from "@shared/work-ids";
import { linkedFromBodies } from "./body-links";
import { onResourceChanged } from "./resource-changes";

/** What the handler reads through: a canvas's topology. The store comes from the runtime. */
export type ArtifactLinksIpcPorts = {
  readonly topology: (canvasName: string) => Effect.Effect<Canvas, WorkErrorBody>;
};

/** Runs a handler in the app runtime, which holds the store. */
export type ArtifactLinksIpcRun = <A, E>(effect: Effect.Effect<A, E, SqlClient.SqlClient>) => Promise<A>;

/**
 * The channels, and the notice that a body link moved. Returns the
 * unsubscribe from the store's change notices.
 */
export const registerArtifactLinksIpc = (
  ipc: Pick<IpcMain, "handle">,
  run: ArtifactLinksIpcRun,
  ports: ArtifactLinksIpcPorts,
  broadcast: (channel: string, payload: ArtifactLinksChanged) => void,
): (() => void) => {
  ipc.handle(ARTIFACT_LINKS_IPC_CHANNELS.list, (_event, input: unknown) =>
    run(
      Schema.decodeUnknownEffect(ArtifactLinksInput)(input, { onExcessProperty: "error" }).pipe(
        Effect.flatMap((decoded) =>
          Effect.flatMap(ports.topology(decoded.canvasName), (canvas) =>
            Effect.flatMap(SqlClient.SqlClient, (sql) =>
              linkedFromBodies(sql, canvas, decoded.canvasName, {
                nodeId: asNodeId(decoded.nodeId),
                artifactId: decoded.artifactId as ItemId,
              }),
            ),
          ),
        ),
        Effect.mapError((error) => new Error("message" in error ? String(error.message) : String(error))),
      ),
    ),
  );
  // An artifact write is the only thing that adds or takes away a body link.
  return onResourceChanged((domain, canvasName) => {
    if (domain !== "artifact") return;
    broadcast(ARTIFACT_LINKS_IPC_CHANNELS.changed, { canvasName });
  });
};
