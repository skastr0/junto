import { useEffect, useMemo } from "react";
import { type ArtifactLabel, artifactLabelsMatch } from "@shared/artifact-labels";
import type { ArtifactHead } from "@shared/resource-ipc";
import { nodeViewStore, useNodeView } from "./node-view-state";
import type { ArtifactsNodeView } from "./view-state";

/**
 * The Artifacts node as the operator left it (0.11, 04, V3): its type
 * filter, picked labels, archived toggle and open artifact, per node, kept in
 * view state so a quit brings them back. Search text is not kept.
 */
const OPEN: ArtifactsNodeView = { type: "all", archived: false, labels: [], open: null };

/** Picked labels some artifact in the node still matches; a level stays while a label under it does. */
export const labelsStillHeld = (
  labels: ReadonlyArray<ArtifactLabel>,
  entries: ReadonlyArray<ArtifactHead>,
): ReadonlyArray<ArtifactLabel> =>
  labels.filter((label) => entries.some(({ artifact }) => artifactLabelsMatch(artifact.labels, [label])));

/**
 * The node's kept view, and its setters. A picked label no artifact here
 * carries any more drops out while the node lists any artifact; an empty list
 * (not arrived yet, or a node with none) leaves the picks as kept, still
 * offered so they can be unpicked. Reads follow the canvas and node, so a
 * modal that stays mounted while either moves reads the new node's row.
 */
export const useArtifactsNodeView = (
  canvasName: string,
  nodeId: string,
  entries: ReadonlyArray<ArtifactHead>,
): ArtifactsNodeView & {
  readonly setType: (type: ArtifactsNodeView["type"]) => void;
  readonly setArchived: (archived: boolean) => void;
  readonly setLabels: (next: (labels: ReadonlyArray<ArtifactLabel>) => ReadonlyArray<ArtifactLabel>) => void;
  readonly setOpen: (open: string | null) => void;
} => {
  const kept = useNodeView((store) => store.artifacts(canvasName, nodeId)) ?? OPEN;
  const labels = useMemo(
    () => (entries.length === 0 ? kept.labels : labelsStillHeld(kept.labels, entries)),
    [entries, kept.labels],
  );
  useEffect(() => {
    if (labels.length !== kept.labels.length) nodeViewStore().writeArtifacts(canvasName, nodeId, { ...kept, labels });
  }, [canvasName, nodeId, kept, labels]);
  const update = (change: (last: ArtifactsNodeView) => ArtifactsNodeView): void => {
    const store = nodeViewStore();
    const last = store.artifacts(canvasName, nodeId) ?? OPEN;
    const next = change(last);
    if (next.type !== last.type || next.archived !== last.archived || next.open !== last.open || next.labels !== last.labels) {
      store.writeArtifacts(canvasName, nodeId, next);
    }
  };
  return {
    ...kept,
    labels,
    setType: (type) => update((last) => ({ ...last, type })),
    setArchived: (archived) => update((last) => ({ ...last, archived })),
    setLabels: (next) => update((last) => ({ ...last, labels: next(last.labels) })),
    setOpen: (open) => update((last) => ({ ...last, open })),
  };
};
