/**
 * Pure overseer canvas authoring: seat identity, grant preservation, and
 * self-preservation. Main owns transactions; this module does not touch SQLite.
 */
import { Result } from "effect";
import { productNodeKindEnabled, productVerbEnabled } from "./features";
import {
  decodeCanvasDoc,
  type CanvasDoc,
  type CanvasEdge,
  type CanvasNode,
  type EtherNodeExtension,
} from "./canvas";
import type {
  OverseerCanvasBatchStep,
  OverseerEdgeChanges,
  OverseerErrorBody,
  OverseerNodeChanges,
  OverseerNodeEtherChanges,
} from "./overseer-control";
import { validateFlowDag } from "./flow-graph";
import { verbsForPair, type Verb } from "./physics/verbs";

export type OverseerSeatBinding = {
  readonly hostId: string;
  readonly bindingId: string;
};

export type OverseerOccupantIdentity = {
  readonly kind: string | undefined;
  readonly agentKey: string | undefined;
  readonly hostId: string | undefined;
  readonly bindingId: string | undefined;
  readonly harness: string | undefined;
  readonly launch: unknown;
  readonly sessionId: string | undefined;
};

const bindingKey = (seat: OverseerSeatBinding): string =>
  `${seat.hostId}\0${seat.bindingId}`;

const trimDefined = (value: string | undefined): string | undefined => {
  const trimmed = value?.trim();
  return trimmed && trimmed.length > 0 ? trimmed : undefined;
};

/** Managed-agent (host, binding) identity, or undefined for ordinary nodes. */
export const nodeSeatBinding = (
  node: CanvasNode,
): OverseerSeatBinding | undefined => {
  if (node.ether?.entity?.kind !== "agent") return undefined;
  const bindingId = trimDefined(node.ether.terminal?.bindingId);
  if (bindingId === undefined) return undefined;
  return {
    hostId: trimDefined(node.ether.host) ?? "local",
    bindingId,
  };
};

export const nodeOccupantIdentity = (
  node: CanvasNode,
): OverseerOccupantIdentity => ({
  kind: node.ether?.entity?.kind,
  agentKey: trimDefined(node.ether?.entity?.name),
  hostId: trimDefined(node.ether?.host),
  bindingId: trimDefined(node.ether?.terminal?.bindingId),
  harness: node.ether?.terminal?.harness,
  launch: node.ether?.terminal?.launch,
  sessionId: trimDefined(node.ether?.terminal?.sessionId),
});

export const occupantIdentityEquals = (
  left: OverseerOccupantIdentity,
  right: OverseerOccupantIdentity,
): boolean =>
  left.kind === right.kind &&
  left.agentKey === right.agentKey &&
  left.hostId === right.hostId &&
  left.bindingId === right.bindingId &&
  left.harness === right.harness &&
  left.sessionId === right.sessionId &&
  JSON.stringify(left.launch ?? null) === JSON.stringify(right.launch ?? null);

export const isManagedAgentNode = (node: CanvasNode): boolean =>
  nodeSeatBinding(node) !== undefined;

export const nodeHasOverseerGrant = (node: CanvasNode): boolean =>
  node.ether?.overseer === true && isManagedAgentNode(node);

export const findNode = (
  doc: CanvasDoc,
  nodeId: string,
): CanvasNode | undefined => doc.nodes.find((node) => node.id === nodeId);

export const findEdge = (
  doc: CanvasDoc,
  edgeId: string,
): CanvasEdge | undefined => doc.edges.find((edge) => edge.id === edgeId);

export const kindOfNode = (node: CanvasNode | undefined): string | undefined =>
  node === undefined || node.type === "group"
    ? undefined
    : node.ether?.entity?.kind;

const withoutKey = <T extends object, K extends keyof T>(
  value: T,
  key: K,
): Omit<T, K> => {
  const { [key]: _removed, ...rest } = value;
  return rest;
};

/** Set or clear `ether.overseer` without minting empty ether objects. */
export const applyOverseerFlag = (
  node: CanvasNode,
  overseer: boolean,
): CanvasNode => {
  const ether = node.ether;
  if (overseer) {
    return {
      ...node,
      ether: { ...(ether ?? {}), overseer: true },
    };
  }
  if (ether?.overseer !== true) return node;
  const next = withoutKey(ether, "overseer");
  if (Object.keys(next).length === 0) {
    return withoutKey(node, "ether") as CanvasNode;
  }
  return { ...node, ether: next };
};

/**
 * Incoming documents never mint, restore, or copy overseer. Live grant survives
 * only when the same node id keeps the same (host, binding). New, replaced,
 * reseated, or copied nodes are cleared even if they alias a live binding.
 */
export const reconcileOverseerGrants = (
  previous: CanvasDoc,
  next: CanvasDoc,
): CanvasDoc => {
  const previousById = new Map(previous.nodes.map((node) => [node.id, node]));
  return {
    ...next,
    nodes: next.nodes.map((node) => {
      const prior = previousById.get(node.id);
      const nextSeat = nodeSeatBinding(node);
      const priorSeat = prior === undefined ? undefined : nodeSeatBinding(prior);
      const unchanged =
        prior !== undefined &&
        nextSeat !== undefined &&
        priorSeat !== undefined &&
        nextSeat.hostId === priorSeat.hostId &&
        nextSeat.bindingId === priorSeat.bindingId;
      return applyOverseerFlag(
        node,
        unchanged && nodeHasOverseerGrant(prior),
      );
    }),
  };
};

export const portfolioOverseerBindings = (
  documents: ReadonlyMap<string, CanvasDoc>,
): ReadonlySet<string> => {
  const live = new Set<string>();
  for (const doc of documents.values()) {
    for (const node of doc.nodes) {
      if (!nodeHasOverseerGrant(node)) continue;
      const seat = nodeSeatBinding(node);
      if (seat !== undefined) live.add(bindingKey(seat));
    }
  }
  return live;
};

export const bindingAliases = (
  documents: ReadonlyMap<string, CanvasDoc>,
  seat: OverseerSeatBinding,
): ReadonlyArray<{ readonly canvasName: string; readonly node: CanvasNode }> => {
  const key = bindingKey(seat);
  const aliases: Array<{ canvasName: string; node: CanvasNode }> = [];
  for (const [canvasName, doc] of documents) {
    for (const node of doc.nodes) {
      const candidate = nodeSeatBinding(node);
      if (candidate !== undefined && bindingKey(candidate) === key) {
        aliases.push({ canvasName, node });
      }
    }
  }
  return aliases;
};

export const callerGrantLive = (
  documents: ReadonlyMap<string, CanvasDoc>,
  caller: { readonly canvasName: string; readonly nodeId: string },
): boolean => {
  const doc = documents.get(caller.canvasName);
  if (doc === undefined) return false;
  const node = findNode(doc, caller.nodeId);
  return node !== undefined && nodeHasOverseerGrant(node);
};

export const setBindingOverseer = (
  documents: ReadonlyMap<string, CanvasDoc>,
  seat: OverseerSeatBinding,
  overseer: boolean,
): Map<string, CanvasDoc> => {
  const next = new Map(documents);
  for (const [canvasName, doc] of documents) {
    let changed = false;
    const nodes = doc.nodes.map((node) => {
      const candidate = nodeSeatBinding(node);
      if (
        candidate === undefined ||
        candidate.hostId !== seat.hostId ||
        candidate.bindingId !== seat.bindingId
      ) {
        return node;
      }
      const updated = applyOverseerFlag(node, overseer);
      if (updated !== node) changed = true;
      return updated;
    });
    if (changed) next.set(canvasName, { ...doc, nodes });
  }
  return next;
};

/** True when creating this node would alias a live overseer binding. */
export const aliasesLiveOverseerBinding = (
  documents: ReadonlyMap<string, CanvasDoc>,
  node: CanvasNode,
): boolean => {
  const seat = nodeSeatBinding(node);
  if (seat === undefined) return false;
  return portfolioOverseerBindings(documents).has(bindingKey(seat));
};

export const nodeKindChanged = (
  previous: CanvasNode,
  next: CanvasNode,
): boolean => previous.ether?.entity?.kind !== next.ether?.entity?.kind;

export const retiresOccupant = (
  previous: CanvasNode,
  next: CanvasNode,
): boolean =>
  !occupantIdentityEquals(
    nodeOccupantIdentity(previous),
    nodeOccupantIdentity(next),
  );

export const removalIncludesCaller = (
  caller: { readonly canvasName: string; readonly nodeId: string },
  targetCanvas: string,
  removedNodeIds: ReadonlySet<string>,
): boolean =>
  caller.canvasName === targetCanvas && removedNodeIds.has(caller.nodeId);

export const canvasDeleteRetiresCaller = (
  caller: { readonly canvasName: string; readonly nodeId: string },
  targetCanvas: string,
): boolean => caller.canvasName === targetCanvas;

/** Physical (host, binding) of the live overseer seat, if it is a managed agent. */
export const callerSeatBinding = (
  documents: ReadonlyMap<string, CanvasDoc>,
  caller: { readonly canvasName: string; readonly nodeId: string },
): OverseerSeatBinding | undefined => {
  const doc = documents.get(caller.canvasName);
  if (doc === undefined) return undefined;
  const node = findNode(doc, caller.nodeId);
  return node === undefined ? undefined : nodeSeatBinding(node);
};

/**
 * True when the native removal plan would tear down the caller's managed
 * terminal. Node/canvas id checks are not enough: an alias on another canvas
 * (or a different node id on the same canvas) can share (host, binding).
 */
export const removalRetiresCallerBinding = (
  callerSeat: OverseerSeatBinding | undefined,
  resources: ReadonlyArray<OverseerDeleteResource>,
): boolean => {
  if (callerSeat === undefined) return false;
  return resources.some(
    (resource) =>
      resource.kind === "terminal" &&
      resource.bindingId === callerSeat.bindingId &&
      (resource.hostId ?? "local") === callerSeat.hostId,
  );
};

const mergeEtherPatch = (
  current: EtherNodeExtension | undefined,
  patch: OverseerNodeEtherChanges,
): EtherNodeExtension | undefined => {
  const next: Record<string, unknown> = { ...(current ?? {}) };
  const assign = <K extends keyof OverseerNodeEtherChanges>(key: K): void => {
    if (!Object.prototype.hasOwnProperty.call(patch, key)) return;
    const value = patch[key];
    if (value === null) {
      delete next[key];
      return;
    }
    if (value !== undefined) next[key] = value;
  };
  assign("entity");
  assign("region");
  assign("watch");
  assign("timer");
  assign("tasks");
  assign("sheet");
  assign("terminal");
  assign("browser");
  assign("git");
  assign("host");
  if (current?.overseer === true) next.overseer = true;
  else delete next.overseer;
  return Object.keys(next).length === 0
    ? undefined
    : (next as EtherNodeExtension);
};

const clearOptional = <T extends object, K extends keyof T>(
  node: T,
  key: K,
  present: boolean,
  value: T[K] | null | undefined,
): T => {
  if (!present) return node;
  if (value === null || value === undefined) {
    return withoutKey(node, key) as T;
  }
  return { ...node, [key]: value };
};

/** Apply a typed configure patch. Overseer grants are never taken from the patch. */
export const applyNodeChanges = (
  node: CanvasNode,
  changes: OverseerNodeChanges,
): CanvasNode => {
  let next: CanvasNode = node;
  if (changes.text !== undefined && next.type === "text") {
    next = { ...next, text: changes.text };
  }
  if (changes.file !== undefined && next.type === "file") {
    next = { ...next, file: changes.file };
  }
  if (
    Object.prototype.hasOwnProperty.call(changes, "subpath") &&
    next.type === "file"
  ) {
    next = clearOptional(next, "subpath", true, changes.subpath);
  }
  if (changes.url !== undefined && next.type === "link") {
    next = { ...next, url: changes.url };
  }
  if (Object.prototype.hasOwnProperty.call(changes, "label") && next.type === "group") {
    next = clearOptional(next, "label", true, changes.label);
  }
  if (
    Object.prototype.hasOwnProperty.call(changes, "background") &&
    next.type === "group"
  ) {
    next = clearOptional(next, "background", true, changes.background);
  }
  if (
    Object.prototype.hasOwnProperty.call(changes, "backgroundStyle") &&
    next.type === "group"
  ) {
    next = clearOptional(next, "backgroundStyle", true, changes.backgroundStyle);
  }
  if (Object.prototype.hasOwnProperty.call(changes, "color")) {
    next = clearOptional(next, "color", true, changes.color);
  }
  if (changes.ether !== undefined) {
    const ether = mergeEtherPatch(next.ether, changes.ether);
    next =
      ether === undefined
        ? (withoutKey(next, "ether") as CanvasNode)
        : { ...next, ether };
  }
  const grant = nodeHasOverseerGrant(node);
  return applyOverseerFlag(next, grant);
};

export const nodeGeometry = (
  node: CanvasNode,
  patch: {
    readonly x?: number;
    readonly y?: number;
    readonly width?: number;
    readonly height?: number;
  },
): CanvasNode => ({
  ...node,
  x: patch.x === undefined ? node.x : Math.round(patch.x),
  y: patch.y === undefined ? node.y : Math.round(patch.y),
  width: patch.width === undefined ? node.width : Math.round(patch.width),
  height: patch.height === undefined ? node.height : Math.round(patch.height),
});

export const verbsForEndpoints = (
  fromNode: CanvasNode | undefined,
  toNode: CanvasNode | undefined,
): ReadonlyArray<Verb> =>
  fromNode === undefined ||
  toNode === undefined ||
  fromNode.id === toNode.id ||
  fromNode.type === "group" ||
  toNode.type === "group" ||
  !productNodeKindEnabled(kindOfNode(fromNode)) ||
  !productNodeKindEnabled(kindOfNode(toNode))
    ? []
    : verbsForPair(kindOfNode(fromNode), kindOfNode(toNode));

/** The authored kind of a node, when this build's product gates hide it. */
export const gatedKindOf = (node: CanvasNode | undefined): string | undefined => {
  const kind = kindOfNode(node);
  return kind !== undefined && !productNodeKindEnabled(kind) ? kind : undefined;
};

/**
 * The verb a new or re-verbed edge names, when this build's product gates
 * hide it. Stored edges keep their verb; only authoring one is refused.
 */
export const gatedVerbOf = (verb: Verb | undefined): Verb | undefined =>
  verb !== undefined && !productVerbEnabled(verb) ? verb : undefined;

export const edgeVerbAdmitted = (
  fromNode: CanvasNode | undefined,
  toNode: CanvasNode | undefined,
  verb: Verb,
): boolean => verbsForEndpoints(fromNode, toNode).includes(verb);

export const flowCycleIfInvalid = (doc: CanvasDoc): string | undefined => {
  const cycle = validateFlowDag(doc);
  return cycle?.message;
};

/** Share the exact edge patch semantics between individual and batch authoring. */
export const applyEdgeChanges = (
  edge: CanvasEdge,
  changes: OverseerEdgeChanges,
): CanvasEdge => {
  let next = changes.verb === undefined
    ? edge
    : { ...edge, ether: { verb: changes.verb } };
  const fields = ["fromSide", "fromEnd", "toSide", "toEnd", "color", "label"] as const;
  for (const key of fields) {
    if (!Object.prototype.hasOwnProperty.call(changes, key)) continue;
    const value = changes[key];
    next = value === null || value === undefined
      ? withoutKey(next, key) as CanvasEdge
      : { ...next, [key]: value };
  }
  return next;
};

const schedulerChainCycle = (doc: CanvasDoc): boolean => {
  const indegrees = new Map<string, number>();
  const outgoing = new Map<string, string[]>();
  for (const edge of doc.edges) {
    if (edge.ether?.verb !== "chains") continue;
    indegrees.set(edge.fromNode, indegrees.get(edge.fromNode) ?? 0);
    indegrees.set(edge.toNode, (indegrees.get(edge.toNode) ?? 0) + 1);
    const targets = outgoing.get(edge.fromNode) ?? [];
    targets.push(edge.toNode);
    outgoing.set(edge.fromNode, targets);
  }
  const ready = [...indegrees].filter(([, degree]) => degree === 0).map(([id]) => id);
  for (let index = 0; index < ready.length; index += 1) {
    for (const target of outgoing.get(ready[index]!) ?? []) {
      const degree = indegrees.get(target)! - 1;
      indegrees.set(target, degree);
      if (degree === 0) ready.push(target);
    }
  }
  return ready.length !== indegrees.size;
};

export type OverseerCanvasBatchResult = {
  readonly canvas: string;
  readonly results: ReadonlyArray<
    | { readonly operation: "node.create" | "node.configure" | "node.move"; readonly nodeId: string }
    | { readonly operation: "edge.connect" | "edge.configure" | "edge.disconnect"; readonly edgeId: string }
  >;
};

/**
 * Build a prospective single-canvas document without effects. The caller checks
 * live authority/revision and commits this result in its one owner transaction.
 */
export const applyCanvasBatch = (
  documents: ReadonlyMap<string, CanvasDoc>,
  canvas: string,
  operations: ReadonlyArray<OverseerCanvasBatchStep>,
  mintId: (kind: "node" | "edge") => string,
):
  | { readonly ok: true; readonly doc: CanvasDoc; readonly result: OverseerCanvasBatchResult }
  | { readonly ok: false; readonly error: OverseerErrorBody } => {
  const reject = (type: OverseerErrorBody["type"], message: string) =>
    ({ ok: false as const, error: { type, message } });
  const current = documents.get(canvas);
  if (current === undefined) return reject("NotFound", `canvas "${canvas}" does not exist`);
  const nodes = new Map(current.nodes.map((node) => [node.id, node]));
  const edges = new Map(current.edges.map((edge) => [edge.id, edge]));
  const results: Array<OverseerCanvasBatchResult["results"][number]> = [];
  for (const step of operations) {
    switch (step.operation) {
      case "node.create": {
        const { ether, ...draft } = step.node;
        const { tasks, ...otherEther } = ether ?? {};
        const node: CanvasNode = {
          ...draft,
          id: draft.id ?? mintId("node"),
          ...(ether === undefined ? {} : { ether: {
            ...otherEther,
            ...(tasks === undefined ? {} : { tasks: { ...tasks, items: [] } }),
          } }),
        };
        const gated = gatedKindOf(node);
        if (gated !== undefined) {
          return reject("Forbidden", `kind "${gated}" is disabled in this Junto build`);
        }
        if (nodes.has(node.id)) return reject("InvalidArguments", `node "${node.id}" already exists`);
        nodes.set(node.id, node);
        results.push({ operation: step.operation, nodeId: node.id });
        break;
      }
      case "node.configure":
      case "node.move": {
        const node = nodes.get(step.nodeId);
        if (node === undefined) return reject("NotFound", `node "${step.nodeId}" was not found`);
        const gated = gatedKindOf(node);
        if (gated !== undefined) {
          return reject("Forbidden", `kind "${gated}" is disabled in this Junto build`);
        }
        nodes.set(node.id, step.operation === "node.configure"
          ? applyNodeChanges(node, step.changes)
          : nodeGeometry(node, step));
        results.push({ operation: step.operation, nodeId: node.id });
        break;
      }
      case "edge.connect": {
        const { verb, ...draft } = step.edge;
        const edge: CanvasEdge = { ...draft, id: draft.id ?? mintId("edge"), ether: { verb } };
        if (
          gatedKindOf(nodes.get(edge.fromNode)) !== undefined ||
          gatedKindOf(nodes.get(edge.toNode)) !== undefined
        ) {
          return reject("Forbidden", "edge touches a kind disabled in this Junto build");
        }
        if (gatedVerbOf(verb) !== undefined) {
          return reject("Forbidden", `verb "${verb}" is disabled in this Junto build`);
        }
        if (edges.has(edge.id)) return reject("InvalidArguments", `edge "${edge.id}" already exists`);
        edges.set(edge.id, edge);
        results.push({ operation: step.operation, edgeId: edge.id });
        break;
      }
      case "edge.configure":
      case "edge.disconnect": {
        const edge = edges.get(step.edgeId);
        if (edge === undefined) return reject("NotFound", `edge "${step.edgeId}" was not found`);
        if (step.operation === "edge.disconnect") edges.delete(edge.id);
        else {
          if (
            gatedKindOf(nodes.get(edge.fromNode)) !== undefined ||
            gatedKindOf(nodes.get(edge.toNode)) !== undefined
          ) {
            return reject("Forbidden", "edge touches a kind disabled in this Junto build");
          }
          const verb = step.changes.verb;
          if (verb !== edge.ether?.verb && gatedVerbOf(verb) !== undefined) {
            return reject("Forbidden", `verb "${verb}" is disabled in this Junto build`);
          }
          edges.set(edge.id, applyEdgeChanges(edge, step.changes));
        }
        results.push({ operation: step.operation, edgeId: edge.id });
        break;
      }
    }
  }

  const previousNodes = new Map(current.nodes.map((node) => [node.id, node]));
  for (const node of nodes.values()) {
    const previous = previousNodes.get(node.id);
    if (previous === undefined) {
      if (nodeHasOverseerGrant(node) || aliasesLiveOverseerBinding(documents, node)) {
        return reject("Forbidden", "canvas.batch cannot mint or inherit overseer authority");
      }
      continue;
    }
    const priorKind = previous.ether?.entity?.kind;
    const native = priorKind === "agent" || priorKind === "terminal" || priorKind === "page";
    if (native && (
      retiresOccupant(previous, node) ||
      JSON.stringify(previous.ether?.terminal) !== JSON.stringify(node.ether?.terminal) ||
      JSON.stringify(previous.ether?.browser) !== JSON.stringify(node.ether?.browser)
    )) {
      return reject("Forbidden", `canvas.batch cannot change native identity or configuration of "${node.id}"`);
    }
    if (!native && aliasesLiveOverseerBinding(documents, node)) {
      return reject("Forbidden", "canvas.batch cannot inherit overseer authority");
    }
  }

  const proposed: CanvasDoc = { ...current, nodes: [...nodes.values()], edges: [...edges.values()] };
  for (const edge of proposed.edges) {
    const fromNode = nodes.get(edge.fromNode);
    const toNode = nodes.get(edge.toNode);
    if (fromNode === undefined || toNode === undefined) {
      return reject("NotFound", `edge "${edge.id}" endpoints were not found`);
    }
    if (edge.ether?.verb === undefined || !edgeVerbAdmitted(fromNode, toNode, edge.ether.verb)) {
      return reject("InvalidArguments", `edge "${edge.id}" has no legal verb for its endpoints`);
    }
  }
  const cycle = flowCycleIfInvalid(proposed);
  if (cycle !== undefined) return reject("InvalidArguments", cycle);
  if (schedulerChainCycle(proposed)) return reject("InvalidArguments", "scheduler chains must not contain a cycle");
  const decoded = decodeCanvasDoc(proposed);
  if (Result.isFailure(decoded)) return reject("InvalidArguments", decoded.failure.message);
  return { ok: true, doc: decoded.success, result: { canvas, results } };
};

export const stripIncidentEdges = (
  doc: CanvasDoc,
  removedNodeIds: ReadonlySet<string>,
): CanvasDoc => ({
  nodes: doc.nodes.filter((node) => !removedNodeIds.has(node.id)),
  edges: doc.edges.filter(
    (edge) =>
      !removedNodeIds.has(edge.fromNode) && !removedNodeIds.has(edge.toNode),
  ),
});

export const nativeDeleteResourcesOf = (
  documents: ReadonlyMap<string, CanvasDoc>,
  targets: ReadonlyArray<{
    readonly canvasName: string;
    readonly nodeIds: ReadonlySet<string>;
  }>,
): ReadonlyArray<OverseerDeleteResource> => {
  const seen = new Set<string>();
  const resources: OverseerDeleteResource[] = [];
  const push = (resource: OverseerDeleteResource, key: string): void => {
    if (seen.has(key)) return;
    seen.add(key);
    resources.push(resource);
  };
  for (const target of targets) {
    const doc = documents.get(target.canvasName);
    if (doc === undefined) continue;
    for (const node of doc.nodes) {
      if (!target.nodeIds.has(node.id)) continue;
      const kind = node.ether?.entity?.kind;
      if (kind === "agent") {
        const agentKey = trimDefined(node.ether?.entity?.name);
        if (agentKey !== undefined) {
          push({ kind: "agent", agentKey }, `agent:${agentKey}`);
        }
        const seat = nodeSeatBinding(node);
        if (seat !== undefined) {
          push(
            { kind: "terminal", bindingId: seat.bindingId, hostId: seat.hostId },
            `terminal:${seat.hostId}\0${seat.bindingId}`,
          );
        }
      } else if (kind === "terminal") {
        const bindingId = trimDefined(node.ether?.terminal?.bindingId);
        if (bindingId !== undefined) {
          const hostId = trimDefined(node.ether?.host) ?? "local";
          push(
            { kind: "terminal", bindingId, hostId },
            `terminal:${hostId}\0${bindingId}`,
          );
        }
      } else if (kind === "page") {
        push(
          { kind: "page", canvasName: target.canvasName, nodeId: node.id },
          `page:${target.canvasName}\0${node.id}`,
        );
      }
    }
  }
  return resources;
};

export type OverseerDeleteResource =
  | { readonly kind: "agent"; readonly agentKey: string }
  | {
      readonly kind: "terminal";
      readonly bindingId: string;
      readonly hostId?: string;
    }
  | {
      readonly kind: "page";
      readonly canvasName: string;
      readonly nodeId: string;
    };
