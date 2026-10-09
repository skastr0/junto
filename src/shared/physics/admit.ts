import { Effect, Result, HashMap, HashSet, Option, Schema } from "effect";
import { offersOf, resolveSpec, roleOf } from "./kinds";
import { grantLawForRoles, selectGrant } from "./laws";
import {
  Port,
  PortGrant,
  asNodeId,
  type NodeId,
} from "./schema";

// Pure admit: possession of undirected edge + role law + port facet, and the
// machine each end is on. Region co-membership is visibility-only — never a
// port grant. Two ends on different machines can mail each other and nothing
// else: mail waits, so it needs no live route.

export const ScopeDenialReason = Schema.Literals(["invisible", "not_connected",
"no_port",
"role_law",
"unknown_node",
/**
 * The two ends are on different machines and the port is not mail. Never
 * relayed as no_port: the seat is told the target can only be mailed.
 */
"other_machine",]);
export type ScopeDenialReason = typeof ScopeDenialReason.Type;

export class ScopeDenial extends Schema.TaggedError<ScopeDenial>()("ScopeDenial", {
  reason: ScopeDenialReason,
  caller: Schema.String,
  target: Schema.String,
  port: Schema.optionalKey(Schema.String),
  message: Schema.String,
}) {}

export class Granted extends Schema.Class<Granted>("Granted")({
  caller: Schema.String.pipe(Schema.brand("NodeId")),
  target: Schema.String.pipe(Schema.brand("NodeId")),
  /** Single alphabet with `Port` — never re-list literals here. */
  port: Port,
  grant: PortGrant,
}) {}

export type NodeMeta = {
  readonly kind: string | undefined;
  readonly isGroup: boolean;
  /**
   * A seat of another machine, as a machine holding a copy of the canvas sees
   * it. It can be mailed. It never acts from here: its seat acts on its own
   * machine, from the full row that machine holds.
   */
  readonly peer?: boolean;
};

/**
 * Snapshot of the canvas for pure admit — no live process-bind.
 * Connectivity is undirected. edgePortMask keys are undirected pair keys
 * (`min\0max`); missing key means no port attenuation (full KindSpec.offers).
 *
 * `machine` names the machine each node is on. The view of a canvas fills it
 * for every node: the name on the node's row, or the machine that edits the
 * canvas for a kind that stays with the canvas.
 */
export type CapabilityView = {
  readonly nodeMeta: HashMap.HashMap<NodeId, NodeMeta>;
  readonly connected: HashMap.HashMap<NodeId, HashSet.HashSet<NodeId>>;
  readonly regionPeers: HashMap.HashMap<NodeId, HashSet.HashSet<NodeId>>;
  readonly edgePortMask: HashMap.HashMap<string, HashSet.HashSet<Port>>;
  /** Directional grants do not gain authority from the reverse edge. */
  readonly directedEdgePortMask?: HashMap.HashMap<string, HashSet.HashSet<Port>>;
  readonly machine: HashMap.HashMap<NodeId, string>;
};

/** Stable undirected edge key for port-mask lookup. */
export const undirectedEdgeKey = (a: string, b: string): string =>
  a < b ? `${a}\0${b}` : `${b}\0${a}`;

export const directedEdgeKey = (from: string, to: string): string =>
  JSON.stringify([from, to]);

const denial = (
  reason: ScopeDenialReason,
  caller: string,
  target: string,
  message: string,
  port?: Port,
): ScopeDenial =>
  new ScopeDenial({
    reason,
    caller,
    target,
    message,
    ...(port !== undefined ? { port } : {}),
  });

const isConnected = (
  view: CapabilityView,
  caller: NodeId,
  target: NodeId,
): boolean => {
  if (caller === target) return true;
  const neighbors = HashMap.get(view.connected, caller);
  if (Option.isNone(neighbors)) return false;
  return HashSet.has(neighbors.value, target);
};

const isRegionPeer = (
  view: CapabilityView,
  caller: NodeId,
  target: NodeId,
): boolean => {
  const peers = HashMap.get(view.regionPeers, caller);
  if (Option.isNone(peers)) return false;
  return HashSet.has(peers.value, target);
};

const machineOf = (view: CapabilityView, id: NodeId): string | undefined => {
  const opt = HashMap.get(view.machine, id);
  return Option.isSome(opt) ? opt.value : undefined;
};

/** The one port that crosses machines. Mail waits, so it needs no live route. */
const CROSS_MACHINE_PORT: Port = "msg.send";

const otherMachine = (
  caller: NodeId,
  target: NodeId,
  port: Port,
  machine: string | undefined,
): ScopeDenial =>
  denial(
    "other_machine",
    caller,
    target,
    `"${target}" runs on another machine${machine === undefined ? "" : ` (${machine})`}; from here it can only be mailed`,
    port,
  );

/**
 * Ordered before ports. On one machine nothing is decided here. Across two,
 * only mail goes on to the role law, the mask and the offers; every other
 * port is denied. Which machine edits the canvas, and which opened a link,
 * do not enter. A node the view named no machine for is not known to be on
 * this one, so it is treated as on another.
 */
const checkMachines = (
  view: CapabilityView,
  caller: NodeId,
  target: NodeId,
  port: Port,
  targetIsPeer: boolean,
): ScopeDenial | undefined => {
  if (port === CROSS_MACHINE_PORT) return undefined;
  const callerMachine = machineOf(view, caller);
  const targetMachine = machineOf(view, target);
  const same =
    !targetIsPeer && callerMachine !== undefined && callerMachine === targetMachine;
  return same ? undefined : otherMachine(caller, target, port, targetMachine);
};

/**
 * Admit `caller` to invoke `port` on `target` under pure graph physics.
 * Process-bind is a separate plane (occupant) — not checked here.
 *
 * Order: nodes → peer caller → connectivity → machines → role law → ports.
 *
 * Effect Result is `Result<A, E>` (success first): Right = Granted, Left = ScopeDenial.
 */
export const admitPure = (
  view: CapabilityView,
  caller: NodeId,
  target: NodeId,
  port: Port,
): Result.Result<Granted, ScopeDenial> => {
  const callerMeta = HashMap.get(view.nodeMeta, caller);
  const targetMeta = HashMap.get(view.nodeMeta, target);

  if (Option.isNone(callerMeta) || Option.isNone(targetMeta)) {
    return Result.fail(
      denial(
        "unknown_node",
        caller,
        target,
        `unknown node "${Option.isNone(callerMeta) ? caller : target}"`,
        port,
      ),
    );
  }

  if (callerMeta.value.peer === true) {
    return Result.fail(
      denial(
        "other_machine",
        caller,
        target,
        `"${caller}" is a seat on another machine; it acts from there, not from this copy of the canvas`,
        port,
      ),
    );
  }

  if (!isConnected(view, caller, target)) {
    if (isRegionPeer(view, caller, target)) {
      return Result.fail(
        denial(
          "not_connected",
          caller,
          target,
          `region co-member "${target}" is visible but has no edge from "${caller}" — ports require a connected edge`,
          port,
        ),
      );
    }
    return Result.fail(
      denial(
        "invisible",
        caller,
        target,
        `target "${target}" is not visible from "${caller}" — no edge and not region co-members`,
        port,
      ),
    );
  }

  const machineDenial = checkMachines(view, caller, target, port, targetMeta.value.peer === true);
  if (machineDenial !== undefined) {
    return Result.fail(machineDenial);
  }

  const callerSpec = resolveSpec(callerMeta.value);
  const targetSpec = resolveSpec(targetMeta.value);
  const fromRole = roleOf(callerSpec);
  const toRole = roleOf(targetSpec);

  const law = grantLawForRoles(fromRole, toRole);
  // None is a hard role_law denial — distinct from OptIn without a mask,
  // which materializes empty and surfaces as no_port when a port is requested.
  if (law._tag === "None") {
    return Result.fail(
      denial(
        "role_law",
        caller,
        target,
        `role law denies ${fromRole} → ${toRole} for port "${port}"`,
        port,
      ),
    );
  }

  const directional = port === "verdict.post";
  const maskOpt = directional
    ? HashMap.get(
        view.directedEdgePortMask ?? HashMap.empty<string, HashSet.HashSet<Port>>(),
        directedEdgeKey(caller, target),
      )
    : HashMap.get(view.edgePortMask, undirectedEdgeKey(caller, target));
  const grant = selectGrant(
    law,
    Option.isSome(maskOpt) ? maskOpt.value : directional ? HashSet.empty<Port>() : undefined,
  );

  const offers = offersOf(targetSpec);
  if (!grant.allows(port, offers)) {
    return Result.fail(
      denial(
        "no_port",
        caller,
        target,
        `port "${port}" is not granted on edge ${caller} → ${target}`,
        port,
      ),
    );
  }

  return Result.succeed(
    new Granted({
      caller: asNodeId(caller),
      target: asNodeId(target),
      port,
      grant,
    }),
  );
};

/** Effect wrapper around admitPure (optional for Effect pipelines). */
export const admit = Effect.fn("physics.admit")(function* (
  view: CapabilityView,
  caller: NodeId,
  target: NodeId,
  port: Port,
) {
  const result = admitPure(view, caller, target, port);
  if (Result.isFailure(result)) {
    return yield* Effect.fail(result.failure);
  }
  return result.success;
});
