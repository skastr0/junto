import type { Page } from "@playwright/test";
import { Schema } from "effect";
import { tmpdir } from "node:os";
import {
  Command, Node, Wire, Opened, asCanvasName,
  Region, Seat, Note, Terminal, type SheetGrid,
} from "../../src/shared/model";
import { resolveManagedLaunch } from "../../src/shared/managed-terminal-launch";
import { verbsForPair, type Verb } from "../../src/shared/physics/verbs";
import type { Task, Artifact } from "../../src/shared/work-model";
import { THIS_MACHINE } from "../../tests/support/machines";
import type { SeatSessionObservation } from "../../src/main/junto/seat-sessions/repository";

/** A native fixture contains authored rows; Work is queried separately. */
export type ModelFixture = {
  readonly nodes: ReadonlyArray<Node>;
  readonly wires: ReadonlyArray<Wire>;
  readonly sheets?: Readonly<Record<string, SheetGrid>>;
  readonly seatSessions?: ReadonlyArray<SeatSessionObservation>;
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
  readonly x?: number;
  readonly y?: number;
  readonly z?: number;
}): Seat => {
  const harness = input.harness ?? "codex";
  const cwd = input.cwd ?? tmpdir();
  return Schema.decodeUnknownSync(Seat, { onExcessProperty: "error" })({
    kind: "agent", id: input.id, agentKey: input.key ?? `local:${input.id}`, label: input.label ?? input.id,
    bindingId: input.bindingId ?? input.key ?? `local:${input.id}`, harness, host: input.host ?? THIS_MACHINE,
    overseer: false, onRemove: "detach", x: input.x ?? 0, y: input.y ?? 0,
    width: 240, height: 96, z: input.z ?? 0,
    launch: input.launch ?? { ...resolveManagedLaunch(harness, { cwd }, {}), cwd },
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
  host: input.host ?? THIS_MACHINE, onRemove: "detach", launch: input.launch ?? { kind: "shell" },
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

/** Echo entered lines to the screen and a transcript file. */
export const modelEchoTerminal = (input: {
  readonly id: string; readonly bindingId: string; readonly label: string;
  readonly transcript: string; readonly x?: number; readonly y?: number;
}): Terminal => modelTerminal({
  ...input,
  launch: { kind: "command", argv: ["/bin/sh", "-c", "printf 'echo-ready\\r\\n'; exec tee \"$0\"", input.transcript] },
});

/** A directed mail relationship; a mask keeps only the named ports. */
export const modelMessagesWire = (
  id: string, from: string, to: string, nodes: ReadonlyArray<Node>, mask?: Wire["mask"],
): Wire => Schema.decodeUnknownSync(Wire, { onExcessProperty: "error" })({
  ...modelWire(id, from, to, "messages", nodes), ...(mask === undefined ? {} : { mask }),
});

export const modelFixture = (nodes: ReadonlyArray<Node>, wires: ReadonlyArray<Wire> = []): ModelFixture => ({
  nodes: nodes.map((node, z) => decodeNode({ ...node, z })), wires,
});

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
