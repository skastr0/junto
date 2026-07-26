import { describe, expect, it } from "vitest";
import type { CanvasNode } from "../src/shared/canvas";
import {
  actorDeliverySurfaceOf,
  deliveryTargetFromSurface,
  isManagedAgentNode,
} from "../src/shared/actor-surface";
import { deliveryTargetOf } from "../src/shared/message-delivery";

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
      kind: "terminal",
      bindingId: "bind-1",
    });
    expect(isManagedAgentNode(managedAgent())).toBe(true);
  });

  it("agent without terminal ports is illegal — not ACP, not a surface", () => {
    expect(actorDeliverySurfaceOf(illegalAgent())).toBeUndefined();
    expect(deliveryTargetOf(illegalAgent())).toBeUndefined();
    expect(isManagedAgentNode(illegalAgent())).toBe(false);
  });

  it("terminal kind ⇒ rawTerminal (geography), not managedAgent", () => {
    const s = actorDeliverySurfaceOf(rawShell());
    expect(s?._tag).toBe("rawTerminal");
    if (s?._tag === "rawTerminal") {
      expect(s.bindingId).toBe("bind-shell");
    }
  });

  it("deliveryTargetOf is surface-derived only (no agent key target)", () => {
    expect(deliveryTargetOf(managedAgent())).toEqual({
      kind: "terminal",
      bindingId: "bind-1",
    });
  });
});
