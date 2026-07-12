import { describe, expect, it } from "vitest";
import { Either } from "effect";
import { decodeCanvasDoc, type CanvasDoc } from "../src/shared/canvas";
import { explodeSignalsInto, type ExplodeSignal } from "../src/shared/explode";
import { parseSignalKey, signalKey } from "../src/shared/refs";

const signals: ReadonlyArray<ExplodeSignal> = [
  {
    project: "prism",
    orbit: "forge",
    signalId: "sig_905c410397ec224978b18721",
    status: "consumed",
    kind: "prism.workflow_runtime.architecture_requested",
    summary: "Explore a Prism-native, ledger-attested workflow runtime with strict typed authoring.",
  },
  {
    project: "prism",
    orbit: "forge",
    signalId: "sig_abc123",
    status: "inbox",
    kind: "exploration",
    summary: "Short summary",
    sourceAgent: "kimi-code",
  },
  {
    project: "prism",
    orbit: "beacon",
    signalId: "sig_beacon001",
    status: "dead",
    kind: "review",
    summary: "Beacon-side review signal",
  },
  // Different project — must be ignored by explodeSignalsInto(doc, "prism", ...).
  {
    project: "vouch",
    orbit: "forge",
    signalId: "sig_b745960cd922dc06e3924af8",
    status: "consumed",
    kind: "work-delivered",
    summary: "Tower backfill complete",
  },
];

describe("explodeSignalsInto", () => {
  it("produces a valid JSON Canvas document", () => {
    const doc = explodeSignalsInto({ nodes: [], edges: [] }, "prism", signals);
    expect(Either.isRight(decodeCanvasDoc(doc))).toBe(true);
  });

  it("creates one group node per orbit present in the signal list", () => {
    const doc = explodeSignalsInto({ nodes: [], edges: [] }, "prism", signals);
    const groups = doc.nodes.filter((n) => n.type === "group");
    expect(groups.map((g) => g.id).sort()).toEqual(["sig-grp-prism-beacon", "sig-grp-prism-forge"]);
  });

  it("never includes signals from another project", () => {
    const doc = explodeSignalsInto({ nodes: [], edges: [] }, "prism", signals);
    const groups = doc.nodes.filter((n) => n.type === "group");
    expect(groups.find((g) => g.id.includes("vouch"))).toBeUndefined();
    expect(doc.nodes.find((n) => n.id.includes("b745960c"))).toBeUndefined();
  });

  it("binds each signal node with a key equal to signalKey(project, orbit, signalId)", () => {
    const doc = explodeSignalsInto({ nodes: [], edges: [] }, "prism", signals);
    const forgeSignals = signals.filter((s) => s.project === "prism" && s.orbit === "forge");
    for (const signal of forgeSignals) {
      const node = doc.nodes.find((n) =>
        n.ether?.bindings?.some(
          (b) => b.source === "tower" && b.ref.type === "signal" && b.ref.key === signalKey("prism", "forge", signal.signalId),
        ),
      );
      expect(node, `expected a node bound to ${signal.signalId}`).toBeDefined();
      expect(node?.type).toBe("text");
      expect(node?.ether?.entity?.kind).toBe("signal");
    }
  });

  it("truncates a long summary to ~36 chars in the node text", () => {
    const longSummary = "A".repeat(80);
    const doc = explodeSignalsInto(
      { nodes: [], edges: [] },
      "prism",
      [{ project: "prism", orbit: "forge", signalId: "sig_999", status: "inbox", kind: "exploration", summary: longSummary }],
    );
    const node = doc.nodes.find((n) => n.id === "sig-prism-forge-sig-999");
    expect(node?.type).toBe("text");
    expect(node && "text" in node ? node.text.length : 0).toBeLessThan(60);
  });

  it("preserves all existing nodes and edges", () => {
    const existing: CanvasDoc = {
      nodes: [{ id: "n1", type: "text", text: "keep me", x: 0, y: 0, width: 100, height: 40 }],
      edges: [],
    };
    const doc = explodeSignalsInto(existing, "prism", signals);
    expect(doc.nodes.find((n) => n.id === "n1")).toBeDefined();
  });

  it("is idempotent: running twice adds no new nodes", () => {
    const first = explodeSignalsInto({ nodes: [], edges: [] }, "prism", signals);
    const again = explodeSignalsInto(first, "prism", signals);
    expect(again.nodes.length).toBe(first.nodes.length);
    expect(again.nodes.map((n) => n.id).sort()).toEqual(first.nodes.map((n) => n.id).sort());
  });

  it("skips an orbit entirely when there are no signals for it", () => {
    const doc = explodeSignalsInto({ nodes: [], edges: [] }, "prism", []);
    expect(doc.nodes.length).toBe(0);
  });
});

describe("signal ref key round-trip", () => {
  it("parseSignalKey(signalKey(...)) recovers the original triple", () => {
    const key = signalKey("prism", "forge", "sig_905c410397ec224978b18721");
    expect(parseSignalKey(key)).toEqual({ project: "prism", orbit: "forge", signalId: "sig_905c410397ec224978b18721" });
  });

  it("parseSignalKey rejects a non-signal key", () => {
    expect(parseSignalKey("glyph:prism/forge/WFE-010")).toBeUndefined();
    expect(parseSignalKey("prism")).toBeUndefined();
  });
});
