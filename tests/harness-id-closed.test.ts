import { describe, expect, it } from "vitest";
import { decodeCanvasDoc, type EtherTerminal } from "../src/shared/canvas";
import type { ManagedAgentNode, ManagedAgentSurface } from "../src/shared/actor-surface";
import { actorDeliverySurfaceOf } from "../src/shared/actor-surface";
import {
  HARNESS_IDS,
  type HarnessId,
} from "../src/shared/managed-terminal-templates";

const agentDoc = (terminal: Record<string, unknown>) => ({
  nodes: [
    {
      id: "a1",
      type: "text",
      text: "seat",
      x: 0,
      y: 0,
      width: 100,
      height: 80,
      ether: { entity: { kind: "agent", name: "local:claude" }, terminal },
    },
  ],
  edges: [],
});

describe("HarnessId is closed at the document seam", () => {
  it("decodes every harness the template table declares", () => {
    expect(HARNESS_IDS).toEqual([
      "claude",
      "codex",
      "grok",
      "hermes",
      "pi",
      "prime-agent",
      "kimi",
      "muse",
      "devin",
      "cursor",
      "agy",
    ]);
    for (const harness of HARNESS_IDS) {
      const decoded = decodeCanvasDoc(agentDoc({ bindingId: "b1", harness }));
      expect(decoded._tag).toBe("Success");
    }
  });

  it("refuses a harness that names no template", () => {
    const decoded = decodeCanvasDoc(agentDoc({ bindingId: "b1", harness: "banana" }));
    expect(decoded._tag).toBe("Failure");
  });

  it("keeps an authored agent that has no seat — decode reads, never rewrites", () => {
    const decoded = decodeCanvasDoc({
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
    });
    expect(decoded._tag).toBe("Success");
    if (decoded._tag !== "Success") return;
    const node = decoded.success.nodes[0]!;
    expect(node.ether?.entity?.kind).toBe("agent");
    // Not a deliverable seat: the narrowing decides that, not the decoder.
    expect(actorDeliverySurfaceOf(node)).toBeUndefined();
  });
});

// ── Type-level gates ───────────────────────────────────────────────────────
// The seat's harness is required and closed. Each @ts-expect-error below is a
// compile-time assertion: remove the requirement and `bunx tsc --noEmit` fails
// with "unused '@ts-expect-error' directive".

describe("HarnessId is closed at the type level", () => {
  it("compiles only the four harness ids", () => {
    const claude: HarnessId = "claude";
    // @ts-expect-error — "banana" names no template
    const banana: HarnessId = "banana";
    // @ts-expect-error — an open string cannot stand in for the closed set
    const open: HarnessId = String("claude");
    expect([claude, banana, open].length).toBe(3);
  });

  it("requires harness on the actor seat", () => {
    const seat: ManagedAgentSurface = {
      _tag: "managedAgent",
      nodeId: "a1",
      agentKey: "local:claude",
      bindingId: "b1",
      harness: "claude",
      launch: undefined,
      hostId: "local",
    };
    // @ts-expect-error — the optional is gone: a seat without a harness is not a seat
    const seatless: ManagedAgentSurface = {
      _tag: "managedAgent",
      nodeId: "a1",
      agentKey: "local:claude",
      bindingId: "b1",
      launch: undefined,
      hostId: "local",
    };
    expect([seat, seatless].length).toBe(2);
  });

  it("requires bindingId + a real harness on the seat node", () => {
    const node: ManagedAgentNode["ether"]["terminal"] = {
      bindingId: "b1",
      harness: "claude",
    };
    // @ts-expect-error — bindingId is required on the seat
    const unbound: ManagedAgentNode["ether"]["terminal"] = { harness: "claude" };
    // @ts-expect-error — harness is required on the seat
    const harnessless: ManagedAgentNode["ether"]["terminal"] = { bindingId: "b1" };
    expect([node, unbound, harnessless].length).toBe(3);
  });

  it("closes the document field too", () => {
    const terminal: EtherTerminal = { bindingId: "b1", harness: "grok" };
    // @ts-expect-error — the document field carries HarnessId, not a free string
    const bogus: EtherTerminal = { bindingId: "b1", harness: "banana" };
    expect([terminal, bogus].length).toBe(2);
  });
});
