/**
 * Actor delivery surfaces — disjoint sum type.
 *
 * Law: the entity kind *is* the surface discriminant. Ports are derived from
 * the tag by exhaustiveness — never by "if terminal else if ACP".
 *
 *   agent    → managed terminal seat (bindingId required; harness required)
 *   terminal → raw shell geography (bindingId required; not an agent factory seat)
 *
 * Geography has no delivery surface at all — herdr is geography, so it holds
 * no inbox and appears in no arm below.
 *
 * ACP is not a tag. It is not a port. It is not a fallback.
 */

import { Match } from "effect";
import type { CanvasNode, EtherTerminal } from "./canvas";
import { isGroup } from "./graph";
import type { HarnessId } from "./managed-terminal-templates";
import { resolveSpec, type ActorKindName } from "./physics";

// ── Sum type ───────────────────────────────────────────────────────────────

export type ManagedAgentSurface = {
  readonly _tag: "managedAgent";
  readonly nodeId: string;
  /** Corpus join key / process-bind seat label (`<host>:<profile|harness>`). */
  readonly agentKey: string;
  readonly bindingId: string;
  /** Required and closed: an actor seat always names a real harness template. */
  readonly harness: HarnessId;
  readonly launch: EtherTerminal["launch"];
  readonly hostId: string;
};

/**
 * Every product path that *delivers* to an actor seat must switch on this.
 * Adding a surface without a case is a compile error at call sites that
 * use `Match` / exhaustive switch.
 *
 * One actor kind ⇒ one surface. A raw user-opened terminal is geography: it
 * holds no inbox, so it is not a delivery target.
 */
export type ActorDeliverySurface = ManagedAgentSurface;

// ── Narrowed document nodes ────────────────────────────────────────────────

/**
 * Authorial agent seat: kind agent ⇒ managed terminal is part of the type,
 * not an optional bolt-on. Illegal without bindingId + harness + name.
 *
 * `harness` is required *and* a closed `HarnessId` here — the seat is the
 * place the requirement lives. The decoder keeps the document as authored
 * (an agent without a seat stays an agent in the file); it is this narrowing
 * that decides whether the node is a deliverable actor.
 */
export type ManagedAgentNode = CanvasNode & {
  readonly ether: {
    readonly entity: { readonly kind: "agent"; readonly name: string };
    readonly terminal: EtherTerminal & {
      readonly bindingId: string;
      readonly harness: HarnessId;
    };
    readonly host?: string;
  };
};

export const isManagedAgentNode = (node: CanvasNode): node is ManagedAgentNode => {
  if (node.ether?.entity?.kind !== "agent") return false;
  const name = node.ether.entity.name?.trim();
  const bindingId = node.ether.terminal?.bindingId?.trim();
  return Boolean(name && bindingId && node.ether.terminal?.harness);
};

// ── Decode from document ───────────────────────────────────────────────────

/**
 * Decode the actor delivery surface from a canvas node.
 *
 * Role decides participation (only actors have a delivery surface) and the
 * actor kind decides which surface — both from the one `resolveSpec` call, so
 * this file never re-lists which kinds are actors. Returns undefined for
 * non-actors and for **illegal** agent/terminal shapes (missing required ports
 * for that kind). Never invents ACP.
 */
export const actorDeliverySurfaceOf = (
  node: CanvasNode,
): ActorDeliverySurface | undefined => {
  const hostId =
    (typeof node.ether?.host === "string" && node.ether.host.trim().length > 0
      ? node.ether.host.trim()
      : undefined) ?? "local";

  const actorSurface = (kind: ActorKindName): ActorDeliverySurface | undefined => {
    switch (kind) {
      case "agent": {
        // Agent *is* a managed terminal seat. No second surface.
        const agentKey = node.ether?.entity?.name?.trim();
        const bindingId = node.ether?.terminal?.bindingId?.trim();
        const harness = node.ether?.terminal?.harness;
        if (!agentKey || !bindingId || !harness) {
          // Authored agent without a seat: not deliverable. The document keeps
          // what it says; only this resolution refuses to call it an actor seat.
          return undefined;
        }
        return {
          _tag: "managedAgent",
          nodeId: node.id,
          agentKey,
          bindingId,
          harness,
          launch: node.ether?.terminal?.launch,
          hostId,
        };
      }
      default: {
        const exhaustive: never = kind;
        return exhaustive;
      }
    }
  };

  return Match.value(
    resolveSpec({
      isGroup: isGroup(node),
      kind: node.ether?.entity?.kind,
    }),
  ).pipe(
    Match.tagsExhaustive({
      Actor: (spec) => actorSurface(spec.kind),
      Sink: () => undefined,
      Scheduler: () => undefined,
      Geography: () => undefined,
    }),
  );
};

/**
 * The wire delivery target. One actor kind ⇒ one surface ⇒ one target shape,
 * so there is no discriminant left to carry.
 */
export type SurfaceDeliveryTarget = {
  readonly bindingId: string;
};

export const deliveryTargetFromSurface = (
  surface: ActorDeliverySurface,
): SurfaceDeliveryTarget => {
  return { bindingId: surface.bindingId };
};
