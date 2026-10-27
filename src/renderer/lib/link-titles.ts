import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { artifactLinkTitle } from "@shared/artifact-link";
import { mentionLinksOf, type MentionTarget } from "@shared/mention";
import type { NodeId } from "@shared/physics/schema";
import { artifactsSource } from "./artifacts-source";

/** The current title of what a link names, when the reader knows it. */
export type LinkTitleOf = (target: MentionTarget) => string | undefined;

/** A run of text as a reader draws it: plain words, or a link's words and what it names. */
export type LinkPiece = { readonly text: string; readonly link?: MentionTarget };

/**
 * Text split into its words and its mention links, each link as its words,
 * never its address: an artifact link takes the title the reader knows now,
 * so a rename shows at once, else the title it was written with (a `[[ ]]`
 * link's label without its brackets).
 */
export const linkPiecesOf = (text: string, titleOf?: LinkTitleOf): ReadonlyArray<LinkPiece> => {
  const links = mentionLinksOf(text);
  if (links.length === 0) return [{ text }];
  const pieces: LinkPiece[] = [];
  let at = 0;
  for (const link of links) {
    if (link.start > at) pieces.push({ text: text.slice(at, link.start) });
    pieces.push({ text: titleOf?.(link.target) ?? artifactLinkTitle(link.label) ?? link.label, link: link.target });
    at = link.end;
  }
  if (at < text.length) pieces.push({ text: text.slice(at) });
  return pieces;
};

const EMPTY: ReadonlyMap<string, string> = new Map();

const titleKey = (nodeId: string, artifactId: string): string => `${nodeId}/${artifactId}`;

/**
 * The current title of each artifact the texts link, read from the
 * Artifacts nodes those links name and read again on any artifact change on
 * the canvas. An archived artifact, or one gone, has none, so its link keeps
 * the title it was written with.
 */
export const useLinkTitles = (canvasName: string | undefined, texts: ReadonlyArray<string>): LinkTitleOf => {
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
  return useCallback((target) => (target.item === undefined ? undefined : titles.get(titleKey(target.nodeId, target.item))), [titles]);
};
