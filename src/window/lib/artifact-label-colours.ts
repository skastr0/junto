import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { ARTIFACT_LABEL_COLOURS, type ArtifactLabel, type ArtifactLabelColour, type ArtifactLabelColours } from "@shared/artifact-labels";
import type { NodeId } from "@shared/physics/schema";
import { mintOpId } from "@shared/resource-command";
import type { ResourceApplyOutcome } from "@shared/resource-ipc";
import { artifactsSource } from "./artifacts-source";

export { ARTIFACT_LABEL_COLOURS, type ArtifactLabelColour };

/**
 * Label colours (0.11, 03 Colours, C2): a colour belongs to a label in its
 * Artifacts node, one of eight names or none, and the label's text always
 * stays beside it.
 *
 * The names and their order are C1's (`@shared/artifact-labels`); the node's
 * colours are read from main and set by one `{ op: "labelColour" }` on the
 * node, ruled as every artifact op is.
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

const COLOURS: ReadonlySet<string> = new Set(ARTIFACT_LABEL_COLOURS);

/**
 * The read as a map of own keys only. It crosses Electron's structured clone
 * as an ordinary object, so a label named `__proto__` with no colour would
 * read the prototype through plain indexing.
 */
export const labelColoursMap = (record: ArtifactLabelColours): ReadonlyMap<ArtifactLabel, ArtifactLabelColour> =>
  new Map(
    Object.keys(record).flatMap((label) => {
      const colour: unknown = Object.hasOwn(record, label) ? record[label as ArtifactLabel] : undefined;
      return typeof colour === "string" && COLOURS.has(colour) ? [[label as ArtifactLabel, colour as ArtifactLabelColour] as const] : [];
    }),
  );

const NONE: ReadonlyMap<ArtifactLabel, ArtifactLabelColour> = new Map();

/**
 * The node's label colours, read again on every artifact change of the
 * canvas (an applied colour sends one), and the write that sets or clears
 * one. `onRuling` hears how each write was ruled, so the node can say a
 * refusal or a queue as it does for every other op.
 */
export const useLabelColours = (
  canvasName: string,
  nodeId: NodeId,
  onRuling?: (outcome: ResourceApplyOutcome) => void,
): LabelColours => {
  const key = `${canvasName}\n${nodeId}`;
  const [read, setRead] = useState<{ readonly key: string; readonly colours: ReadonlyMap<ArtifactLabel, ArtifactLabelColour> }>({
    key,
    colours: NONE,
  });
  const refresh = useRef<() => void>(() => {});
  useEffect(() => {
    let live = true;
    // Only the latest read lands: one started before a change never overwrites one after it.
    let generation = 0;
    refresh.current = () => {
      const mine = ++generation;
      artifactsSource()
        .labelColours(canvasName, nodeId)
        .then(
          (record) => {
            if (live && mine === generation) setRead({ key, colours: labelColoursMap(record) });
          },
          () => undefined,
        );
    };
    refresh.current();
    const unsubscribe = artifactsSource().onChanged((changed) => {
      if (changed.canvasName === canvasName) refresh.current();
    });
    return () => {
      live = false;
      unsubscribe();
    };
  }, [canvasName, nodeId, key]);
  const colours = read.key === key ? read.colours : NONE;
  const ruling = useRef(onRuling);
  ruling.current = onRuling;
  const colourOf = useCallback((label: ArtifactLabel) => colours.get(label) ?? null, [colours]);
  const setColour = useCallback(
    (label: ArtifactLabel, colour: ArtifactLabelColour | null) => {
      void artifactsSource()
        .colour(canvasName, nodeId, mintOpId(), label, colour)
        .then(
          (outcome) => {
            if (outcome.kind === "applied") refresh.current();
            ruling.current?.(outcome);
          },
          () => undefined,
        );
    },
    [canvasName, nodeId],
  );
  return useMemo(() => ({ colourOf, setColour }), [colourOf, setColour]);
};
