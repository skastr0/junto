import { describe, expect, it } from "vitest";
import type { CanvasNode } from "../src/shared/canvas";
import {
  actorDeliverySurfaceOf,
  deliveryTargetFromSurface,
  isManagedAgentNode,
} from "../src/shared/actor-surface";
import { deliveryTargetOf } from "../src/shared/message-delivery";
import { resolveTerminalBinding } from "../src/shared/terminal";

const managedAgent = (): CanvasNode => ({
  id: "w1",
  type: "text",
  text: "claude",
  x: 0,
  y: 0,
  width: 100,
  height: 80,
  ether: {
    entity: { kind: "agent", name: "local:claude" },
    terminal: {
      bindingId: "bind-1",
      harness: "claude",
      launch: { kind: "harness", argv: ["claude"] },
    },
    host: "local",
  },
});

const illegalAgent = (): CanvasNode => ({
  id: "bad",
  type: "text",
  text: "orphan",
  x: 0,
  y: 0,
  width: 100,
  height: 80,
  ether: {
    entity: { kind: "agent", name: "local:orphan" },
    // no terminal — illegal for agent kind
  },
});

const rawShell = (): CanvasNode => ({
  id: "sh",
  type: "text",
  text: "shell",
  x: 0,
  y: 0,
  width: 100,
  height: 80,
  ether: {
    entity: { kind: "terminal" },
    terminal: { bindingId: "bind-shell" },
  },
});

describe("actorDeliverySurfaceOf — kind-discriminated sum", () => {
  it("agent ⇒ managedAgent with required ports", () => {
    const s = actorDeliverySurfaceOf(managedAgent());
    expect(s).toEqual({
      _tag: "managedAgent",
      nodeId: "w1",
      agentKey: "local:claude",
      bindingId: "bind-1",
      harness: "claude",
      launch: { kind: "harness", argv: ["claude"] },
      hostId: "local",
    });
    expect(deliveryTargetFromSurface(s!)).toEqual({
      bindingId: "bind-1",
    });
    expect(isManagedAgentNode(managedAgent())).toBe(true);
  });

  it("agent without terminal ports is illegal — not ACP, not a surface", () => {
    expect(actorDeliverySurfaceOf(illegalAgent())).toBeUndefined();
    expect(deliveryTargetOf(illegalAgent())).toBeUndefined();
    expect(isManagedAgentNode(illegalAgent())).toBe(false);
  });

  it("terminal kind is geography — no actor surface, no inbox, still a terminal", () => {
    // Geography holds no delivery surface: a raw shell is not an actor seat.
    expect(actorDeliverySurfaceOf(rawShell())).toBeUndefined();
    expect(deliveryTargetOf(rawShell())).toBeUndefined();
    // It still resolves as a terminal to attach to — geography hosts a PTY.
    expect(resolveTerminalBinding(rawShell())).toMatchObject({
      kind: "native",
      bindingId: "bind-shell",
    });
  });

  it("deliveryTargetOf is surface-derived only (no agent key target)", () => {
    expect(deliveryTargetOf(managedAgent())).toEqual({
      bindingId: "bind-1",
    });
  });
});
