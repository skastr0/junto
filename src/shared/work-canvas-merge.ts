import { Match } from "effect";
import type { CanvasDoc, CanvasNode, EtherNodeExtension } from "./canvas";
import { resolveSpec } from "./physics";
import { mirrorRequestsText } from "./task";

/**
 * Board text merge: the local first line is the operator's authored title and
 * always wins (a work write may carry a stale title from the persisted
 * document); the projected topic lines beneath it come from the work write.
 */
const mergeBoardNodeText = (local: string, work: string): string => {
  const first = local.trim().split("\n")[0]?.trim() ?? "";
  if (first === "") return work;
  return [first, ...work.split("\n").slice(1)].join("\n");
};

// Merge an authority/work write into the operator's local document so freeform
// geometry and graph structure are preserved while work stores (and their
// mirrored text) take the authoritative write's values.
//
// Local is structural authority for membership (nodes/edges the operator has
// added or removed), including authored ether.tasks.name|contract and
// ether.requests.name. Work is authority for the items bags and mirrored sink
// text (requests regenerates from the merged store; board keeps the local
// authored first line).

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

const mergeRequests = (
  local: EtherNodeExtension["requests"],
  work: EtherNodeExtension["requests"],
): EtherNodeExtension["requests"] => {
  if (work === undefined) return local;
  if (local === undefined) return work;
  return {
    items: work.items,
    // A blank local name is not an authored rename — let the work write's
    // name stand.
    ...(local.name !== undefined && local.name.trim() !== ""
      ? { name: local.name }
      : work.name !== undefined
        ? { name: work.name }
        : {}),
  };
};

const mergeEther = (
  local: EtherNodeExtension | undefined,
  work: EtherNodeExtension | undefined,
): EtherNodeExtension | undefined => {
  if (!local && !work) return undefined;
  // ether.requests.name is operator-authored identity (rename survives work
  // writes), while items take the authoritative work write. Regenerate the
  // mirrored text from the merged store below in mergeNode.
  const next: EtherNodeExtension = {
    ...(local ?? {}),
    ...(local?.tasks !== undefined || work?.tasks !== undefined
      ? { tasks: mergeTasks(local?.tasks, work?.tasks) }
      : {}),
    ...(local?.requests !== undefined || work?.requests !== undefined
      ? { requests: mergeRequests(local?.requests, work?.requests) }
      : {}),
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
    // Requests keeps its mirror in lockstep with the merged store: a local
    // rename must not be overwritten by the work write's (possibly stale)
    // mirrored text.
    const text =
      kind === "requests" && ether?.requests !== undefined
        ? mirrorRequestsText(ether.requests.items, ether.requests.name)
        : kind === "board"
          ? mergeBoardNodeText(local.text, work.text)
          : work.text;
    return {
      ...local,
      text,
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
