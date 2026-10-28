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
 * The node's kept filter, and its setters. The modal can stay mounted while
 * its node or canvas changes, so the filter held here carries the key it was
 * read under and is read again when the key moves; nothing is kept for a
 * canvas not yet named. A picked label no artifact here carries any more
 * drops out while the node lists any artifact; an empty list (not arrived
 * yet, or a node with none) leaves the picks as kept, still offered so they
 * can be unpicked.
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
  const [held, setHeld] = useState(() => ({ key, filter: kept.get(key) ?? OPEN }));
  const filter = held.key === key ? held.filter : (kept.get(key) ?? OPEN);
  const labels = useMemo(
    () => (entries.length === 0 ? filter.labels : labelsStillHeld(filter.labels, entries)),
    [entries, filter.labels],
  );
  const update = (change: (last: KeptArtifactsFilter) => KeptArtifactsFilter): void =>
    setHeld((last) => ({ key, filter: change(last.key === key ? last.filter : (kept.get(key) ?? OPEN)) }));
  useEffect(() => {
    if (held.key !== key) return;
    if (canvasName !== "") kept.set(key, { type: filter.type, labels });
    if (labels.length !== filter.labels.length) setHeld((last) => (last.key === key ? { key, filter: { ...last.filter, labels } } : last));
  }, [key, held.key, canvasName, filter.type, filter.labels.length, labels]);
  return {
    type: filter.type,
    labels,
    setType: (type) => update((last) => ({ ...last, type })),
    setLabels: (next) => update((last) => ({ ...last, labels: next(last.labels) })),
  };
};
