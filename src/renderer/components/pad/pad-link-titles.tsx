import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState } from "react";
import { artifactLinkStateOf, artifactLinkTitle, type LinkedArtifactHead } from "@shared/artifact-link";
import { mentionLinksOf } from "@shared/mention";
import type { Pad } from "@shared/pad";
import type { PadLinkTitleOf } from "@shared/pad-project";
import type { NodeId } from "@shared/physics/schema";
import { artifactsSource } from "../../lib/artifacts-source";
import { useCanvas } from "../../lib/use-model";

const PadLinkTitles = createContext<PadLinkTitleOf | undefined>(undefined);

/** Where the pad's marks read a link's words now; without it a link shows the title it was written with. */
export const PadLinkTitlesProvider = PadLinkTitles.Provider;

export const usePadLinkTitleOf = (): PadLinkTitleOf | undefined => useContext(PadLinkTitles);

/** Each Artifacts node a pad links, by what it holds: null when it could not be read. */
type NodeHeads = ReadonlyMap<string, ReadonlyArray<LinkedArtifactHead> | null>;

const EMPTY: NodeHeads = new Map();

/** Every text on a pad that may hold a link: shape words and edge labels. */
const padTexts = (pad: Pad): ReadonlyArray<string> => [
  ...pad.shapes.flatMap((shape) => (shape.type !== "card" && shape.text !== undefined ? [shape.text] : [])),
  ...pad.edges.flatMap((edge) => (edge.label === undefined ? [] : [edge.label])),
];

/**
 * A pad's artifact links in words, by the one link state every surface
 * draws (`artifactLinkStateOf`): the title now, ", archived" after an
 * archived one's title, "Missing artifact" for one gone, and the title it
 * was written with until its node is read. The Artifacts nodes the links
 * name are read, and read again on any artifact change on the canvas, so a
 * rename shows on the pad at once. A mention of anything but an artifact
 * keeps its own words.
 */
export const usePadLinkTitles = (canvasName: string | undefined, pad: Pad): PadLinkTitleOf => {
  const canvas = useCanvas(canvasName ?? "");
  const linked = useMemo(
    (): ReadonlyArray<NodeId> =>
      [
        ...new Set(
          padTexts(pad).flatMap((text) => mentionLinksOf(text).flatMap((link) => (link.target.item === undefined ? [] : [link.target.nodeId]))),
        ),
      ].sort(),
    [pad],
  );
  // The Artifacts nodes among them: a task's node is not read for artifacts.
  const nodeIds = useMemo(() => linked.filter((id) => canvas.nodes.get(id)?.kind === "artifacts"), [linked, canvas]);
  // Read again only when the set of nodes changes, not on every pad edit.
  const nodes = nodeIds.join(" ");
  const nodesRef = useRef(nodeIds);
  nodesRef.current = nodeIds;
  const [held, setHeld] = useState(EMPTY);
  useEffect(() => {
    if (canvasName === undefined || nodes === "") {
      setHeld(EMPTY);
      return;
    }
    const reading = nodesRef.current;
    let live = true;
    const read = (): void => {
      void Promise.all(
        reading.map((nodeId) =>
          artifactsSource()
            .list(canvasName, nodeId)
            .then(
              (heads) =>
                heads.map(({ artifact }): LinkedArtifactHead => ({
                  artifactId: artifact.artifactId,
                  title: artifact.title,
                  type: artifact.type,
                  archived: artifact.archived,
                })),
              () => null,
            ),
        ),
      ).then((lists) => {
        if (live) setHeld(new Map(reading.map((nodeId, index) => [nodeId, lists[index] ?? null])));
      });
    };
    read();
    const unsubscribe = artifactsSource().onChanged((changed) => {
      if (changed.canvasName === canvasName) read();
    });
    return () => {
      live = false;
      unsubscribe();
    };
  }, [canvasName, nodes]);
  return useCallback(
    (target, written) => {
      if (target.item === undefined || canvasName === undefined) return undefined;
      const kind = canvas.nodes.get(target.nodeId)?.kind;
      // A node gone from the canvas: a [[ ]] link to it is missing; any other mention keeps its words.
      if (kind === undefined) return artifactLinkTitle(written) === undefined ? undefined : artifactLinkStateOf(target.item, null, written).words;
      if (kind !== "artifacts") return undefined;
      const link = artifactLinkStateOf(target.item, held.has(target.nodeId) ? held.get(target.nodeId) : undefined, written);
      return link.state === "archived" ? `${link.words}, archived` : link.words;
    },
    [canvas, canvasName, held],
  );
};
