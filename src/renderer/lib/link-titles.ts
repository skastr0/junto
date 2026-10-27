import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { artifactLinkTitle } from "@shared/artifact-link";
import { mentionLinksOf, type MentionTarget } from "@shared/mention";
import type { NodeId } from "@shared/physics/schema";
import { artifactsSource } from "./artifacts-source";

/** The current title of what a link names, when the reader knows it. */
export type LinkTitleOf = (target: MentionTarget) => string | undefined;

/**
 * Where a link's artifact stands, once its node has been read: there,
 * archived, or unavailable (the node does not hold it), as a document's chip
 * says it (DocumentMentionChip). Unknown until the read lands, and for a link
 * that names no artifact.
 */
export type LinkState = "live" | "archived" | "unavailable";
export type LinkStateOf = (target: MentionTarget) => LinkState | undefined;

/** A run of text as a reader draws it: plain words, or a link's words, what it names and where that stands. */
export type LinkPiece = { readonly text: string; readonly link?: MentionTarget; readonly state?: LinkState };

/**
 * Text split into its words and its mention links, each link as its words,
 * never its address: an artifact link takes the title the reader knows now,
 * so a rename shows at once, else the title it was written with (a `[[ ]]`
 * link's label without its brackets).
 */
export const linkPiecesOf = (text: string, titleOf?: LinkTitleOf, stateOf?: LinkStateOf): ReadonlyArray<LinkPiece> => {
  const links = mentionLinksOf(text);
  if (links.length === 0) return [{ text }];
  const pieces: LinkPiece[] = [];
  let at = 0;
  for (const link of links) {
    if (link.start > at) pieces.push({ text: text.slice(at, link.start) });
    const state = stateOf?.(link.target);
    pieces.push({
      text: titleOf?.(link.target) ?? artifactLinkTitle(link.label) ?? link.label,
      link: link.target,
      ...(state === undefined ? {} : { state }),
    });
    at = link.end;
  }
  if (at < text.length) pieces.push({ text: text.slice(at) });
  return pieces;
};

type Held = { readonly title: string; readonly archived: boolean };
type Read = { readonly nodes: ReadonlySet<string>; readonly heads: ReadonlyMap<string, Held> };
const EMPTY: Read = { nodes: new Set(), heads: new Map() };

const titleKey = (nodeId: string, artifactId: string): string => `${nodeId}/${artifactId}`;

/**
 * The current title of each live artifact the texts link, and where each
 * linked artifact stands, read from the Artifacts nodes those links name and
 * read again on any artifact change on the canvas. An archived artifact, or
 * an unavailable one, has no title here, so its link keeps the title it was written
 * with.
 */
export const useLinkTargets = (
  canvasName: string | undefined,
  texts: ReadonlyArray<string>,
): { readonly titleOf: LinkTitleOf; readonly stateOf: LinkStateOf } => {
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
  const [read, setRead] = useState(EMPTY);
  useEffect(() => {
    if (canvasName === undefined || nodes === "") {
      setRead(EMPTY);
      return;
    }
    const nodeIds = linkedRef.current;
    let live = true;
    const refresh = (): void => {
      // A node that cannot be read says nothing about its artifacts: their links stay unknown, never gone.
      void Promise.all(nodeIds.map((nodeId) => artifactsSource().list(canvasName, nodeId).catch(() => undefined))).then((lists) => {
        if (!live) return;
        const seen = new Set<string>();
        const heads = new Map<string, Held>();
        lists.forEach((list, index) => {
          if (list === undefined) return;
          seen.add(nodeIds[index]!);
          for (const { artifact } of list) heads.set(titleKey(nodeIds[index]!, artifact.artifactId), { title: artifact.title, archived: artifact.archived });
        });
        setRead({ nodes: seen, heads });
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
  const titleOf = useCallback<LinkTitleOf>(
    (target) => {
      if (target.item === undefined) return undefined;
      const held = read.heads.get(titleKey(target.nodeId, target.item));
      return held === undefined || held.archived ? undefined : held.title;
    },
    [read],
  );
  const stateOf = useCallback<LinkStateOf>(
    (target) => {
      if (target.item === undefined || !read.nodes.has(target.nodeId)) return undefined;
      const held = read.heads.get(titleKey(target.nodeId, target.item));
      return held === undefined ? "unavailable" : held.archived ? "archived" : "live";
    },
    [read],
  );
  return useMemo(() => ({ titleOf, stateOf }), [titleOf, stateOf]);
};

/** The current title of each live artifact the texts link (`useLinkTargets` without where each stands). */
export const useLinkTitles = (canvasName: string | undefined, texts: ReadonlyArray<string>): LinkTitleOf =>
  useLinkTargets(canvasName, texts).titleOf;
