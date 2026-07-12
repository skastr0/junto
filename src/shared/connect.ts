import type { CanvasDoc, CanvasEdge } from "./canvas";
import { parseGlyphKey, parseSignalKey } from "./refs";

// Provenance edges derived from real data — the "trace connections" surface.
// Opt-in (a tool you run), idempotent, additive: it only ever adds `relates`
// edges that don't already exist, never removes or moves anything you drew.
//
// Two relationships, both facts already latent in the bindings on the canvas:
//   - a drilled glyph/signal node  --in-->   its project node
//   - a signal node               --from--> the fleet agent that emitted it
//     (needs the live signal→agent map, since the agent isn't stored on the node)

export interface ConnectOptions {
  // signalId -> emitting agent's profile name (e.g. "profile-09"), from live data.
  readonly signalAgents?: Record<string, string>;
}

const edgeId = (from: string, to: string): string =>
  `conn-${from}-${to}`.replace(/[^a-zA-Z0-9-]/g, "-").slice(0, 120);

export const deriveConnections = (doc: CanvasDoc, opts: ConnectOptions = {}): CanvasEdge[] => {
  // Index the canvas: which node carries which project / which agent profile.
  const projectNode = new Map<string, string>();
  const agentByProfile = new Map<string, string>();
  for (const node of doc.nodes) {
    for (const binding of node.ether?.bindings ?? []) {
      if (binding.source === "tower" && binding.ref.type === "project") {
        projectNode.set(binding.ref.key, node.id);
      }
      if (binding.source === "hermes" && binding.ref.type === "agent") {
        const profile = binding.ref.key.split(":").pop();
        if (profile) agentByProfile.set(profile, node.id);
      }
    }
  }

  const existing = new Set(doc.edges.map((e) => `${e.fromNode}->${e.toNode}`));
  const out: CanvasEdge[] = [];
  const add = (from: string, to: string, label: string) => {
    if (from === to) return;
    const key = `${from}->${to}`;
    if (existing.has(key)) return;
    existing.add(key);
    out.push({ id: edgeId(from, to), fromNode: from, toNode: to, label, ether: { kind: "relates" } });
  };

  for (const node of doc.nodes) {
    for (const binding of node.ether?.bindings ?? []) {
      if (binding.source !== "tower") continue;
      if (binding.ref.type === "glyph") {
        const ref = parseGlyphKey(binding.ref.key);
        const target = ref && projectNode.get(ref.project);
        if (target) add(node.id, target, "in");
      }
      if (binding.ref.type === "signal") {
        const ref = parseSignalKey(binding.ref.key);
        if (!ref) continue;
        const target = projectNode.get(ref.project);
        if (target) add(node.id, target, "in");
        const profile = opts.signalAgents?.[ref.signalId];
        const agentNode = profile ? agentByProfile.get(profile) : undefined;
        if (agentNode) add(node.id, agentNode, "from");
      }
    }
  }
  return out;
};

export const connectDoc = (doc: CanvasDoc, opts: ConnectOptions = {}): CanvasDoc => ({
  nodes: doc.nodes,
  edges: [...doc.edges, ...deriveConnections(doc, opts)],
});
