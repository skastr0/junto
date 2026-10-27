import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { artifactLinkStateOf, artifactLinkTitle, type ArtifactLinkState, type LinkedArtifactHead } from "@shared/artifact-link";
import { mentionLinksOf, type MentionTarget } from "@shared/mention";
import type { NodeId } from "@shared/physics/schema";
import { artifactsSource } from "./artifacts-source";

/**
 * Where an artifact link stands now (`artifactLinkStateOf`), from its target
 * and its label as written; undefined for a link that names no artifact.
 */
export type LinkStateOf = (target: MentionTarget, written: string) => ArtifactLinkState | undefined;

/** A run of text as a reader draws it: plain words, or a link's words, what it names and where that stands. */
export type LinkPiece = { readonly text: string; readonly link?: MentionTarget; readonly state?: ArtifactLinkState["state"] };

/**
 * Text split into its words and its mention links, each link as its words,
 * never its address: an artifact link takes the words its state gives (the
 * title now, so a rename shows at once), else the title it was written with
 * (a `[[ ]]` link's label without its brackets).
 */
export const linkPiecesOf = (text: string, stateOf?: LinkStateOf): ReadonlyArray<LinkPiece> => {
  const links = mentionLinksOf(text);
  if (links.length === 0) return [{ text }];
  const pieces: LinkPiece[] = [];
  let at = 0;
  for (const link of links) {
    if (link.start > at) pieces.push({ text: text.slice(at, link.start) });
    const resolved = stateOf?.(link.target, link.label);
    pieces.push({
      text: resolved?.words ?? artifactLinkTitle(link.label) ?? link.label,
      link: link.target,
      ...(resolved === undefined ? {} : { state: resolved.state }),
    });
    at = link.end;
  }
  if (at < text.length) pieces.push({ text: text.slice(at) });
  return pieces;
};

/** Each linked node's heads: null when it is no Artifacts node now; a node not yet read, or that could not be, is absent. */
type Read = ReadonlyMap<string, ReadonlyArray<LinkedArtifactHead> | null>;
const EMPTY: Read = new Map();

/**
 * Where each artifact the texts link stands, read from the Artifacts nodes
 * those links name and read again on any artifact change on the canvas.
 * `nodeKindOf` says which linked nodes are still Artifacts nodes; a link into
 * one that is not, or is gone, is missing without a read.
 */
export const useLinkStates = (
  canvasName: string | undefined,
  texts: ReadonlyArray<string>,
  nodeKindOf: (nodeId: NodeId) => string | undefined,
): LinkStateOf => {
  const linked = useMemo(
    (): ReadonlyArray<NodeId> =>
      [
        ...new Set(texts.flatMap((text) => mentionLinksOf(text).flatMap((link) => (link.target.item === undefined ? [] : [link.target.nodeId])))),
      ].sort(),
    [texts],
  );
  // Read again only when the set of nodes changes, not on every edit.
  const nodes = linked.join(" ");
  const linkedRef = useRef(linked);
  linkedRef.current = linked;
  const kindRef = useRef(nodeKindOf);
  kindRef.current = nodeKindOf;
  const [read, setRead] = useState(EMPTY);
  useEffect(() => {
    if (canvasName === undefined || nodes === "") {
      setRead(EMPTY);
      return;
    }
    const nodeIds = linkedRef.current;
    let live = true;
    const refresh = (): void => {
      void Promise.all(
        nodeIds.map((nodeId) =>
          kindRef.current(nodeId) === "artifacts"
            ? artifactsSource()
                .list(canvasName, nodeId)
                .then((heads) => heads.map(({ artifact }): LinkedArtifactHead => artifact))
                // A node that cannot be read says nothing about its artifacts: their links stay unread, never missing.
                .catch(() => undefined)
            : Promise.resolve(null),
        ),
      ).then((lists) => {
        if (!live) return;
        const next = new Map<string, ReadonlyArray<LinkedArtifactHead> | null>();
        lists.forEach((list, index) => {
          if (list !== undefined) next.set(nodeIds[index]!, list);
        });
        setRead(next);
      });
    };
    refresh();
    const unsubscribe = artifactsSource().onChanged((changed) => {
      if (changed.canvasName === canvasName) refresh();
    });
    return () => {
      live = false;
      unsubscribe();
    };
  }, [canvasName, nodes]);
  return useCallback<LinkStateOf>(
    (target, written) => (target.item === undefined ? undefined : artifactLinkStateOf(target.item, read.get(target.nodeId), written)),
    [read],
  );
};
