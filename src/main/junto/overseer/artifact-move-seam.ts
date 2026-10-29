import type { ArtifactMoveRun } from "@shared/artifact-move";
import { runArtifactMove } from "../work/artifact-move";

/**
 * The seam to the operator's artifact move in main (docs/plans/0.11/10 M1).
 *
 * The overseer's `artifact.move` does what the window's "Move to…" does,
 * through the same entry point: main rules the move, writes the history
 * entry and builds each row. Nothing on this side looks an artifact up,
 * judges a node, or retries.
 */
export const overseerArtifactMove: ArtifactMoveRun | undefined = runArtifactMove;
