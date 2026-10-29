/**
 * Moving artifacts to another Artifacts node (docs/plans/0.11/10-artifact-move.md).
 *
 * A move changes the artifact's node and nothing else: its id, versions,
 * history, comments, labels, tasks and every link to it and from it stay.
 * History gets one entry naming the two nodes and who moved it.
 *
 * This module is the contract the window, the overseer CLI and main share:
 * the shapes of the one operation and the sentence for each refusal. Pure, no
 * Node imports (renderer and CLI safe). Main runs it (`runArtifactMove`,
 * src/main/junto/work/artifact-move.ts).
 */
import type { NodeId } from "./physics/schema";
import type { ResourceActor } from "./resource-command";
import type { ItemId, OpId } from "./work-ids";

/** Most artifacts one call may name. */
export const ARTIFACT_MOVE_MAX = 100;

export type ArtifactMoveRunInput = {
  readonly canvasName: string;
  /** One to `ARTIFACT_MOVE_MAX`, distinct. Rows come back in this order. */
  readonly artifactIds: ReadonlyArray<ItemId>;
  /** The Artifacts node they move to. */
  readonly toNode: NodeId;
};

/**
 * Why an artifact was not moved. A code to count by; the row's `reason` is
 * the sentence to show.
 *
 *   not-found  no artifact with that id on that canvas
 *   failed     the move was not ruled or not stored
 */
export const ARTIFACT_MOVE_REFUSAL_CODES = ["not-found", "failed"] as const;
export type ArtifactMoveRefusalCode = (typeof ARTIFACT_MOVE_REFUSAL_CODES)[number];

export type ArtifactMoveRunRow =
  | {
      readonly artifactId: ItemId;
      readonly title: string;
      readonly ok: true;
      /**
       * `unchanged`: it was already on `toNode`, so a retried move is no
       * refusal. `queued`: another machine edits this canvas and has not
       * ruled the move yet; `junto op show` reads what became of it.
       */
      readonly outcome: "moved" | "unchanged" | "queued";
      readonly from: NodeId;
      readonly to: NodeId;
      /** The move command's id, on a `queued` row: what `junto op show` takes. */
      readonly opId?: OpId;
    }
  | {
      readonly artifactId: ItemId;
      readonly title?: string;
      readonly ok: false;
      readonly code: ArtifactMoveRefusalCode;
      /** A full sentence for the operator, shown as is. */
      readonly reason: string;
    };

export type ArtifactMoveRunResult = {
  readonly results: ReadonlyArray<ArtifactMoveRunRow>;
  readonly moved: number;
  readonly refused: number;
};

/**
 * What a run answers. A target that is not an Artifacts node on the canvas
 * fails the whole call, not each row: nothing is moved.
 */
export type ArtifactMoveRunAnswer =
  | ({ readonly ok: true } & ArtifactMoveRunResult)
  | { readonly ok: false; readonly code: "not_found" | "invalid_input"; readonly message: string };

/** The one entry point every surface calls; `by` is who moved them, for history. */
export type ArtifactMoveRun = (input: ArtifactMoveRunInput, by: ResourceActor) => Promise<ArtifactMoveRunAnswer>;

/** The sentence for each refusal. One place, so every surface says the same. */
export const ARTIFACT_MOVE_REFUSAL_REASON: Readonly<Record<ArtifactMoveRefusalCode, string>> = {
  "not-found": "Junto could not find that artifact on this canvas.",
  failed: "The artifact could not be moved. Nothing about it changed.",
};

/** Count the rows of a run. `unchanged` and `queued` count as neither moved nor refused. */
export const summarizeArtifactMoveRun = (results: ReadonlyArray<ArtifactMoveRunRow>): ArtifactMoveRunResult => ({
  results,
  moved: results.filter((row) => row.ok && row.outcome === "moved").length,
  refused: results.filter((row) => !row.ok).length,
});
