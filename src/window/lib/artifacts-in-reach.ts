import { useMemo } from "react";
import { mentionableNodesFrom } from "@shared/mention-reach";
import { titleOf } from "@shared/model/title";
import type { NodeId } from "@shared/physics/schema";
import type { LinkableArtifact } from "./artifact-link-draft";
import { useNodesArtifacts } from "./artifacts-source";
import { useCanvas } from "./use-model";

const NONE: ReadonlyArray<never> = [];

/**
 * What a `[[` in a resource may link to (plan 0.11, 02): every live artifact
 * in every Artifacts node in reach of `from`, its own included, by the same
 * reach a `#` uses (`mentionableNodesFrom`). The host's own artifacts come
 * first and say no place; another node's say its title. Each node rides its
 * shared read (artifacts-source.ts), so an artifact change re-reads only the
 * nodes it names, once for every caller; a node not yet read, or that could
 * not be, offers nothing, and the others still do.
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
  // eslint-disable-next-line react-hooks/exhaustive-deps -- `key` stands for `nodes`.
  const held = useMemo(() => nodes, [key]);
  const ids = useMemo(() => held.map((node) => node.id), [held]);
  const values = useNodesArtifacts(canvasName, ids);
  return useMemo(() => {
    const artifacts: LinkableArtifact[] = [];
    held.forEach((node, index) => {
      const read = values[index];
      if (read === undefined || !read.confirmed || read.value === undefined) return;
      for (const head of read.value) {
        if (head.artifact.archived) continue;
        artifacts.push({
          ref: { kind: "artifact", nodeId: node.id, artifactId: head.artifact.artifactId },
          title: head.artifact.title,
          type: head.artifact.type,
          ...(node.id === from ? {} : { place: node.title }),
        });
      }
    });
    return artifacts.length === 0 ? NONE : artifacts;
  }, [held, values, from]);
};
