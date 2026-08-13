/**
 * Work-plane author rules for pad patches. Author class is not in pad.ts.
 */
import { NodeSpec, resolveSpec } from "@shared/physics";
import type { CanvasDoc } from "@shared/canvas";
import type { PadPatch } from "@shared/pad";
import type { BoardAuthor } from "@shared/work-model";

const isActorSpec = NodeSpec.$is("Actor");

export const inboundActorNodeIds = (
  doc: CanvasDoc,
  padNodeId: string,
): ReadonlySet<string> => {
  const ids = new Set<string>();
  for (const edge of doc.edges) {
    if (edge.toNode !== padNodeId) continue;
    const from = doc.nodes.find((node) => node.id === edge.fromNode);
    const spec = resolveSpec({
      isGroup: false,
      kind: from?.ether?.entity?.kind,
    });
    if (isActorSpec(spec)) ids.add(edge.fromNode);
  }
  return ids;
};

const mentionsOf = (patch: PadPatch): ReadonlyArray<string> => {
  if (patch.op === "pin.upsert") return patch.pin.mentions;
  if (patch.op === "pin.reply") return [];
  return [];
};

export const padAuthorRuleError = (
  author: BoardAuthor,
  patches: ReadonlyArray<PadPatch>,
  inboundActors: ReadonlySet<string>,
): string | undefined => {
  for (const patch of patches) {
    if (author.kind === "actor") {
      if (patch.op === "upsert" && patch.layer === "ink") {
        return "agents cannot upsert ink";
      }
      if (patch.op === "upsert" && patch.layer === "image") {
        return "agents cannot upsert images";
      }
    }
    for (const mention of mentionsOf(patch)) {
      if (!inboundActors.has(mention)) {
        return `mention "${mention}" is not an inbound actor on this pad`;
      }
    }
  }
  return undefined;
};
