import type { ArtifactMoveRun } from "@shared/artifact-move";

/**
 * The seam to the operator's artifact move in main (docs/plans/0.11/10 M1).
 *
 * The overseer's `artifact.move` does what the window's "Move to…" does,
 * through the same entry point: main rules the move, writes the history
 * entry and builds each row. Nothing on this side looks an artifact up,
 * judges a node, or retries.
 *
 * Undefined until `runArtifactMove` (src/main/junto/work/artifact-move.ts)
 * lands with the runtime; until then the operation is refused Unsupported.
 */
export const overseerArtifactMove: ArtifactMoveRun | undefined = undefined;
