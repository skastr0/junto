import type { Page } from "@playwright/test";
import { Schema } from "effect";
import { tmpdir } from "node:os";
import {
  Command, Node, Wire, Opened, asCanvasName,
  Region, Seat, Note, Terminal,
} from "../../src/shared/model";
import { defaultMachineName } from "../../src/shared/machine-name";
import { resolveManagedLaunch } from "../../src/shared/managed-terminal-launch";
import { verbsForPair, type Verb } from "../../src/shared/physics/verbs";
import type { Task, Artifact } from "../../src/shared/work-model";
import { THIS_MACHINE } from "../../tests/support/machines";
import type { SeatSessionObservation } from "../../src/core/seat-sessions/repository";

/** A native fixture contains authored rows; Work is queried separately. */
export type ModelFixture = {
  readonly nodes: ReadonlyArray<Node>;
  readonly wires: ReadonlyArray<Wire>;
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
    overseer: false, x: input.x ?? 0, y: input.y ?? 0,
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
  host: input.host ?? THIS_MACHINE, launch: input.launch ?? { kind: "shell" },
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

export const modelSeatSession = (seat: Seat, sessionId: string): SeatSessionObservation => ({
  seatId: seat.id, bindingId: seat.bindingId, harness: seat.harness, sessionId,
  ...(seat.launch?.cwd ? { cwd: seat.launch.cwd } : {}),
});

export const modelFixture = (
  nodes: ReadonlyArray<Node>, wires: ReadonlyArray<Wire> = [],
  seatSessions: ReadonlyArray<SeatSessionObservation> = [],
): ModelFixture => ({
  nodes: nodes.map((node, z) => decodeNode({ ...node, z })), wires,
  ...(seatSessions.length ? { seatSessions } : {}),
});

export const modelSeedCommands = (name: string, fixture: ModelFixture): ReadonlyArray<Command> => {
  const canvas = asCanvasName(name);
  return [decodeCommand({ _tag: "CreateCanvas", canvas }), decodeCommand({
    _tag: "Batch", canvas, steps: [
      { _tag: "Add", canvas, nodes: fixture.nodes, wires: fixture.wires },
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

/**
 * The fixture with what it placed on THIS_MACHINE placed on `machineName`:
 * every node's host, and every region's working-directory key.
 */
export const placeOnMachine = (fixture: ModelFixture, machineName: string): ModelFixture =>
  machineName === THIS_MACHINE
    ? fixture
    : {
        ...fixture,
        nodes: fixture.nodes.map((node) => {
          if ("host" in node && node.host === THIS_MACHINE) return { ...node, host: machineName };
          const paths = node.kind === "region" ? node.defaults?.paths : undefined;
          if (node.kind !== "region" || paths?.[THIS_MACHINE] === undefined) return node;
          const { [THIS_MACHINE]: path, ...rest } = paths;
          return { ...node, defaults: { ...node.defaults, paths: { ...rest, [machineName]: path } } };
        }),
      };

/**
 * Replace an isolated scenario's topology through one native command batch,
 * on the app's own machine name. A launch that seeded a database named it
 * THIS_MACHINE (writeFixtureModel), so the fixture goes in as written; an app
 * that made its own database named itself defaultMachineName() of this host,
 * as the core does, and refuses the fixture's seats as an unresolved host,
 * so they go on that name instead. The batch is one transaction: a refused
 * try changes nothing.
 */
export const installModelFixture = async (page: Page, fixture: ModelFixture, fallbackName = "fixture"): Promise<string> => {
  const names = await page.evaluate(() => window.junto!.modelCanvases());
  const name = names[0]?.name ?? fallbackName;
  if (names.length === 0) await commandModel(page, { _tag: "CreateCanvas", canvas: name });
  const current = await readModelCanvas(page, name);
  const install = (placed: ModelFixture) => commandModel(page, { _tag: "Batch", canvas: name, steps: [
    ...(current.nodes.length ? [{ _tag: "Remove", canvas: name, nodes: current.nodes.map((node) => node.id), wires: [] }] : []),
    { _tag: "Add", canvas: name, nodes: placed.nodes, wires: placed.wires },
  ] });
  const hostDefault = defaultMachineName();
  try {
    await install(fixture);
  } catch (error) {
    const unresolved = String(error).includes(`unresolved host ${JSON.stringify(THIS_MACHINE)}`);
    if (!unresolved || hostDefault === THIS_MACHINE) throw error;
    await install(placeOnMachine(fixture, hostDefault));
  }
  return name;
};

export const readModelSeat = async (page: Page, canvas: string, id: string): Promise<Seat | undefined> => {
  const node = await readModelNode(page, canvas, id);
  return node?.kind === "agent" ? node : undefined;
};

export const grantOverseer = async (page: Page, canvas: string, id: string, overseer = true): Promise<void> => {
  await page.evaluate((command) => window.junto!.modelCommand(command), decodeCommand({ _tag: "GrantOverseer", canvas, id, overseer }));
};

