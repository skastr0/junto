import { describe, expect, it } from "vitest";
import { decodeCanvasDoc, sanitizeWorkStores } from "../src/shared/canvas";
import { actorDeliverySurfaceOf } from "../src/shared/actor-surface";

describe("sanitize actor surface ports (PCMI)", () => {
  it("demotes illegal agent (no terminal) to furniture", () => {
    const raw = {
      nodes: [
        {
          id: "a1",
          type: "text",
          text: "orphan",
          x: 0,
          y: 0,
          width: 100,
          height: 80,
          ether: { entity: { kind: "agent", name: "local:x" } },
        },
      ],
      edges: [],
    };
    const sanitized = sanitizeWorkStores(raw) as typeof raw;
    const node = sanitized.nodes[0] as {
      ether?: { entity?: { kind?: string }; terminal?: unknown };
    };
    expect(node.ether?.entity?.kind).toBeUndefined();
    expect(node.ether?.terminal).toBeUndefined();

    const decoded = decodeCanvasDoc(raw);
    expect(decoded._tag).toBe("Right");
    if (decoded._tag === "Right") {
      expect(actorDeliverySurfaceOf(decoded.right.nodes[0]!)).toBeUndefined();
    }
  });

  it("keeps legal managed agent intact", () => {
    const raw = {
      nodes: [
        {
          id: "a1",
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
          },
        },
      ],
      edges: [],
    };
    const sanitized = sanitizeWorkStores(raw) as typeof raw;
    const ether = (sanitized.nodes[0] as { ether: Record<string, unknown> }).ether;
    expect((ether.entity as { kind: string }).kind).toBe("agent");
    expect((ether.terminal as { bindingId: string }).bindingId).toBe("bind-1");
    expect((ether.terminal as { harness: string }).harness).toBe("claude");

    const decoded = decodeCanvasDoc(raw);
    expect(decoded._tag).toBe("Right");
    if (decoded._tag === "Right") {
      const s = actorDeliverySurfaceOf(decoded.right.nodes[0]!);
      expect(s?._tag).toBe("managedAgent");
    }
  });

  it("agent with binding but no harness demotes entity; keeps raw terminal", () => {
    const raw = {
      nodes: [
        {
          id: "a1",
          type: "text",
          text: "half",
          x: 0,
          y: 0,
          width: 100,
          height: 80,
          ether: {
            entity: { kind: "agent", name: "local:x" },
            terminal: { bindingId: "bind-only" },
          },
        },
      ],
      edges: [],
    };
    const sanitized = sanitizeWorkStores(raw) as typeof raw;
    const ether = (sanitized.nodes[0] as { ether: Record<string, unknown> }).ether;
    expect(ether.entity).toBeUndefined();
    expect((ether.terminal as { bindingId: string }).bindingId).toBe("bind-only");
  });
});
