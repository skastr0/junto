import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState } from "react";
import { mentionLinksOf } from "@shared/mention";
import type { Pad } from "@shared/pad";
import type { NodeId } from "@shared/physics/schema";
import type { PadLinkTitleOf } from "@shared/pad-project";
import { artifactsSource } from "../../lib/artifacts-source";

const PadLinkTitles = createContext<PadLinkTitleOf | undefined>(undefined);

/** Where the pad's marks read a link's current title; without it a link shows the title it was written with. */
export const PadLinkTitlesProvider = PadLinkTitles.Provider;

export const usePadLinkTitleOf = (): PadLinkTitleOf | undefined => useContext(PadLinkTitles);

const EMPTY: ReadonlyMap<string, string> = new Map();

const titleKey = (nodeId: string, artifactId: string): string => `${nodeId}/${artifactId}`;

/** Every text on a pad that may hold a link: shape words and edge labels. */
const padTexts = (pad: Pad): ReadonlyArray<string> => [
  ...pad.shapes.flatMap((shape) => (shape.type !== "card" && shape.text !== undefined ? [shape.text] : [])),
  ...pad.edges.flatMap((edge) => (edge.label === undefined ? [] : [edge.label])),
];

/**
 * The current title of each artifact a pad's text links, read from the
 * Artifacts nodes those links name and read again on any artifact change on
 * the canvas, so a rename shows on the pad at once. An archived artifact, or
 * one gone, keeps the title its link was written with.
 */
export const usePadLinkTitles = (canvasName: string | undefined, pad: Pad): PadLinkTitleOf => {
  const linked = useMemo(
    (): ReadonlyArray<NodeId> =>
      [
        ...new Set(
          padTexts(pad).flatMap((text) => mentionLinksOf(text).flatMap((link) => (link.target.item === undefined ? [] : [link.target.nodeId]))),
        ),
      ].sort(),
    [pad],
  );
  // Read again only when the set of nodes changes, not on every pad edit.
  const nodes = linked.join(" ");
  const linkedRef = useRef(linked);
  linkedRef.current = linked;
  const [titles, setTitles] = useState(EMPTY);
  useEffect(() => {
    if (canvasName === undefined || nodes === "") {
      setTitles(EMPTY);
      return;
    }
    const nodeIds = linkedRef.current;
    let live = true;
    const read = (): void => {
      void Promise.all(nodeIds.map((nodeId) => artifactsSource().list(canvasName, nodeId).catch(() => []))).then((lists) => {
        if (!live) return;
        const next = new Map<string, string>();
        lists.forEach((heads, index) => {
          for (const { artifact } of heads) {
            if (!artifact.archived) next.set(titleKey(nodeIds[index]!, artifact.artifactId), artifact.title);
          }
        });
        setTitles(next);
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
    (target) => (target.item === undefined ? undefined : titles.get(titleKey(target.nodeId, target.item))),
    [titles],
  );
};
