import { Effect, Either, HashMap, HashSet, Option, Schema } from "effect";
import { offersOf, resolveSpec, roleOf } from "./kinds";
import { grantLawForRoles, selectGrant } from "./laws";
import {
  PortGrant,
  asNodeId,
  type NodeId,
  type Port,
} from "./schema";

// Pure admit: possession of undirected edge + role law + port facet.
// Region co-membership is visibility-only — never a port grant.

export const ScopeDenialReason = Schema.Literal(
  "invisible",
  "not_connected",
  "no_port",
  "role_law",
  "unknown_node",
);
export type ScopeDenialReason = typeof ScopeDenialReason.Type;

export class ScopeDenial extends Schema.TaggedError<ScopeDenial>()("ScopeDenial", {
  reason: ScopeDenialReason,
  caller: Schema.String,
  target: Schema.String,
  port: Schema.optionalWith(Schema.String, { exact: true }),
  message: Schema.String,
}) {}

export class Granted extends Schema.Class<Granted>("Granted")({
  caller: Schema.String.pipe(Schema.brand("NodeId")),
  target: Schema.String.pipe(Schema.brand("NodeId")),
  port: Schema.Literal(
    "tasks.list",
    "tasks.claim",
    "tasks.update",
    "msg.list",
    "msg.send",
    "request.create",
    "artifact.publish",
    "browser.automate",
  ),
  grant: PortGrant,
}) {}

export type NodeMeta = {
  readonly kind: string | undefined;
  readonly isGroup: boolean;
};

/**
 * Snapshot of the canvas for pure admit — no live process-bind.
 * Connectivity is undirected. edgePortMask keys are undirected pair keys
 * (`min\0max`); missing key means no port attenuation (full KindSpec.offers).
 */
export type CapabilityView = {
  readonly nodeMeta: HashMap.HashMap<NodeId, NodeMeta>;
  readonly connected: HashMap.HashMap<NodeId, HashSet.HashSet<NodeId>>;
  readonly regionPeers: HashMap.HashMap<NodeId, HashSet.HashSet<NodeId>>;
  readonly edgePortMask: HashMap.HashMap<string, HashSet.HashSet<Port>>;
};

/** Stable undirected edge key for port-mask lookup. */
export const undirectedEdgeKey = (a: string, b: string): string =>
  a < b ? `${a}\0${b}` : `${b}\0${a}`;

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

/**
 * Admit `caller` to invoke `port` on `target` under pure graph physics.
 * Process-bind is a separate plane (occupant) — not checked here.
 *
 * Effect Either is `Either<A, E>` (success first): Right = Granted, Left = ScopeDenial.
 */
export const admitPure = (
  view: CapabilityView,
  caller: NodeId,
  target: NodeId,
  port: Port,
): Either.Either<Granted, ScopeDenial> => {
  const callerMeta = HashMap.get(view.nodeMeta, caller);
  const targetMeta = HashMap.get(view.nodeMeta, target);

  if (Option.isNone(callerMeta) || Option.isNone(targetMeta)) {
    return Either.left(
      denial(
        "unknown_node",
        caller,
        target,
        `unknown node "${Option.isNone(callerMeta) ? caller : target}"`,
        port,
      ),
    );
  }

  if (!isConnected(view, caller, target)) {
    if (isRegionPeer(view, caller, target)) {
      return Either.left(
        denial(
          "not_connected",
          caller,
          target,
          `region co-member "${target}" is visible but has no edge from "${caller}" — ports require a connected edge`,
          port,
        ),
      );
    }
    return Either.left(
      denial(
        "invisible",
        caller,
        target,
        `target "${target}" is not visible from "${caller}" — no edge and not region co-members`,
        port,
      ),
    );
  }

  const callerSpec = resolveSpec(callerMeta.value);
  const targetSpec = resolveSpec(targetMeta.value);
  const fromRole = roleOf(callerSpec);
  const toRole = roleOf(targetSpec);

  const law = grantLawForRoles(fromRole, toRole);
  // None is a hard role_law denial — distinct from OptIn without a mask,
  // which materializes empty and surfaces as no_port when a port is requested.
  if (law._tag === "None") {
    return Either.left(
      denial(
        "role_law",
        caller,
        target,
        `role law denies ${fromRole} → ${toRole} for port "${port}"`,
        port,
      ),
    );
  }

  const maskKey = undirectedEdgeKey(caller, target);
  const maskOpt = HashMap.get(view.edgePortMask, maskKey);
  const grant = selectGrant(
    law,
    Option.isSome(maskOpt) ? maskOpt.value : undefined,
  );

  const offers = offersOf(targetSpec);
  if (!grant.allows(port, offers)) {
    return Either.left(
      denial(
        "no_port",
        caller,
        target,
        `port "${port}" is not granted on edge ${caller} → ${target}`,
        port,
      ),
    );
  }

  return Either.right(
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
  if (Either.isLeft(result)) {
    return yield* Effect.fail(result.left);
  }
  return result.right;
});
