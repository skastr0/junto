import { useCallback, useMemo } from "react";
import { artifactLinkStateOf, artifactLinkTitle, type ArtifactLinkState, type LinkedArtifactHead } from "@shared/artifact-link";
import { mentionLinksOf, type MentionTarget } from "@shared/mention";
import type { NodeId } from "@shared/physics/schema";
import { useNodesArtifacts } from "./artifacts-source";

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
 * those links name, each on its shared read.
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
  // Read again only when the set of nodes, or which of them are Artifacts nodes, changes; not on every edit.
  const nodes = linked.join(" ");
  const kinds = linked.map((nodeId) => (nodeKindOf(nodeId) === "artifacts" ? "1" : "0")).join("");
  // eslint-disable-next-line react-hooks/exhaustive-deps -- `nodes` and `kinds` stand for `linked`.
  const held = useMemo(() => ({ linked, shelves: canvasName === undefined ? [] : linked.filter((_, index) => kinds[index] === "1") }), [canvasName, nodes, kinds]);
  // Each Artifacts node rides its shared read (artifacts-source.ts): a change re-reads only the nodes it names, once for every caller.
  const values = useNodesArtifacts(canvasName ?? "", held.shelves);
  const read = useMemo((): Read => {
    if (canvasName === undefined || held.linked.length === 0) return EMPTY;
    const next = new Map<string, ReadonlyArray<LinkedArtifactHead> | null>();
    held.linked.forEach((nodeId, index) => {
      if (kinds[index] !== "1") next.set(nodeId, null);
    });
    held.shelves.forEach((nodeId, index) => {
      const one = values[index];
      // A node not yet read, or that could not be, says nothing about its artifacts: their links stay unread, never missing.
      if (one !== undefined && one.confirmed && one.value !== undefined) next.set(nodeId, one.value.map(({ artifact }): LinkedArtifactHead => artifact));
    });
    return next;
  }, [canvasName, held, kinds, values]);
  return useCallback<LinkStateOf>(
    (target, written) => (target.item === undefined ? undefined : artifactLinkStateOf(target.item, read.get(target.nodeId), written)),
    [read],
  );
};
