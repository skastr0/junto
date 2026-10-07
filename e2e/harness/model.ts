import type { Page } from "@playwright/test";
import { Schema } from "effect";
import { tmpdir } from "node:os";
import { decodeCanvasDoc, type CanvasDoc } from "../../src/shared/canvas";
import {
  Command, Node, Wire, Opened, asCanvasName,
  Region, Seat, Note, Terminal, type SheetGrid,
} from "../../src/shared/model";
import { canvasFromDocument, nodeToDocument, wireToDocument } from "../../src/shared/model/from-document";
import { documentEdits } from "../../src/shared/model/document-edits";
import { reconcileOverseerGrants } from "../../src/shared/overseer-authoring";
import { resolveManagedLaunch } from "../../src/shared/managed-terminal-launch";
import { verbsForPair, type Verb } from "../../src/shared/physics/verbs";
import type { Task, Artifact } from "../../src/shared/work-model";

/** A native fixture contains authored rows; Work is queried separately. */
export type ModelFixture = {
  readonly nodes: ReadonlyArray<Node>;
  readonly wires: ReadonlyArray<Wire>;
  readonly sheets?: Readonly<Record<string, SheetGrid>>;
};

const decodeNode = Schema.decodeUnknownSync(Node, { onExcessProperty: "error" });
export const modelNode = decodeNode;
const decodeCommand = Schema.decodeUnknownSync(Command, { onExcessProperty: "error" });

export const modelSeat = (input: {
  readonly id: string;
  readonly key?: string;
  readonly label?: string;
  readonly host?: string;
  readonly bindingId?: string;
  readonly harness?: Seat["harness"];
  readonly cwd?: string;
  readonly launch?: Seat["launch"];
  readonly sessionId?: string;
  readonly x?: number;
  readonly y?: number;
  readonly z?: number;
}): Seat => {
  const harness = input.harness ?? "codex";
  const cwd = input.cwd ?? tmpdir();
  return Schema.decodeUnknownSync(Seat, { onExcessProperty: "error" })({
    kind: "agent", id: input.id, agentKey: input.key ?? `local:${input.id}`, label: input.label ?? input.id,
    bindingId: input.bindingId ?? input.key ?? `local:${input.id}`, harness, host: input.host ?? "local",
    overseer: false, onRemove: "detach", x: input.x ?? 0, y: input.y ?? 0,
    width: 240, height: 96, z: input.z ?? 0,
    launch: input.launch ?? { ...resolveManagedLaunch(harness, { cwd }, {}), cwd },
    ...(input.sessionId ? { sessionId: input.sessionId } : {}),
  });
};

export const modelRegion = (input: Omit<Partial<Region>, "kind" | "id"> & { readonly id: string }): Region =>
  Schema.decodeUnknownSync(Region, { onExcessProperty: "error" })({ kind: "region", x: 0, y: 0, width: 900, height: 560, z: 0, defaults: {}, hold: false, ...input });

export const modelNote = (id: string, text: string, x = 0, y = 0): Extract<Node, { kind: "note" }> =>
  Schema.decodeUnknownSync(Note, { onExcessProperty: "error" })({ kind: "note", id, text, x, y, width: 240, height: 120, z: 0 });

export const modelTerminal = (input: {
  readonly id: string; readonly bindingId: string; readonly label: string;
  readonly host?: string; readonly launch?: Terminal["launch"];
  readonly x?: number; readonly y?: number;
}): Terminal => Schema.decodeUnknownSync(Terminal, { onExcessProperty: "error" })({
  kind: "terminal", id: input.id, bindingId: input.bindingId, label: input.label,
  host: input.host ?? "local", onRemove: "detach", launch: input.launch ?? { kind: "shell" },
  x: input.x ?? 0, y: input.y ?? 0, width: 260, height: 110, z: 0,
});

export const modelWire = (
  id: string, from: string, to: string, verb: Verb, nodes: ReadonlyArray<Node>,
  sides?: { readonly fromSide?: Wire["fromSide"]; readonly toSide?: Wire["toSide"] },
): Wire => {
  const source = nodes.find((node) => node.id === from);
  const target = nodes.find((node) => node.id === to);
  if (!source || !target || !verbsForPair(source.kind, target.kind).includes(verb))
    throw new Error(`Fixture wire ${id} does not name an allowed relationship between its endpoints`);
  return Schema.decodeUnknownSync(Wire, { onExcessProperty: "error" })({
    id, from, to, verb, fromSide: sides?.fromSide ?? "right", toSide: sides?.toSide ?? "left",
  });
};

/** A directed mail relationship; a mask keeps only the named ports. */
export const modelMessagesWire = (
  id: string, from: string, to: string, nodes: ReadonlyArray<Node>, mask?: Wire["mask"],
): Wire => Schema.decodeUnknownSync(Wire, { onExcessProperty: "error" })({
  ...modelWire(id, from, to, "messages", nodes), ...(mask === undefined ? {} : { mask }),
});

export const modelFixture = (nodes: ReadonlyArray<Node>, wires: ReadonlyArray<Wire> = []): ModelFixture => ({
  nodes: nodes.map((node, z) => decodeNode({ ...node, z })), wires,
});

/** Temporary seed adapter, removed when the last scenario uses native builders. */
export const modelFixtureFromDocument = (name: string, document: CanvasDoc): ModelFixture => {
  const decoded = decodeCanvasDoc(reconcileOverseerGrants({ nodes: [], edges: [] }, document));
  if (decoded._tag === "Failure") throw new Error(decoded.failure.message);
  const canvas = canvasFromDocument(name, decoded.success);
  const sheets: Record<string, SheetGrid> = {};
  for (const node of decoded.success.nodes) {
    if (node.ether?.entity?.kind === "sheet") sheets[node.id] = node.ether.sheet ?? { columns: [], rows: [] };
  }
  return { nodes: [...canvas.nodes.values()], wires: [...canvas.wires.values()], sheets };
};

export const modelSeedCommands = (name: string, fixture: ModelFixture): ReadonlyArray<Command> => {
  const canvas = asCanvasName(name);
  return [decodeCommand({ _tag: "CreateCanvas", canvas }), decodeCommand({
    _tag: "Batch", canvas, steps: [
      { _tag: "Add", canvas, nodes: fixture.nodes, wires: fixture.wires },
      ...Object.entries(fixture.sheets ?? {}).map(([id, grid]) => ({ _tag: "WriteSheet", canvas, id, grid })),
    ],
  })];
};

/** What main actually stores: label/text, session, harness, binding, and seq. */
export const readModelCanvas = async (page: Page, canvas: string): Promise<Opened> =>
  Schema.decodeUnknownSync(Opened, { onExcessProperty: "error" })(await page.evaluate(
    (canvas) => window.junto!.modelOpen({ canvas }), canvas,
  ));

export const readModelNode = async (page: Page, canvas: string, id: string): Promise<Node | undefined> =>
  (await readModelCanvas(page, canvas)).nodes.find((node) => node.id === id);

/** A temporary local projection for old seed editors, never a product read. */
const fixtureDocumentFromOpened = async (page: Page, opened: Opened): Promise<CanvasDoc> => {
  const name = opened.canvas;
  const nodes = opened.nodes.map(nodeToDocument);
  for (let index = 0; index < nodes.length; index++) {
    if (opened.nodes[index].kind !== "sheet") continue;
    const grid = await page.evaluate(({ canvas, id }) => window.junto!.modelSheetRead({ canvas, id }), { canvas: name, id: nodes[index].id });
    nodes[index] = { ...nodes[index], ether: { ...nodes[index].ether, sheet: grid } };
  }
  return { nodes, edges: opened.wires.map(wireToDocument) };
};

export const readFixtureDocument = async (page: Page, name: string): Promise<CanvasDoc> =>
  fixtureDocumentFromOpened(page, await readModelCanvas(page, name));

export const commandModel = async (page: Page, input: unknown) =>
  page.evaluate((command) => window.junto!.modelCommand(command), decodeCommand(input));

/** Replace an isolated scenario's topology through one native command batch. */
export const installModelFixture = async (page: Page, fixture: ModelFixture, fallbackName = "fixture"): Promise<string> => {
  const names = await page.evaluate(() => window.junto!.modelCanvases());
  const name = names[0]?.name ?? fallbackName;
  if (names.length === 0) await commandModel(page, { _tag: "CreateCanvas", canvas: name });
  const current = await readModelCanvas(page, name);
  await commandModel(page, { _tag: "Batch", canvas: name, steps: [
    ...(current.nodes.length ? [{ _tag: "Remove", canvas: name, nodes: current.nodes.map((node) => node.id), wires: [] }] : []),
    { _tag: "Add", canvas: name, nodes: fixture.nodes, wires: fixture.wires },
    ...Object.entries(fixture.sheets ?? {}).map(([id, grid]) => ({ _tag: "WriteSheet", canvas: name, id, grid })),
  ] });
  return name;
};

export const readModelSeat = async (page: Page, canvas: string, id: string): Promise<Seat | undefined> => {
  const node = await readModelNode(page, canvas, id);
  return node?.kind === "agent" ? node : undefined;
};

export const writeFixtureDocument = async (page: Page, name: string, next: CanvasDoc): Promise<number> => {
  const opened = await readModelCanvas(page, name);
  const before = await fixtureDocumentFromOpened(page, opened);
  const decoded = decodeCanvasDoc(reconcileOverseerGrants(before, next));
  if (decoded._tag === "Failure") throw new Error(decoded.failure.message);
  for (const node of decoded.success.nodes) {
    const old = opened.nodes.find((candidate) => candidate.id === node.id);
    if (old?.kind === "agent" && node.ether?.entity?.kind === "agent" && old.sessionId !== node.ether?.terminal?.sessionId)
      throw new Error("Fixture edits cannot record a runtime session; write harness capture evidence instead");
  }
  const steps = documentEdits(name, before, decoded.success, Math.max(-1, ...opened.nodes.map((node) => node.z)) + 1);
  if (steps.length === 0) return opened.seq;
  const command = decodeCommand({ _tag: "Batch", canvas: name, steps });
  return (await page.evaluate((command) => window.junto!.modelCommand(command), command)).seq;
};

export const installFixtureDocument = async (page: Page, fixture: CanvasDoc, fallbackName = "fixture"): Promise<string> => {
  const names = await page.evaluate(() => window.junto!.modelCanvases());
  const name = names[0]?.name ?? fallbackName;
  if (names.length === 0) await page.evaluate((command) => window.junto!.modelCommand(command), decodeCommand({ _tag: "CreateCanvas", canvas: name }));
  await writeFixtureDocument(page, name, fixture);
  return name;
};

export const grantOverseer = async (page: Page, canvas: string, id: string, overseer = true): Promise<void> => {
  await page.evaluate((command) => window.junto!.modelCommand(command), decodeCommand({ _tag: "GrantOverseer", canvas, id, overseer }));
};

export const readTaskItems = (page: Page, canvasName: string, nodeId: string, kind: "task" | "requests" = "task"): Promise<ReadonlyArray<Task>> =>
  page.evaluate(async ({ canvasName, nodeId, kind }) => {
    const items: Task[] = [];
    let beforeId: string | undefined;
    do {
      const result = await window.junto!.workSinkPage({ canvasName, nodeId, kind, limit: 200, ...(beforeId ? { beforeId } : {}) });
      if (result.kind !== "task" && result.kind !== "requests") throw new Error("Unexpected Work sink reply");
      items.push(...result.items); beforeId = result.nextBeforeId;
    } while (beforeId);
    return items;
  }, { canvasName, nodeId, kind });

export const readArtifactItems = (page: Page, canvasName: string, nodeId: string): Promise<ReadonlyArray<Artifact>> =>
  page.evaluate(async ({ canvasName, nodeId }) => {
    const items: Artifact[] = [];
    let beforeId: string | undefined;
    do {
      const result = await window.junto!.workSinkPage({ canvasName, nodeId, kind: "artifacts", limit: 200, ...(beforeId ? { beforeId } : {}) });
      if (result.kind !== "artifacts") throw new Error("Unexpected Work sink reply");
      items.push(...result.items); beforeId = result.nextBeforeId;
    } while (beforeId);
    return items;
  }, { canvasName, nodeId });
