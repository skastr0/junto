/**
 * Actor delivery surfaces — disjoint sum type.
 *
 * Law: the entity kind *is* the surface discriminant. Ports are derived from
 * the tag by exhaustiveness — never by "if terminal else if ACP".
 *
 *   agent    → managed terminal seat (bindingId required; harness required)
 *   terminal → raw shell geography (bindingId required; not an agent factory seat)
 *   herdr    → legacy herdr pane (hard-hidden; separate tag until removed)
 *
 * ACP is not a tag. It is not a port. It is not a fallback.
 */

import type { CanvasNode, EtherTerminal } from "./canvas";

// ── Sum type ───────────────────────────────────────────────────────────────

export type ManagedAgentSurface = {
  readonly _tag: "managedAgent";
  readonly nodeId: string;
  /** Corpus join key / process-bind seat label (`<host>:<profile|harness>`). */
  readonly agentKey: string;
  readonly bindingId: string;
  readonly harness: string;
  readonly launch: EtherTerminal["launch"];
  readonly hostId: string;
};

export type RawTerminalSurface = {
  readonly _tag: "rawTerminal";
  readonly nodeId: string;
  readonly bindingId: string;
  readonly hostId: string;
  readonly launch: EtherTerminal["launch"];
};

/** Hard-hidden legacy. Own tag so it never collides with managedAgent. */
export type LegacyHerdrSurface = {
  readonly _tag: "legacyHerdr";
  readonly nodeId: string;
  readonly terminalId: string;
  readonly hostId: string;
};

/**
 * Every product path that *delivers* to an actor seat must switch on this.
 * Adding a surface without a case is a compile error at call sites that
 * use `Match` / exhaustive switch.
 */
export type ActorDeliverySurface =
  | ManagedAgentSurface
  | RawTerminalSurface
  | LegacyHerdrSurface;

// ── Narrowed document nodes ────────────────────────────────────────────────

/**
 * Authorial agent seat: kind agent ⇒ managed terminal is part of the type,
 * not an optional bolt-on. Illegal without bindingId + harness + name.
 */
export type ManagedAgentNode = CanvasNode & {
  readonly ether: {
    readonly entity: { readonly kind: "agent"; readonly name: string };
    readonly terminal: EtherTerminal & {
      readonly bindingId: string;
      readonly harness: string;
    };
    readonly host?: string;
  };
};

export const isManagedAgentNode = (node: CanvasNode): node is ManagedAgentNode => {
  if (node.ether?.entity?.kind !== "agent") return false;
  const name = node.ether.entity.name?.trim();
  const bindingId = node.ether.terminal?.bindingId?.trim();
  const harness = node.ether.terminal?.harness?.trim();
  return Boolean(name && bindingId && harness);
};

// ── Decode from document ───────────────────────────────────────────────────

/**
 * Decode the actor delivery surface from a canvas node.
 * Returns undefined only for non-actors or **illegal** agent/terminal shapes
 * (missing required ports for that kind). Never invents ACP.
 */
export const actorDeliverySurfaceOf = (
  node: CanvasNode,
): ActorDeliverySurface | undefined => {
  const kind = node.ether?.entity?.kind;
  const hostId =
    (typeof node.ether?.host === "string" && node.ether.host.trim().length > 0
      ? node.ether.host.trim()
      : undefined) ?? "local";

  switch (kind) {
    case "agent": {
      // Agent *is* a managed terminal seat. No second surface.
      const agentKey = node.ether?.entity?.name?.trim();
      const bindingId = node.ether?.terminal?.bindingId?.trim();
      const harness = node.ether?.terminal?.harness?.trim();
      if (!agentKey || !bindingId || !harness) {
        // Illegal document: agent without managed terminal ports.
        // Callers treat as non-deliverable furniture until sanitize repairs/rejects.
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
    case "terminal": {
      const bindingId = node.ether?.terminal?.bindingId?.trim();
      if (!bindingId) return undefined;
      return {
        _tag: "rawTerminal",
        nodeId: node.id,
        bindingId,
        hostId,
        launch: node.ether?.terminal?.launch,
      };
    }
    case "herdr": {
      const terminalId = node.ether?.herdr?.terminalId?.trim();
      if (!terminalId) return undefined;
      const herdrHost = node.ether?.herdr?.host?.trim();
      return {
        _tag: "legacyHerdr",
        nodeId: node.id,
        terminalId,
        hostId: herdrHost && herdrHost.length > 0 ? herdrHost : hostId,
      };
    }
    default:
      return undefined;
  }
};

/** Exhaustive delivery target derived from the surface tag alone. */
export type SurfaceDeliveryTarget =
  | { readonly kind: "terminal"; readonly bindingId: string }
  | { readonly kind: "herdr"; readonly terminalId: string };

export const deliveryTargetFromSurface = (
  surface: ActorDeliverySurface,
): SurfaceDeliveryTarget => {
  switch (surface._tag) {
    case "managedAgent":
    case "rawTerminal":
      return { kind: "terminal", bindingId: surface.bindingId };
    case "legacyHerdr":
      return { kind: "herdr", terminalId: surface.terminalId };
    default: {
      const _exhaustive: never = surface;
      return _exhaustive;
    }
  }
};
