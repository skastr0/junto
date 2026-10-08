import { nodeFromDocument } from "../src/main/junto/station/frozen-from-document";
import { describe, expect, it } from "vitest";
import type { CanvasNode } from "../src/main/junto/station/frozen-document";
import {
  actorDeliverySurfaceOf,
} from "../src/main/junto/station/frozen-actor-surface";
import { deliveryTargetOf } from "../src/shared/message-delivery";
import { terminalBindingOf } from "../src/shared/terminal";

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
  });

  it("agent without terminal ports is illegal — not ACP, not a surface", () => {
    expect(actorDeliverySurfaceOf(illegalAgent())).toBeUndefined();
    expect(() => nodeFromDocument("factory", illegalAgent(), 0)).toThrow(/"bad".*canvas can hold/);
  });

  it("terminal kind is geography — no actor surface, no inbox, still a terminal", () => {
    // Geography holds no delivery surface: a raw shell is not an actor seat.
    expect(actorDeliverySurfaceOf(rawShell())).toBeUndefined();
    expect(deliveryTargetOf(nodeFromDocument("factory", rawShell(), 0))).toBeUndefined();
    // It still resolves as a terminal to attach to — geography hosts a PTY.
    expect(terminalBindingOf(nodeFromDocument("factory", rawShell(), 0))).toMatchObject({
      kind: "native",
      bindingId: "bind-shell",
    });
  });

  it("deliveryTargetOf is surface-derived only (no agent key target)", () => {
    expect(deliveryTargetOf(nodeFromDocument("factory", managedAgent(), 0))).toEqual({
      bindingId: "bind-1",
    });
  });
});
