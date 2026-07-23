/**
 * Per-test sandbox: a throwaway temp root holding the Electron user-data
 * dir, the VELLUM_CANVASES_DIR, and a sandboxed HOME — plus fixture canvas
 * builders/writers/readers. Nothing here ever reads or writes the operator's
 * real ~/.vellum or userData; every path lives under os.tmpdir().
 */
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type {
  A2ATask,
  Artifact,
  CanvasDoc,
  CanvasEdge,
  CanvasNode,
  TextNode,
} from "../../src/shared/canvas";
import { serializeCanvas } from "../../src/shared/canvas";

export interface Sandbox {
  readonly root: string;
  readonly userDataDir: string;
  readonly canvasesDir: string;
  readonly homeDir: string;
}

export const createSandbox = async (): Promise<Sandbox> => {
  const root = await mkdtemp(join(tmpdir(), "vellum-e2e-"));
  const userDataDir = join(root, "user-data");
  const canvasesDir = join(root, "canvases");
  const homeDir = join(root, "home");
  await Promise.all([
    mkdir(userDataDir, { recursive: true }),
    mkdir(canvasesDir, { recursive: true }),
    mkdir(homeDir, { recursive: true }),
  ]);
  return { root, userDataDir, canvasesDir, homeDir };
};

/** Best-effort recursive removal — never throws (temp cleanup is not load-bearing). */
export const destroySandbox = async (sandbox: Sandbox): Promise<void> => {
  await rm(sandbox.root, { recursive: true, force: true }).catch(() => undefined);
};

const canvasPath = (sandbox: Sandbox, name: string): string => join(sandbox.canvasesDir, `${name}.canvas`);

export const writeFixtureCanvas = async (
  sandbox: Sandbox,
  name: string,
  doc: CanvasDoc,
): Promise<void> => {
  await writeFile(canvasPath(sandbox, name), serializeCanvas(doc), "utf8");
};

/** Raw file replace — simulate an external process editing the .canvas file
 * outside app-owned write APIs (must not mint live factory intent). */
export const writeCanvasFileRaw = async (
  sandbox: Sandbox,
  name: string,
  contents: string,
): Promise<void> => {
  await writeFile(canvasPath(sandbox, name), contents, "utf8");
};

export const readCanvasFile = async (sandbox: Sandbox, name: string): Promise<CanvasDoc> =>
  JSON.parse(await readFile(canvasPath(sandbox, name), "utf8")) as CanvasDoc;

// --- fixture builders --------------------------------------------------------

/** A free (no ether.entity) text node — renders inline as a note. */
export const textNode = (id: string, text: string, x = 0, y = 0): TextNode => ({
  id,
  type: "text",
  text,
  x,
  y,
  width: 240,
  height: 120,
});

/** Vellum-owned native terminal node (entity.kind terminal + ether.terminal).
 * Launch is inert until Start — matches makeTerminalNode. */
export const terminalTextNode = (input: {
  readonly id: string;
  readonly bindingId: string;
  readonly label: string;
  readonly host?: string;
  readonly launch?: {
    readonly kind: "shell" | "command" | "harness";
    readonly argv?: readonly string[];
    readonly cwd?: string;
  };
  readonly x?: number;
  readonly y?: number;
}): TextNode => ({
  id: input.id,
  type: "text",
  text: input.label,
  x: input.x ?? 0,
  y: input.y ?? 0,
  width: 260,
  height: 110,
  ether: {
    entity: { kind: "terminal" },
    host: input.host ?? "local",
    terminal: {
      bindingId: input.bindingId,
      label: input.label,
      ...(input.launch ? { launch: { ...input.launch, argv: input.launch.argv ? [...input.launch.argv] : undefined } } : {}),
    },
  },
});

/** A herdr-bound node matching the shape the demo engine's own scenarios use
 * (src/renderer/demo/scenarios/trailer-60.ts) — single fixed workspace/tab. */
export const herdrTextNode = (input: {
  readonly id: string;
  readonly host: string;
  readonly paneId: string;
  readonly terminalId: string;
  readonly label: string;
  readonly x?: number;
  readonly y?: number;
}): TextNode => ({
  id: input.id,
  type: "text",
  text: input.label,
  x: input.x ?? 0,
  y: input.y ?? 0,
  width: 260,
  height: 110,
  ether: {
    entity: { kind: "herdr" },
    herdr: {
      host: input.host,
      session: null,
      workspaceId: "w1",
      tabId: "w1:t1",
      paneId: input.paneId,
      terminalId: input.terminalId,
      label: input.label,
    },
  },
});

/** An agent-bound node matching makeAgentNode's shape
 * (src/renderer/lib/node-factories.ts) — opens ChatView in the inspector
 * once selected. `key` is a hermes agent key ("<host>:<profile>"). */
export const agentTextNode = (input: {
  readonly id: string;
  readonly key: string;
  readonly label: string;
  readonly host?: string;
  readonly x?: number;
  readonly y?: number;
}): TextNode => ({
  id: input.id,
  type: "text",
  text: input.label,
  x: input.x ?? 0,
  y: input.y ?? 0,
  width: 240,
  height: 96,
  ether: { entity: { kind: "agent", name: input.key }, host: input.host ?? "local" },
});

export const canvasDoc = (
  nodes: readonly CanvasNode[],
  edges: readonly CanvasEdge[] = [],
): CanvasDoc => ({ nodes: [...nodes], edges: [...edges] });

// --- A2A work-plane fixtures (no legacy checklist shape) --------------------

export const a2aTask = (
  id: string,
  brief: string,
  state: A2ATask["state"] = "submitted",
): A2ATask => ({
  id,
  state,
  history: [
    {
      messageId: `${id}-m0`,
      role: "user",
      parts: [{ kind: "text", text: brief }],
      taskId: id,
      contextId: "e2e",
    },
  ],
});

/** Empty tasks node — work ops fill ether.tasks via WorkService. */
export const tasksNode = (input: {
  readonly id: string;
  readonly x?: number;
  readonly y?: number;
  readonly items?: ReadonlyArray<A2ATask>;
}): TextNode => ({
  id: input.id,
  type: "text",
  text:
    input.items && input.items.length > 0
      ? input.items
          .map((t) => {
            const part = t.history[0]?.parts.find((p) => p.kind === "text");
            return part && part.kind === "text" ? part.text : t.id;
          })
          .join("\n")
      : "tasks",
  x: input.x ?? 0,
  y: input.y ?? 0,
  width: 240,
  height: 120,
  ether: {
    entity: { kind: "task" },
    tasks: { items: [...(input.items ?? [])] },
  },
});

export const requestsNode = (input: {
  readonly id: string;
  readonly x?: number;
  readonly y?: number;
  readonly items?: ReadonlyArray<A2ATask>;
}): TextNode => {
  const items = input.items ?? [];
  const pending = items.filter((t) => t.state === "input-required").length;
  return {
    id: input.id,
    type: "text",
    text: `${pending} pending`,
    x: input.x ?? 0,
    y: input.y ?? 0,
    width: 240,
    height: 120,
    ether: {
      entity: { kind: "requests" },
      requests: { items: [...items] },
    },
  };
};

export const artifactsNode = (input: {
  readonly id: string;
  readonly x?: number;
  readonly y?: number;
  readonly items?: ReadonlyArray<Artifact>;
}): TextNode => ({
  id: input.id,
  type: "text",
  text: "artifacts",
  x: input.x ?? 0,
  y: input.y ?? 0,
  width: 240,
  height: 120,
  ether: {
    entity: { kind: "artifacts" },
    artifacts: { items: [...(input.items ?? [])] },
  },
});

/** Soft project-like blockable target (kind project; no private-source bindings). */
export const projectNode = (input: {
  readonly id: string;
  readonly name: string;
  readonly label?: string;
  readonly x?: number;
  readonly y?: number;
}): TextNode => ({
  id: input.id,
  type: "text",
  text: input.label ?? input.name,
  x: input.x ?? 0,
  y: input.y ?? 0,
  width: 200,
  height: 80,
  ether: { entity: { kind: "project", name: input.name } },
});

export const tasksCriteriaEdge = (
  id: string,
  fromNode: string,
  toNode: string,
): CanvasEdge => ({
  id,
  fromNode,
  toNode,
  fromSide: "right",
  toSide: "left",
  ether: { criteria: { mode: "tasks" } },
});
