import { productNodeKindEnabled, productVerbEnabled } from "./features";
import { validateFlowDag } from "./flow-graph";
import {
  asNodeId,
  asWireId,
  type Canvas,
  type CanvasCommand,
  type Node,
  type NodeDraft,
  type NodeOf,
  type Wire,
} from "./model";
import { SEAT_FIELDS_MAIN_WORKS_OUT } from "./model/drafts";
import { newBinding, seatParts } from "./model/seat-parts";
import type {
  OverseerCanvasBatchStep,
  OverseerErrorBody,
} from "./overseer-control";
import { defaultVerbForPair, verbsForPair, type Verb } from "./physics/verbs";

// What an overseer may do to a canvas, as checks over the model. A write
// arrives as steps in the overseer's wire shapes; this file turns them into
// model commands, having refused whatever an overseer may not do. The model
// then decides again when the commands are sent: it is the authority, and
// these rules only say no earlier and in the overseer's own words.

export type OverseerCallerRef = {
  readonly canvasName: string;
  readonly nodeId: string;
};

/** Every canvas as the model holds it, by name. */
export type OverseerCanvases = ReadonlyMap<string, Pick<Canvas, "nodes" | "wires">>;

export type OverseerSeatBinding = {
  readonly hostId: string;
  readonly bindingId: string;
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

const bindingKey = (seat: OverseerSeatBinding): string =>
  `${seat.hostId}\0${seat.bindingId}`;

/** The session a seat or a terminal holds, by the machine it is on. */
export const sessionBindingOf = (
  node: Node | undefined,
): OverseerSeatBinding | undefined =>
  node?.kind === "agent" || node?.kind === "terminal"
    ? { hostId: node.host, bindingId: node.bindingId }
    : undefined;

const nodeAt = (
  canvases: OverseerCanvases,
  ref: OverseerCallerRef,
): Node | undefined =>
  canvases.get(ref.canvasName)?.nodes.get(asNodeId(ref.nodeId));

/** True while the calling seat still holds the operator's grant. */
export const callerGrantLive = (
  canvases: OverseerCanvases,
  caller: OverseerCallerRef,
): boolean => {
  const node = nodeAt(canvases, caller);
  return node?.kind === "agent" && node.overseer;
};

/** The session of the live overseer seat. */
export const callerSeatBinding = (
  canvases: OverseerCanvases,
  caller: OverseerCallerRef,
): OverseerSeatBinding | undefined => {
  const node = nodeAt(canvases, caller);
  return node?.kind === "agent" ? sessionBindingOf(node) : undefined;
};

const liveOverseerBindings = (canvases: OverseerCanvases): ReadonlySet<string> => {
  const live = new Set<string>();
  for (const canvas of canvases.values()) {
    for (const node of canvas.nodes.values()) {
      if (node.kind === "agent" && node.overseer) {
        live.add(bindingKey({ hostId: node.host, bindingId: node.bindingId }));
      }
    }
  }
  return live;
};

/** True when this node would share a session with a live overseer seat. */
export const aliasesLiveOverseerBinding = (
  canvases: OverseerCanvases,
  node: Node,
): boolean => {
  const session = sessionBindingOf(node);
  return session !== undefined && liveOverseerBindings(canvases).has(bindingKey(session));
};

export const removalIncludesCaller = (
  caller: OverseerCallerRef,
  targetCanvas: string,
  removedNodeIds: ReadonlySet<string>,
): boolean =>
  caller.canvasName === targetCanvas && removedNodeIds.has(caller.nodeId);

export const canvasDeleteRetiresCaller = (
  caller: OverseerCallerRef,
  targetCanvas: string,
): boolean => caller.canvasName === targetCanvas;

/**
 * True when the native removal plan would tear down the caller's session.
 * Node and canvas ids are not enough: a seat on another canvas, or another
 * node on the same one, can hold the same session.
 */
export const removalRetiresCallerBinding = (
  callerSeat: OverseerSeatBinding | undefined,
  resources: ReadonlyArray<OverseerDeleteResource>,
): boolean =>
  callerSeat !== undefined &&
  resources.some(
    (resource) =>
      resource.kind === "terminal" &&
      resource.bindingId === callerSeat.bindingId &&
      (resource.hostId ?? "local") === callerSeat.hostId,
  );

/** What has to be stopped outside the canvas before these nodes can go. */
export const nativeDeleteResourcesOf = (
  canvases: OverseerCanvases,
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
    const canvas = canvases.get(target.canvasName);
    if (canvas === undefined) continue;
    for (const node of canvas.nodes.values()) {
      if (!target.nodeIds.has(node.id)) continue;
      if (node.kind === "agent") {
        push({ kind: "agent", agentKey: node.agentKey }, `agent:${node.agentKey}`);
      }
      if (node.kind === "agent" || node.kind === "terminal") {
        push(
          { kind: "terminal", bindingId: node.bindingId, hostId: node.host },
          `terminal:${node.host}\0${node.bindingId}`,
        );
      } else if (node.kind === "page") {
        push(
          { kind: "page", canvasName: target.canvasName, nodeId: node.id },
          `page:${target.canvasName}\0${node.id}`,
        );
      }
    }
  }
  return resources;
};

/** A node's kind, when this build's product gates hide it. */
export const gatedKindOf = (node: Node | undefined): string | undefined =>
  node !== undefined && !productNodeKindEnabled(node.kind) ? node.kind : undefined;

/** The verbs a wire from one node to the other may carry in this build. */
export const verbsForEndpoints = (
  from: Node | undefined,
  to: Node | undefined,
): ReadonlyArray<Verb> =>
  from === undefined ||
  to === undefined ||
  from.id === to.id ||
  from.kind === "region" ||
  to.kind === "region" ||
  gatedKindOf(from) !== undefined ||
  gatedKindOf(to) !== undefined
    ? []
    : verbsForPair(from.kind, to.kind);

const chainsHaveCycle = (wires: Iterable<Wire>): boolean => {
  const indegrees = new Map<string, number>();
  const outgoing = new Map<string, string[]>();
  for (const wire of wires) {
    if (wire.verb !== "chains") continue;
    indegrees.set(wire.from, indegrees.get(wire.from) ?? 0);
    indegrees.set(wire.to, (indegrees.get(wire.to) ?? 0) + 1);
    outgoing.set(wire.from, [...(outgoing.get(wire.from) ?? []), wire.to]);
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

export type OverseerStepResult =
  | { readonly operation: "node.create"; readonly nodeId: string; readonly node: Node }
  | {
      readonly operation: "node.configure" | "node.move" | "node.resize";
      readonly nodeId: string;
    }
  | { readonly operation: "node.recolor"; readonly nodeIds: ReadonlyArray<string> }
  | { readonly operation: "wire.connect"; readonly wireId: string; readonly wire: Wire }
  | {
      readonly operation: "wire.configure" | "wire.disconnect";
      readonly wireId: string;
    };

export type OverseerStepsPlan =
  | {
      readonly ok: true;
      readonly commands: ReadonlyArray<CanvasCommand>;
      readonly results: ReadonlyArray<OverseerStepResult>;
    }
  | { readonly ok: false; readonly error: OverseerErrorBody };

/** What a seat's node configure may not carry, and where each is done. */
const SEAT_EDIT_REFUSALS = {
  host: "agent reseat",
  harness: "agent reseat",
  launch: "agent reseat",
} as const;

const reject = (type: OverseerErrorBody["type"], message: string) =>
  ({ ok: false as const, error: { type, message } });

/** The node a draft becomes: its id minted when absent, stacked at `z`. */
const nodeOfDraft = (
  draft: NodeDraft,
  id: string,
  z: number,
): Node | { readonly refusal: string } => {
  const placed = { id: asNodeId(id), z };
  if (draft.kind === "terminal") {
    return { ...draft, ...placed, bindingId: draft.bindingId ?? newBinding() };
  }
  if (draft.kind !== "agent") return { ...draft, ...placed } as Node;
  const { harness, host, profile, model, effort, mode, permissionMode, cwd, label, onRemove, ...frame } = draft;
  try {
    const seat: NodeOf<"agent"> = {
      ...frame,
      ...placed,
      ...seatParts({
        harness,
        host: host ?? "local",
        ...(profile === undefined ? {} : { profile }),
        ...(model === undefined ? {} : { model }),
        ...(effort === undefined ? {} : { effort }),
        ...(mode === undefined ? {} : { mode }),
        ...(permissionMode === undefined ? {} : { permissionMode }),
        ...(cwd === undefined ? {} : { cwd }),
        ...(label === undefined ? {} : { label }),
      }),
      overseer: false,
      onRemove: onRemove ?? "detach",
    };
    return seat;
  } catch (error) {
    return { refusal: error instanceof Error ? error.message : String(error) };
  }
};

/**
 * A seat draft that names what only main works out. Decoding already refused
 * it as an unknown field; this is the sentence that says what to send instead.
 */
export const seatDraftRefusal = (draft: unknown): string | undefined => {
  if (typeof draft !== "object" || draft === null) return undefined;
  const fields = draft as Record<string, unknown>;
  if (fields["kind"] !== "agent") return undefined;
  const carried = SEAT_FIELDS_MAIN_WORKS_OUT.filter((field) => field in fields);
  if (carried.length === 0) return undefined;
  const authority = carried.includes("overseer")
    ? " Only the operator makes a seat an overseer."
    : "";
  return `a seat is created by naming what it runs (harness, and profile, model, effort, mode, permissionMode, cwd as wanted); main builds the rest, so leave out ${carried.join(", ")}.${authority}`;
};

/**
 * Turn an overseer's steps on one canvas into model commands, without effect.
 * Later steps see what earlier ones made. The caller checks the live grant
 * and the sequence, and sends the commands in its one transaction.
 */
export const planOverseerSteps = (input: {
  readonly canvases: OverseerCanvases;
  readonly canvas: string;
  readonly caller: OverseerCallerRef;
  readonly steps: ReadonlyArray<OverseerCanvasBatchStep>;
  readonly mintId: (kind: string) => string;
}): OverseerStepsPlan => {
  const held = input.canvases.get(input.canvas);
  if (held === undefined) return reject("NotFound", `canvas "${input.canvas}" does not exist`);
  const nodes = new Map<string, Node>(held.nodes);
  const wires = new Map<string, Wire>(held.wires);
  let top = 0;
  for (const node of nodes.values()) top = Math.max(top, node.z + 1);
  const canvas = input.canvas as CanvasCommand["canvas"];
  const commands: CanvasCommand[] = [];
  const results: OverseerStepResult[] = [];
  let wiresChanged = false;

  const target = (id: string): Node | ReturnType<typeof reject> => {
    const node = nodes.get(id);
    if (node === undefined) return reject("NotFound", `node "${id}" was not found`);
    const gated = gatedKindOf(node);
    return gated === undefined
      ? node
      : reject("Forbidden", `kind "${gated}" is disabled in this Junto build`);
  };
  const isRefusal = (value: unknown): value is ReturnType<typeof reject> =>
    typeof value === "object" && value !== null && "ok" in value;

  for (const step of input.steps) {
    switch (step.operation) {
      case "node.create": {
        if (!productNodeKindEnabled(step.node.kind)) {
          return reject("Forbidden", `kind "${step.node.kind}" is disabled in this Junto build`);
        }
        const id = step.node.id ?? input.mintId(step.node.kind);
        if (nodes.has(id)) return reject("InvalidArguments", `node "${id}" already exists`);
        const node = nodeOfDraft(step.node, id, top);
        if ("refusal" in node) return reject("InvalidArguments", node.refusal);
        if (aliasesLiveOverseerBinding(input.canvases, node)) {
          return reject("Forbidden", "a new node cannot share a session with a live overseer seat");
        }
        top += 1;
        nodes.set(id, node);
        commands.push({ _tag: "Add", canvas, nodes: [node], wires: [] });
        results.push({ operation: step.operation, nodeId: id, node });
        break;
      }
      case "node.configure": {
        const node = target(step.nodeId);
        if (isRefusal(node)) return node;
        if (step.change.kind !== node.kind) {
          return reject(
            "InvalidArguments",
            `node "${node.id}" is a ${node.kind}, not a ${step.change.kind}; send a change whose kind is "${node.kind}"`,
          );
        }
        if (node.kind === "agent") {
          for (const [field, command] of Object.entries(SEAT_EDIT_REFUSALS)) {
            if (field in step.change) {
              return reject(
                "Forbidden",
                `node configure does not change a seat's ${field}: what a seat runs is changed with ${command}, which builds its launch`,
              );
            }
          }
        }
        const next = { ...node } as Record<string, unknown>;
        for (const [field, value] of Object.entries(step.change)) {
          if (field === "kind") continue;
          if (value === null) delete next[field];
          else next[field] = value;
        }
        nodes.set(node.id, next as unknown as Node);
        commands.push({ _tag: "Edit", canvas, id: node.id, change: step.change });
        results.push({ operation: step.operation, nodeId: node.id });
        break;
      }
      case "node.move":
      case "node.resize": {
        const node = target(step.nodeId);
        if (isRefusal(node)) return node;
        const moved =
          step.operation === "node.move"
            ? { ...node, x: Math.round(step.x), y: Math.round(step.y) }
            : { ...node, width: Math.round(step.width), height: Math.round(step.height) };
        nodes.set(node.id, moved);
        commands.push({
          _tag: "Move",
          canvas,
          moves: [{
            id: node.id,
            x: moved.x,
            y: moved.y,
            ...(step.operation === "node.resize"
              ? { size: { width: moved.width, height: moved.height } }
              : {}),
          }],
        });
        results.push({ operation: step.operation, nodeId: node.id });
        break;
      }
      case "node.recolor": {
        const ids: Array<Node["id"]> = [];
        for (const id of step.nodeIds) {
          const node = target(id);
          if (isRefusal(node)) return node;
          ids.push(node.id);
          const { color: _was, ...rest } = node;
          nodes.set(node.id, (step.color === null ? rest : { ...rest, color: step.color }) as Node);
        }
        commands.push({ _tag: "Recolor", canvas, nodes: ids, color: step.color });
        results.push({ operation: step.operation, nodeIds: ids });
        break;
      }
      case "wire.connect": {
        const from = nodes.get(step.wire.from);
        const to = nodes.get(step.wire.to);
        if (from === undefined || to === undefined) {
          return reject("NotFound", `node "${from === undefined ? step.wire.from : step.wire.to}" was not found`);
        }
        if (gatedKindOf(from) !== undefined || gatedKindOf(to) !== undefined) {
          return reject("Forbidden", "a wire cannot touch a kind disabled in this Junto build");
        }
        const verb = step.wire.verb ?? defaultVerbForPair(from.kind, to.kind);
        if (verb === undefined || !verbsForEndpoints(from, to).includes(verb)) {
          return reject(
            "InvalidArguments",
            verb === undefined
              ? `no verb joins a ${from.kind} to a ${to.kind}`
              : `verb "${verb}" does not join a ${from.kind} to a ${to.kind}; wire verbs lists the ones that do`,
          );
        }
        if (!productVerbEnabled(verb)) {
          return reject("Forbidden", `verb "${verb}" is disabled in this Junto build`);
        }
        const id = step.wire.id ?? input.mintId("wire");
        if (wires.has(id)) return reject("InvalidArguments", `wire "${id}" already exists`);
        const wire: Wire = { ...step.wire, id: asWireId(id), verb };
        wires.set(id, wire);
        wiresChanged = true;
        commands.push({ _tag: "Add", canvas, nodes: [], wires: [wire] });
        results.push({ operation: step.operation, wireId: id, wire });
        break;
      }
      case "wire.configure": {
        const wire = wires.get(step.wireId);
        if (wire === undefined) return reject("NotFound", `wire "${step.wireId}" was not found`);
        const from = nodes.get(wire.from);
        const to = nodes.get(wire.to);
        if (gatedKindOf(from) !== undefined || gatedKindOf(to) !== undefined) {
          return reject("Forbidden", "a wire cannot touch a kind disabled in this Junto build");
        }
        const verb = step.change.verb;
        if (verb !== undefined && verb !== wire.verb) {
          if (!productVerbEnabled(verb)) {
            return reject("Forbidden", `verb "${verb}" is disabled in this Junto build`);
          }
          if (!verbsForEndpoints(from, to).includes(verb)) {
            return reject(
              "InvalidArguments",
              `verb "${verb}" does not join a ${from?.kind ?? "missing node"} to a ${to?.kind ?? "missing node"}; wire verbs lists the ones that do`,
            );
          }
        }
        const next = { ...wire } as Record<string, unknown>;
        for (const [field, value] of Object.entries(step.change)) {
          if (value === null) delete next[field];
          else next[field] = value;
        }
        wires.set(wire.id, next as unknown as Wire);
        wiresChanged = true;
        commands.push({ _tag: "Rewire", canvas, id: wire.id, change: step.change });
        results.push({ operation: step.operation, wireId: wire.id });
        break;
      }
      case "wire.disconnect": {
        const wire = wires.get(step.wireId);
        if (wire === undefined) return reject("NotFound", `wire "${step.wireId}" was not found`);
        wires.delete(wire.id);
        commands.push({ _tag: "Remove", canvas, nodes: [], wires: [wire.id] });
        results.push({ operation: step.operation, wireId: wire.id });
        break;
      }
    }
  }

  if (wiresChanged) {
    const cycle = validateFlowDag({ wires: wires as unknown as Canvas["wires"] });
    if (cycle !== undefined) return reject("InvalidArguments", cycle.message);
    if (chainsHaveCycle(wires.values())) {
      return reject("InvalidArguments", "scheduler chains must not contain a cycle");
    }
  }
  return { ok: true, commands, results };
};
