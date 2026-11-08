import { useMemo } from "react";
import { use$ } from "@legendapp/state/react";
import type { ArtifactHead } from "@shared/resource-ipc";
import type { NodeId } from "@shared/physics/schema";
import { useNodesArtifacts } from "./artifacts-source";
import { modelStore } from "./use-model";

const NONE: ReadonlyArray<ArtifactHead> = [];

/**
 * Every artifact head on a canvas, from the per-node reads every caller
 * shares (artifacts-source.ts, shared-read.ts). Quick capture's list, its
 * Move to column, the capture editor, the mention pickers and the Artifacts
 * cards used to read on their own, and again on every artifact change: on the
 * operator's factory canvas that is 29 nodes and 4.6 MB of bodies, several
 * times over per Cmd+T and per save. Now each node is read once per change
 * for all of them, and the last read is kept between opens, so a surface that
 * comes back draws its rows on its first frame and re-reads behind them.
 */
export type CanvasArtifactHeads = {
  /** The newest heads read for this canvas's Artifacts nodes; may predate a change not yet re-read. */
  readonly heads: ReadonlyArray<ArtifactHead>;
  /**
   * The heads are ones this caller may act on: read since it mounted, or read
   * with no change since. A kept read from an earlier open is shown, never
   * trusted, until its re-read lands.
   */
  readonly confirmed: boolean;
};

/** The canvas's Artifacts node ids, joined: it changes only when that set does, not on every node edit. */
const useArtifactNodesKey = (canvasName: string): string =>
  use$(() => {
    if (canvasName === "") return "";
    modelStore.canvas$(canvasName).nodes.get();
    const ids: string[] = [];
    for (const node of modelStore.canvasOf(canvasName).nodes.values()) if (node.kind === "artifacts") ids.push(node.id);
    return ids.join(",");
  });

/** The artifact heads of every Artifacts node on the canvas, shared, kept between opens. */
export const useCanvasArtifactHeads = (canvasName: string): CanvasArtifactHeads => {
  const key = useArtifactNodesKey(canvasName);
  const nodeIds = useMemo(() => (key === "" ? [] : (key.split(",") as NodeId[])), [key]);
  const values = useNodesArtifacts(canvasName, canvasName === "" ? [] : nodeIds);
  return useMemo(() => {
    // Whole or nothing: rows never fill in node by node on a first open.
    if (values.some((one) => one.value === undefined)) return { heads: NONE, confirmed: false };
    return { heads: values.flatMap((one) => one.value ?? NONE), confirmed: values.every((one) => one.confirmed) };
  }, [values]);
};

/**
 * The artifacts of every Artifacts node on the canvas, once this caller may
 * act on them: empty until then, as a fresh read always was.
 */
export const useCanvasArtifacts = (canvasName: string): ReadonlyArray<ArtifactHead> => {
  const { heads, confirmed } = useCanvasArtifactHeads(canvasName);
  return confirmed ? heads : NONE;
};
