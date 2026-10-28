import { useEffect, useMemo, useState } from "react";
import { type ArtifactLabel, artifactLabelsMatch } from "@shared/artifact-labels";
import type { ArtifactHead } from "@shared/resource-ipc";
import type { TypeFilter } from "../components/artifacts/artifacts-pane-model";

/**
 * The Artifacts node's sidebar filter as the operator left it (0.11, 03): its
 * type and its picked labels, per node for the life of the window, so a
 * close and a reopen show them pressed and two nodes keep their own. Held in
 * memory only, like the sidebar sections: a fresh window opens every node
 * unfiltered.
 */
export interface KeptArtifactsFilter {
  readonly type: TypeFilter;
  readonly labels: ReadonlyArray<ArtifactLabel>;
}

const OPEN: KeptArtifactsFilter = { type: "all", labels: [] };
const kept = new Map<string, KeptArtifactsFilter>();
const keyOf = (canvasName: string, nodeId: string): string => `${canvasName}\n${nodeId}`;

export const keptArtifactsFilter = (canvasName: string, nodeId: string): KeptArtifactsFilter =>
  kept.get(keyOf(canvasName, nodeId)) ?? OPEN;

/** Picked labels some artifact in the node still matches; a level stays while a label under it does. */
export const labelsStillHeld = (
  labels: ReadonlyArray<ArtifactLabel>,
  entries: ReadonlyArray<ArtifactHead>,
): ReadonlyArray<ArtifactLabel> =>
  labels.filter((label) => entries.some(({ artifact }) => artifactLabelsMatch(artifact.labels, [label])));

/**
 * The node's kept filter, and its setters. A picked label no artifact here
 * carries any more drops out once the list has arrived; before it has, the
 * picks stand as kept.
 */
export const useKeptArtifactsFilter = (
  canvasName: string,
  nodeId: string,
  entries: ReadonlyArray<ArtifactHead>,
): KeptArtifactsFilter & {
  readonly setType: (type: TypeFilter) => void;
  readonly setLabels: (next: (labels: ReadonlyArray<ArtifactLabel>) => ReadonlyArray<ArtifactLabel>) => void;
} => {
  const key = keyOf(canvasName, nodeId);
  const [filter, setFilter] = useState(() => kept.get(key) ?? OPEN);
  const labels = useMemo(
    () => (entries.length === 0 ? filter.labels : labelsStillHeld(filter.labels, entries)),
    [entries, filter.labels],
  );
  useEffect(() => {
    kept.set(key, { type: filter.type, labels });
    if (labels.length !== filter.labels.length) setFilter((last) => ({ ...last, labels }));
  }, [key, filter.type, filter.labels.length, labels]);
  return {
    type: filter.type,
    labels,
    setType: (type) => setFilter((last) => ({ ...last, type })),
    setLabels: (next) => setFilter((last) => ({ ...last, labels: next(last.labels) })),
  };
};
