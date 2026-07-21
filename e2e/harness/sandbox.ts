/**
 * Per-test sandbox: a throwaway temp root holding the Electron user-data
 * dir, the VELLUM_CANVASES_DIR, and a sandboxed HOME — plus fixture canvas
 * builders/writers/readers. Nothing here ever reads or writes the operator's
 * real ~/.vellum or userData; every path lives under os.tmpdir().
 */
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { CanvasDoc, CanvasEdge, CanvasNode, TextNode } from "../../src/shared/canvas";
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

/** Raw file replace — used to simulate an external agent editing the .canvas
 * file directly (the file-watcher / hot-reload direction of the roundtrip). */
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

export const canvasDoc = (
  nodes: readonly CanvasNode[],
  edges: readonly CanvasEdge[] = [],
): CanvasDoc => ({ nodes: [...nodes], edges: [...edges] });
