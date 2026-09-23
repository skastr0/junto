/**
 * T0 QA surface registry: every customer-facing surface the audit specs walk
 * (`design-audit.spec.ts`, `product-stupidity-audit.spec.ts`), the actions
 * that reach it, the invariants each probe must hold, and the context axes it
 * runs under. The runner samples this space pairwise; it never enumerates the
 * full cross product, and it never calls a model.
 *
 * One scene is seeded per launch: one node of every product-creatable kind and
 * one edge of every verb family the scene can hold.
 */
import type { CanvasEdge, CanvasNode } from "../../src/shared/canvas";
import {
  agentTextNode,
  artifactsNode,
  canvasDoc,
  requestsNode,
  taskItem,
  tasksNode,
} from "../harness/sandbox";

export const QA_CANVAS = "qa-t0";

// --- scene -------------------------------------------------------------------

const agent1 = agentTextNode({ id: "agent1", key: "local:claude", label: "Claude Code - fable", x: 0, y: 0 });
const agent2 = agentTextNode({ id: "agent2", key: "local:codex", label: "Codex - gpt-5.6", x: 0, y: 320 });

const tasks: CanvasNode = {
  ...tasksNode({
    id: "tasks",
    x: 520,
    y: 0,
    items: [
      taskItem("t1", "Ship the edge sheet v2", "submitted"),
      taskItem("t2", "Repaint the wire temperature ramp", "submitted"),
    ],
  }),
  width: 260,
  height: 180,
};

const tasks2: CanvasNode = {
  ...tasksNode({ id: "tasks2", x: 1040, y: 320, items: [taskItem("rv1", "Review wires hotfix", "submitted")] }),
  width: 260,
  height: 140,
};

const requests = requestsNode({
  id: "requests",
  x: 1560,
  y: 640,
  items: [taskItem("rq1", "Need prod API key to continue", "input-required")],
});

const artifacts = artifactsNode({ id: "artifacts", x: 1560, y: 320 });

const board: CanvasNode = {
  id: "board", type: "text", text: "board", x: 520, y: 320, width: 240, height: 130,
  ether: { entity: { kind: "board" }, board: { topics: [], unread: 2 } },
};

const relay: CanvasNode = {
  id: "relay", type: "text", text: "relay", x: 1040, y: 0, width: 220, height: 100,
  ether: { entity: { kind: "relay" }, host: "local" },
};

const cron: CanvasNode = {
  id: "cron", type: "text", text: "cron", x: 1560, y: 0, width: 220, height: 96,
  ether: { entity: { kind: "cron" }, host: "local", timer: { expression: "*/30 * * * *", everyMinutes: 30 } },
};

const note: CanvasNode = {
  id: "note", type: "text", text: "release checklist\n\n- edge sheets\n- copy pass", x: 0, y: 640, width: 240, height: 140,
};

const label: CanvasNode = {
  id: "label", type: "text", text: "label\nNORTH WING", x: 2080, y: 640, width: 220, height: 60,
  ether: { entity: { kind: "label" } },
};

const page1 = {
  id: "page1", type: "link", url: "https://example.com", x: 520, y: 640, width: 260, height: 110,
  ether: { entity: { kind: "page" }, host: "local", browser: { profile: "personal", onDelete: "kill-session" } },
} as unknown as CanvasNode;

const terminal: CanvasNode = {
  id: "terminal", type: "text", text: "terminal", x: 1040, y: 640, width: 260, height: 110,
  ether: { entity: { kind: "terminal" }, host: "local", terminal: { bindingId: "qa-term-1", label: "terminal" } },
};

const NODES: ReadonlyArray<CanvasNode> = [
  agent1, agent2, tasks, tasks2, requests, artifacts, board, relay, cron, note, label, page1, terminal,
];

const EDGES: ReadonlyArray<CanvasEdge> = [
  { id: "e-claim", fromNode: "agent1", toNode: "tasks", fromSide: "right", toSide: "left", ether: { verb: "contributes" } },
  { id: "e-mail", fromNode: "agent1", toNode: "agent2", fromSide: "bottom", toSide: "top", ether: { verb: "messages" } },
  { id: "e-wake", fromNode: "agent2", toNode: "board", fromSide: "right", toSide: "left", ether: { verb: "participates" } },
  { id: "e-esc", fromNode: "agent2", toNode: "requests", fromSide: "bottom", toSide: "left", ether: { verb: "escalates" } },
  { id: "e-watch", fromNode: "tasks", toNode: "relay", fromSide: "right", toSide: "left", ether: { verb: "announces" } },
  { id: "e-fire", fromNode: "relay", toNode: "tasks2", fromSide: "bottom", toSide: "top", ether: { verb: "enqueues" } },
];

export const qaScene = () => canvasDoc(NODES, EDGES);

// --- axes --------------------------------------------------------------------

/** How a probe reaches its surface. */
export type ActionId =
  | "select" // single click: the RTS command bar reads the selection
  | "open" // double click: the detail surface for the kind
  | "palette-tabs" // open the add-item deck and walk every tab
  | "settings-sections"; // open settings and walk every section

export type SurfaceKind = "node" | "edge" | "shell";

export interface Surface {
  /** Stable id; part of every finding's fingerprint. */
  readonly id: string;
  readonly kind: SurfaceKind;
  /** Node id or edge id in the scene; absent for shell surfaces. */
  readonly target?: string;
  readonly actions: ReadonlyArray<ActionId>;
  /** Persistent work surfaces ignore Escape and close through their close button. */
  readonly dismiss: "escape" | "close-button";
}

const nodeSurface = (
  id: string,
  target: string,
  actions: ReadonlyArray<ActionId>,
  dismiss: Surface["dismiss"] = "escape",
): Surface => ({ id, kind: "node", target, actions, dismiss });

const edgeSurface = (edge: CanvasEdge): Surface => ({
  id: `edge:${edge.ether?.verb ?? edge.id}`,
  kind: "edge",
  target: edge.id,
  actions: ["select", "open"],
  dismiss: "escape",
});

export const SURFACES: ReadonlyArray<Surface> = [
  nodeSurface("node:agent", "agent1", ["select"]),
  nodeSurface("node:tasks", "tasks", ["select", "open"]),
  nodeSurface("node:requests", "requests", ["select", "open"]),
  nodeSurface("node:artifacts", "artifacts", ["select", "open"]),
  nodeSurface("node:board", "board", ["select", "open"]),
  nodeSurface("node:relay", "relay", ["select"]),
  nodeSurface("node:cron", "cron", ["select"]),
  nodeSurface("node:note", "note", ["select"]),
  nodeSurface("node:label", "label", ["select"]),
  nodeSurface("node:page", "page1", ["select", "open"], "close-button"),
  nodeSurface("node:terminal", "terminal", ["select"], "close-button"),
  ...EDGES.map(edgeSurface),
  { id: "shell:palette", kind: "shell", actions: ["palette-tabs"], dismiss: "escape" },
  { id: "shell:settings", kind: "shell", actions: ["settings-sections"], dismiss: "close-button" },
];

export type Theme = "dark" | "bright";
export type Scale = 1 | 1.5;
export type Viewport = "wide" | "compact";

export const VIEWPORTS: Readonly<Record<Viewport, { readonly width: number; readonly height: number }>> = {
  wide: { width: 1440, height: 900 },
  compact: { width: 1100, height: 720 },
};

export interface ContextAxes {
  /** Real product path: settings theme is `system`; the OS colour scheme is emulated. */
  readonly theme: ReadonlyArray<Theme>;
  /** `--force-device-scale-factor`; needs a fresh launch. */
  readonly scale: ReadonlyArray<Scale>;
  /** Window content size, set in place. */
  readonly viewport: ReadonlyArray<Viewport>;
}

export const CONTEXT_AXES: ContextAxes = {
  theme: ["dark", "bright"],
  scale: [1, 1.5],
  viewport: ["wide", "compact"],
};

// --- invariants --------------------------------------------------------------

/**
 * Each invariant is a deterministic oracle. Two-witness invariants compare what
 * is on screen with the running app's own document projection, read through
 * the canvas control socket (the same path as `bun run digest`).
 */
export const INVARIANTS = {
  "surface-appears": "the action reaches the surface it names",
  "selection-parity": "the RTS bar names the same kind (node) or verb (edge) the document holds",
  "render-parity": "every document node is rendered on the canvas, and nothing else is",
  "label-parity": "every rendered node shows the title the digest gives it",
  "doc-unchanged": "a read-only probe leaves the document byte-identical",
  "copy-law": "rendered text has no middle dot and no leaked undefined, NaN, or [object Object]",
  "in-viewport": "an opened surface fits inside the window",
  "dismiss-clears": "the designed dismiss gesture returns to a bare canvas",
  "no-page-errors": "no uncaught renderer exception or console error during the probe",
  "probe-error": "the probe itself completed (a throw here is a harness or product failure)",
} as const;

export type InvariantId = keyof typeof INVARIANTS;

/** The invariants a probe checks, by action. Parity and copy checks always run. */
export const invariantsFor = (surface: Surface, action: ActionId): ReadonlyArray<InvariantId> => {
  const always: InvariantId[] = ["copy-law", "doc-unchanged", "dismiss-clears", "no-page-errors"];
  if (surface.kind === "shell") return ["surface-appears", "in-viewport", ...always];
  // A double click on a wire only selects it: there is no settings surface behind it.
  if (action === "select" || surface.kind === "edge") return ["surface-appears", "selection-parity", ...always];
  return ["surface-appears", "in-viewport", ...always];
};

/** Board-level invariants, checked once per launch after the scene settles. */
export const BOARD_INVARIANTS: ReadonlyArray<InvariantId> = ["render-parity", "label-parity", "copy-law"];
