import type { CanvasDoc, CanvasNode, EtherNodeExtension } from "./canvas";

// Merge a disk/work write into the operator's local document so freeform
// geometry and graph structure are preserved while work stores (and their
// mirrored text) take the authoritative write's values.
//
// Local is structural authority for membership (nodes/edges the operator has
// added or removed). Work is authority for ether.tasks|requests|artifacts|
// messages and for mirrored text on task/requests/artifacts nodes.

const WORK_STORE_KINDS = new Set(["task", "requests", "artifacts"]);

const isWorkSurfaceKind = (kind: string | undefined): boolean =>
  kind === "task" || kind === "requests" || kind === "artifacts" || kind === "agent" || kind === "herdr";

const mergeEther = (
  local: EtherNodeExtension | undefined,
  work: EtherNodeExtension | undefined,
): EtherNodeExtension | undefined => {
  if (!local && !work) return undefined;
  const next: EtherNodeExtension = {
    ...(local ?? {}),
    ...(work?.tasks !== undefined ? { tasks: work.tasks } : {}),
    ...(work?.requests !== undefined ? { requests: work.requests } : {}),
    ...(work?.artifacts !== undefined ? { artifacts: work.artifacts } : {}),
    ...(work?.messages !== undefined ? { messages: work.messages } : {}),
    // Preserve local entity when present; else take work entity so a tasks
    // node stays typed. Work ops never author flags/view/herdr/etc.
    ...(!local?.entity && work?.entity ? { entity: work.entity } : {}),
  };
  return Object.keys(next).length > 0 ? next : undefined;
};

const mergeNode = (local: CanvasNode, work: CanvasNode | undefined): CanvasNode => {
  if (!work) return local;
  const kind = work.ether?.entity?.kind ?? local.ether?.entity?.kind;
  const ether = mergeEther(local.ether, work.ether);
  if (local.type === "text" && work.type === "text" && WORK_STORE_KINDS.has(kind ?? "")) {
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
 * Local-only nodes/edges are kept; work-only nodes (added on disk) are appended.
 */
export const mergeLocalCanvasWithWorkWrite = (local: CanvasDoc, work: CanvasDoc): CanvasDoc => {
  const workById = new Map(work.nodes.map((node) => [node.id, node] as const));
  const localIds = new Set(local.nodes.map((node) => node.id));
  const mergedLocal = local.nodes.map((node) => mergeNode(node, workById.get(node.id)));
  const workOnly = work.nodes.filter((node) => !localIds.has(node.id));
  return {
    nodes: [...mergedLocal, ...workOnly],
    edges: local.edges,
  };
};
