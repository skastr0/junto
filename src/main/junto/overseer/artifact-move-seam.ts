import type { ArtifactMoveRun } from "@shared/artifact-move";
import { coreArtifactMove } from "../../core-process/ops/ipc-resources";

/**
 * The seam to the operator's artifact move (docs/plans/0.11/10 M1), which
 * runs where the store is, in the core: `ipc.resource.move` for the window,
 * `coreArtifactMove` for the overseer that is already in this process.
 *
 * The overseer's `artifact.move` does what the window's "Move to…" does,
 * through the same entry point: the core rules the move, writes the history
 * entry and builds each row. Nothing on this side looks an artifact up,
 * judges a node, or retries.
 */
export const overseerArtifactMove: ArtifactMoveRun | undefined = coreArtifactMove;
