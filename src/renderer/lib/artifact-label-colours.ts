import { useCallback, useSyncExternalStore } from "react";
import { ARTIFACT_LABEL_COLOURS, type ArtifactLabel, type ArtifactLabelColour } from "@shared/artifact-labels";

export { ARTIFACT_LABEL_COLOURS, type ArtifactLabelColour };

/**
 * Label colours (0.11, 03 Colours, C2): a colour belongs to a label in its
 * Artifacts node, one of eight names or none, and the label's text always
 * stays beside it.
 *
 * The names and their order are C1's (`@shared/artifact-labels`). Stand-in
 * until the renderer's read and the node op cross IPC: the colours are held
 * here in memory per canvas and node. When they land, `useLabelColours` reads
 * and writes through them and this store goes; its callers do not change.
 */

/** Each colour in words, as the swatch menu and a screen reader say it. */
export const LABEL_COLOUR_NOUN: { readonly [C in ArtifactLabelColour]: string } = {
  red: "Red",
  orange: "Orange",
  yellow: "Yellow",
  green: "Green",
  teal: "Teal",
  blue: "Blue",
  purple: "Purple",
  pink: "Pink",
};

/** A label's colour said after its name: "draft, blue" or "draft, no colour". */
export const labelColourWords = (label: string, colour: ArtifactLabelColour | null): string =>
  `${label}, ${colour === null ? "no colour" : LABEL_COLOUR_NOUN[colour].toLowerCase()}`;

export type LabelColours = {
  readonly colourOf: (label: ArtifactLabel) => ArtifactLabelColour | null;
  readonly setColour: (label: ArtifactLabel, colour: ArtifactLabelColour | null) => void;
};

const held = new Map<string, ReadonlyMap<ArtifactLabel, ArtifactLabelColour>>();
const listeners = new Set<() => void>();
const EMPTY: ReadonlyMap<ArtifactLabel, ArtifactLabelColour> = new Map();
const keyOf = (canvasName: string, nodeId: string): string => `${canvasName}\n${nodeId}`;

const subscribe = (listener: () => void): (() => void) => {
  listeners.add(listener);
  return () => listeners.delete(listener);
};

/** Set or clear one label's colour in a node; every reader of that node redraws. */
export const setLabelColour = (canvasName: string, nodeId: string, label: ArtifactLabel, colour: ArtifactLabelColour | null): void => {
  const key = keyOf(canvasName, nodeId);
  const next = new Map(held.get(key) ?? EMPTY);
  if (colour === null) next.delete(label);
  else next.set(label, colour);
  held.set(key, next);
  for (const listener of listeners) listener();
};

/** The node's label colours, and the write that sets or clears one. */
export const useLabelColours = (canvasName: string, nodeId: string): LabelColours => {
  const key = keyOf(canvasName, nodeId);
  const colours = useSyncExternalStore(subscribe, () => held.get(key) ?? EMPTY);
  const colourOf = useCallback((label: ArtifactLabel) => colours.get(label) ?? null, [colours]);
  const setColour = useCallback(
    (label: ArtifactLabel, colour: ArtifactLabelColour | null) => setLabelColour(canvasName, nodeId, label, colour),
    [canvasName, nodeId],
  );
  return { colourOf, setColour };
};
