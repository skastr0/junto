import { useEffect, useMemo, useState } from "react";
import { mentionableNodesFrom } from "@shared/mention-reach";
import { titleOf } from "@shared/model/title";
import type { NodeId } from "@shared/physics/schema";
import type { LinkableArtifact } from "./artifact-link-draft";
import { artifactsSource } from "./artifacts-source";
import { useCanvas } from "./use-model";

const NONE: ReadonlyArray<never> = [];

/**
 * What a `[[` in a resource may link to (plan 0.11, 02): every live artifact
 * in every Artifacts node in reach of `from`, its own included, by the same
 * reach a `#` uses (`mentionableNodesFrom`). The host's own artifacts come
 * first and say no place; another node's say its title. Re-read on any
 * artifact change on the canvas; empty until the first read lands.
 */
export const useArtifactsInReach = (canvasName: string, from: NodeId): ReadonlyArray<LinkableArtifact> => {
  const canvas = useCanvas(canvasName);
  const nodes = useMemo(
    () =>
      mentionableNodesFrom(canvas, from)
        .filter((node) => node.kind === "artifacts")
        .map((node) => {
          const full = canvas.nodes.get(node.id);
          return { id: node.id, title: full === undefined ? "" : titleOf(full) };
        })
        .sort((a, b) => (a.id === from ? -1 : b.id === from ? 1 : 0)),
    [canvas, from],
  );
  // The nodes as one value, so a canvas change that moves nothing in reach reads nothing again.
  const key = nodes.map((node) => `${node.id}\u0000${node.title}`).join("\u0001");
  const [held, setHeld] = useState<{ readonly key: string; readonly artifacts: ReadonlyArray<LinkableArtifact> }>({ key, artifacts: NONE });
  useEffect(() => {
    let live = true;
    let generation = 0;
    const refresh = (): void => {
      const mine = ++generation;
      void Promise.all(
        nodes.map((node) =>
          artifactsSource()
            .list(canvasName, node.id)
            .then(
              (heads) =>
                heads
                  .filter((head) => !head.artifact.archived)
                  .map(
                    (head): LinkableArtifact => ({
                      ref: { kind: "artifact", nodeId: node.id, artifactId: head.artifact.artifactId },
                      title: head.artifact.title,
                      type: head.artifact.type,
                      ...(node.id === from ? {} : { place: node.title }),
                    }),
                  ),
              // A node that cannot be read offers nothing; the others still do.
              () => NONE,
            ),
        ),
      ).then((lists) => {
        if (live && mine === generation) setHeld({ key, artifacts: lists.flat() });
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
    // `key` stands for `nodes`.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [canvasName, from, key]);
  return held.key === key ? held.artifacts : NONE;
};
