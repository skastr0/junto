/**
 * What a briefing may mention (plan 0.11, 08): the texts seats are briefed
 * from are written as documents, so their editors take `@`, `#` and `[[`.
 * A region's instruction mentions what the region reaches; the app's
 * briefing and references mention anything on the canvas. The rule is
 * `briefingMentionableNodes`; this reads the items on those nodes.
 */
import { useCallback, useMemo } from "react";
import { briefingMentionableNodes } from "@shared/mention-reach";
import type { NodeKind } from "@shared/model/kinds";
import { titleOf } from "@shared/model/title";
import type { NodeId } from "@shared/physics/schema";
import type { DocumentMentions } from "../components/artifacts/LiveMarkdownField";
import type { LinkableArtifact } from "./artifact-link-draft";
import { mentionItemsOf, useCanvasArtifacts } from "./mention-items";
import { candidatesOfNodes, withRegionDetail } from "./mention-sources";
import { regionTrail } from "./region-path";
import { useCanvasTasks } from "./tasks-source";
import { nodeAt, useCanvas } from "./use-model";

/** The mentions a briefing on `canvasName` offers: the region's reach, or the whole canvas with no region. */
export const useBriefingMentions = (canvasName: string, regionId?: NodeId): DocumentMentions => {
  const canvas = useCanvas(canvasName);
  const tasks = useCanvasTasks(canvasName);
  const heads = useCanvasArtifacts(canvasName);
  const nodes = useMemo(() => briefingMentionableNodes(canvas, regionId), [canvas, regionId]);
  const candidates = useMemo(() => {
    const items = mentionItemsOf(tasks, heads);
    // Two seats named alike read apart by where they sit.
    return withRegionDetail(candidatesOfNodes(canvas, nodes, items), (nodeId) =>
      regionTrail(canvas, nodeId).map((step) => step.name),
    );
  }, [canvas, nodes, tasks, heads]);
  // What [[ links to: the live artifacts on the Artifacts nodes offered, each saying its node.
  const artifacts = useMemo(() => {
    const shelves = new Set(nodes.filter((node) => node.kind === "artifacts").map((node) => node.id));
    return heads
      .filter((head) => !head.artifact.archived && shelves.has(head.artifact.nodeId))
      .map((head): LinkableArtifact => {
        const shelf = canvas.nodes.get(head.artifact.nodeId);
        return {
          ref: { kind: "artifact", nodeId: head.artifact.nodeId, artifactId: head.artifact.artifactId },
          title: head.artifact.title,
          type: head.artifact.type,
          ...(shelf === undefined ? {} : { place: titleOf(shelf) }),
        };
      });
  }, [canvas, nodes, heads]);
  const nodeKindOf = useCallback((nodeId: NodeId): NodeKind | undefined => nodeAt(canvasName, nodeId)?.kind, [canvasName]);
  return useMemo(
    () => ({ canvasName, candidates, nodeKindOf, links: { artifacts } }),
    [canvasName, candidates, nodeKindOf, artifacts],
  );
};
