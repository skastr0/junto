import { Match } from "effect";
import type { CanvasDoc, CanvasNode, EtherNodeExtension } from "./canvas";
import { resolveSpec } from "./physics";

// Merge an authority/work write into the operator's local document so freeform
// geometry and graph structure are preserved while work stores (and their
// mirrored text) take the authoritative write's values.
//
// Local is structural authority for membership (nodes/edges the operator has
// added or removed), including authored ether.tasks.name|contract. Work is
// authority for tasks.items, the other Work bags, and mirrored sink text.

// Both predicates are exhaustive over NodeSpec, so the two lists can no longer
// drift apart: a work store is a sink that holds a document (every sink but the
// browser page); a work surface is a work store plus the actor seats that carry
// a message inbox. A raw terminal has no inbox, so it is neither.
const isWorkStoreKind = (kind: string | undefined): boolean =>
  Match.value(resolveSpec({ isGroup: false, kind })).pipe(
    Match.tagsExhaustive({
      Actor: () => false,
      Sink: (spec) => spec.kind !== "page",
      Scheduler: () => false,
      Geography: () => false,
    }),
  );

const isWorkSurfaceKind = (kind: string | undefined): boolean =>
  Match.value(resolveSpec({ isGroup: false, kind })).pipe(
    Match.tagsExhaustive({
      Actor: () => true,
      Sink: (spec) => spec.kind !== "page",
      Scheduler: () => false,
      Geography: () => false,
    }),
  );

const mergeTasks = (
  local: EtherNodeExtension["tasks"],
  work: EtherNodeExtension["tasks"],
): EtherNodeExtension["tasks"] => {
  if (work === undefined) return local;
  if (local === undefined) return work;
  return {
    items: work.items,
    ...(local.name !== undefined ? { name: local.name } : {}),
    ...(local.contract !== undefined ? { contract: local.contract } : {}),
  };
};

const mergeEther = (
  local: EtherNodeExtension | undefined,
  work: EtherNodeExtension | undefined,
): EtherNodeExtension | undefined => {
  if (!local && !work) return undefined;
  const next: EtherNodeExtension = {
    ...(local ?? {}),
    ...(local?.tasks !== undefined || work?.tasks !== undefined
      ? { tasks: mergeTasks(local?.tasks, work?.tasks) }
      : {}),
    ...(work?.requests !== undefined ? { requests: work.requests } : {}),
    ...(work?.artifacts !== undefined ? { artifacts: work.artifacts } : {}),
    ...(work?.messages !== undefined ? { messages: work.messages } : {}),
    ...(work?.board !== undefined ? { board: work.board } : {}),
    // Preserve local entity when present; else take work entity so a tasks
    // node stays typed. Work ops never author flags/view/etc.
    ...(!local?.entity && work?.entity ? { entity: work.entity } : {}),
  };
  return Object.keys(next).length > 0 ? next : undefined;
};

const mergeNode = (local: CanvasNode, work: CanvasNode | undefined): CanvasNode => {
  if (!work) return local;
  const kind = work.ether?.entity?.kind ?? local.ether?.entity?.kind;
  const ether = mergeEther(local.ether, work.ether);
  if (local.type === "text" && work.type === "text" && isWorkStoreKind(kind)) {
    return {
      ...local,
      text: work.text,
      ...(ether ? { ether } : {}),
    };
  }
  if (isWorkSurfaceKind(kind) || work.ether?.messages !== undefined) {
    return {
      ...local,
      ...(ether ? { ether } : {}),
    };
  }
  // Non-work nodes: keep local entirely (geometry + content); work write
  // should not have changed them, but never clobber freeform text.
  return local;
};

/**
 * Overlay authoritative work-plane fields from `work` onto freeform `local`.
 * Local is structural authority for membership: work-only nodes are not
 * re-appended (would undo operator delete before archive lands).
 * Local-only nodes/edges are kept; work overlays stores on intersection ids.
 */
export const mergeLocalCanvasWithWorkWrite = (local: CanvasDoc, work: CanvasDoc): CanvasDoc => {
  const workById = new Map(work.nodes.map((node) => [node.id, node] as const));
  const mergedLocal = local.nodes.map((node) => mergeNode(node, workById.get(node.id)));
  return {
    nodes: mergedLocal,
    edges: local.edges,
  };
};
