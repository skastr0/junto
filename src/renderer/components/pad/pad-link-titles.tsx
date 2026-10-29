import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState } from "react";
import { artifactLinkStateOf, artifactLinkTitle, type LinkedArtifactHead } from "@shared/artifact-link";
import { mentionLinksOf } from "@shared/mention";
import type { Pad } from "@shared/pad";
import type { PadLinkTitleOf } from "@shared/pad-project";
import type { NodeId } from "@shared/physics/schema";
import type { ItemId } from "@shared/work-ids";
import { artifactsSource } from "../../lib/artifacts-source";
import { useCanvas } from "../../lib/use-model";

const PadLinkTitles = createContext<PadLinkTitleOf | undefined>(undefined);

/** Where the pad's marks read a link's words now; without it a link shows the title it was written with. */
export const PadLinkTitlesProvider = PadLinkTitles.Provider;

export const usePadLinkTitleOf = (): PadLinkTitleOf | undefined => useContext(PadLinkTitles);

/** Each Artifacts node a pad links, by what it holds: null when it could not be read. */
type NodeHeads = ReadonlyMap<string, ReadonlyArray<LinkedArtifactHead> | null>;

/** What the links read: each node's artifacts, and where a linked artifact its node does not hold moved to. */
type Held = { readonly heads: NodeHeads; readonly movedTo: ReadonlyMap<string, NodeId> };

const EMPTY: Held = { heads: new Map(), movedTo: new Map() };

const headsOf = (canvasName: string, nodeId: NodeId): Promise<ReadonlyArray<LinkedArtifactHead> | null> =>
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
    );

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
 * rename shows on the pad at once. A link's node is a hint (0.11.1, 10): an
 * artifact it does not hold is read where its last move took it. A mention
 * of anything but an artifact keeps its own words.
 */
export const usePadLinkTitles = (canvasName: string | undefined, pad: Pad): PadLinkTitleOf => {
  const canvas = useCanvas(canvasName ?? "");
  const linked = useMemo(
    (): ReadonlyArray<readonly [NodeId, string]> => {
      const pairs = padTexts(pad).flatMap((text) =>
        mentionLinksOf(text).flatMap((link) => (link.target.item === undefined ? [] : [[link.target.nodeId, link.target.item] as const])),
      );
      return [...new Map(pairs.map((pair) => [`${pair[0]} ${pair[1]}`, pair])).values()].sort((a, b) => `${a}`.localeCompare(`${b}`));
    },
    [pad],
  );
  // The links an artifact may answer: those on an Artifacts node, and those whose node is gone (it may have moved first).
  // A task's node is not read for artifacts.
  const targets = useMemo(
    () => linked.filter(([id]) => { const kind = canvas.nodes.get(id)?.kind; return kind === "artifacts" || kind === undefined; }),
    [linked, canvas],
  );
  // Read again only when the set of links changes, not on every pad edit.
  const key = targets.map((pair) => pair.join(" ")).join("\n");
  const targetsRef = useRef(targets);
  targetsRef.current = targets;
  const canvasRef = useRef(canvas);
  canvasRef.current = canvas;
  const [held, setHeld] = useState(EMPTY);
  useEffect(() => {
    if (canvasName === undefined || key === "") {
      setHeld(EMPTY);
      return;
    }
    const reading = targetsRef.current;
    let live = true;
    const read = (): void => {
      void (async () => {
        const canvas = canvasRef.current;
        const hints = [...new Set(reading.flatMap(([nodeId]) => (canvas.nodes.get(nodeId)?.kind === "artifacts" ? [nodeId] : [])))];
        const heads = new Map<string, ReadonlyArray<LinkedArtifactHead> | null>(
          await Promise.all(hints.map(async (nodeId) => [nodeId, await headsOf(canvasName, nodeId)] as const)),
        );
        // A linked artifact its node does not hold (or whose node is gone) is looked for where it moved.
        const unheld = [...new Set(reading.flatMap(([nodeId, item]) => {
          const there = heads.get(nodeId);
          return there === null ? [] : there?.some((head) => head.artifactId === item) ? [] : [item];
        }))];
        const movedTo = new Map<string, NodeId>();
        await Promise.all(unheld.map(async (item) => {
          const moves = await artifactsSource().moves(canvasName, item as ItemId).catch(() => []);
          const now = moves.at(-1)?.to;
          if (now !== undefined && canvas.nodes.get(now)?.kind === "artifacts") movedTo.set(item, now);
        }));
        await Promise.all([...new Set(movedTo.values())].filter((nodeId) => !heads.has(nodeId)).map(async (nodeId) => {
          heads.set(nodeId, await headsOf(canvasName, nodeId));
        }));
        if (live) setHeld({ heads, movedTo });
      })();
    };
    read();
    const unsubscribe = artifactsSource().onChanged((changed) => {
      if (changed.canvasName === canvasName) read();
    });
    return () => {
      live = false;
      unsubscribe();
    };
  }, [canvasName, key]);
  return useCallback(
    (target, written) => {
      if (target.item === undefined || canvasName === undefined) return undefined;
      const nodeId = held.movedTo.get(target.item) ?? target.nodeId;
      const kind = canvas.nodes.get(nodeId)?.kind;
      // A node gone from the canvas: a [[ ]] link to it is missing; any other mention keeps its words.
      if (kind === undefined) return artifactLinkTitle(written) === undefined ? undefined : artifactLinkStateOf(target.item, null, written).words;
      if (kind !== "artifacts") return undefined;
      const link = artifactLinkStateOf(target.item, held.heads.has(nodeId) ? held.heads.get(nodeId) : undefined, written);
      return link.state === "archived" ? `${link.words}, archived` : link.words;
    },
    [canvas, canvasName, held],
  );
};
