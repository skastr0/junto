import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { THIS_MACHINE } from "./support/machines";
import { Schema } from "effect";
import { Node } from "../src/shared/model";
import { seat, terminal } from "./support/model-nodes";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const readSource = (path: string): string =>
  readFileSync(join(root, path), "utf8");

const IPC_CONTRACT = "src/shared/ipc.ts";
const RENDERER_ENTRY = "src/renderer/lib/terminal-actions.ts";
const TERMINAL_SURFACE =
  "src/renderer/components/terminal/TerminalSurface.tsx";
const MAIN_ENTRY = "src/main/junto/term/ipc.ts";
const SEAT_CONTROL = "src/main/junto/term/seat-control.ts";
const SEAT_NODE_OP = "src/main/core-process/ops/term-ipc.ts";

const between = (source: string, start: string, end: string): string => {
  const from = source.indexOf(start);
  const to = source.indexOf(end, from + start.length);
  expect(from, `${start} missing`).toBeGreaterThanOrEqual(0);
  expect(to, `${end} missing after ${start}`).toBeGreaterThan(from);
  return source.slice(from, to);
};

describe("terminal actor entry", () => {
  it("carries only the stored canvas and node identity", () => {
    const source = readSource(IPC_CONTRACT);
    const body = between(
      source,
      "readonly modelStart: (input: {",
      "}) => Promise<TerminalSessionSummary>",
    );

    expect(body).toMatch(/readonly canvas: string;/u);
    expect(body).toMatch(/readonly id: string;/u);
    // A start is a start: the seat's own start decides what it starts on.
    expect(body).not.toMatch(/readonly (?:resume|fresh)\??:/u);
    for (const field of [
      "bindingId",
      "hostId",
      "launch",
      "nodeId",
      "label",
      "title",
      "harness",
      "agentKey",
    ]) {
      expect(body, `${field} must be derived from node`).not.toMatch(
        new RegExp(`readonly ${field}\\??:`, "u"),
      );
    }
  });

  it("renderer delegates every valid actor occupy decision to Main", () => {
    const source = readSource(RENDERER_ENTRY);
    const ensure = between(
      source,
      "export const ensureTerminalRunning = async (",
      "\n\n/**\n * Open the workbench surface",
    );
    const actor = between(
      ensure,
      'if (entityKind === "agent") {',
      "\n\n  // Raw native terminals are geography.",
    );
    const createAt = actor.indexOf("api.modelStart({");

    expect(source).toContain(
      'import { terminalBindingOf, sessionActorMatches } from "@shared/terminal";',
    );
    expect(actor).toContain("const surface = terminalBindingOf(node)!;");
    expect(createAt).toBeGreaterThanOrEqual(0);
    expect(actor.indexOf("terminalGet")).toBeGreaterThan(createAt);
    expect(actor).not.toContain("occupancyFromSummary");
    expect(actor).not.toMatch(/binding\.(?:harness|agentKey)/u);
    expect(source).not.toMatch(
      /Boolean\([\s\S]{0,100}(?:harness|agentKey)/u,
    );
  });

  it("renderer commits the debounced canvas save before invoking actor occupy", () => {
    const source = readSource(RENDERER_ENTRY);
    const ensure = between(
      source,
      "export const ensureTerminalRunning = async (",
      "\n\n/**\n * Open the workbench surface",
    );
    const actor = between(
      ensure,
      'if (entityKind === "agent") {',
      "\n\n  // Raw native terminals are geography.",
    );
    const flushAt = actor.indexOf("flushPendingCanvasSave()");
    const createAt = actor.indexOf("api.modelStart({");

    expect(source).toContain(
      'import { flushPendingCanvasSave } from "./mutations";',
    );
    expect(flushAt).toBeGreaterThanOrEqual(0);
    expect(createAt).toBeGreaterThan(flushAt);
  });

  it("TerminalSurface chooses occupy-before-attach from exact node kind", () => {
    const source = readSource(TERMINAL_SURFACE);
    const attachEffect = between(
      source,
      "const api = getJuntoApi() as JuntoTerminalApi | undefined;",
      "// What the header says of the seat, read from the node store as it stands",
    );

    expect(source).toContain(
      'const agentSeat = node.kind === "agent";',
    );
    expect(source).toContain("const binding = terminalBindingOf(node);");
    expect(source).not.toContain("isAgentTerminalSeat");
    expect(attachEffect).toContain("if (agentSeat) {");
    const ensureIndex = attachEffect.indexOf(
      "ensureTerminalRunning(nodeRef.current",
    );
    const attachIndex = attachEffect.indexOf(
      "runAttach();",
      attachEffect.indexOf("if (agentSeat) {"),
    );
    expect(ensureIndex).toBeGreaterThanOrEqual(0);
    expect(attachIndex).toBeGreaterThanOrEqual(0);
    expect(ensureIndex).toBeLessThan(attachIndex);
  });

  it("Main reads its stored node and enters ActorSeatOccupy only for an agent", () => {
    const source = readSource(MAIN_ENTRY);
    const start = between(source, "ipcMain.handle(IPC_CHANNELS.modelStart,", "ipcMain.handle(IPC_CHANNELS.modelStop,");
    const agent = between(start, 'if (node.kind === "agent") {', "const createAdmission");
    const geography = start.slice(start.indexOf("const createAdmission"));
    expect(start).toContain("const node = await readSeat(input?.canvas, input?.id);");
    expect(source).toContain('node?.kind !== "agent" && node?.kind !== "terminal"');
    // The stored node is read by the core (term.seatNode), by canvas and id only.
    expect(source).toContain('const node = await core.call("term.seatNode", { canvas, id });');
    const seatNode = between(readSource(SEAT_NODE_OP), '"term.seatNode": ({ canvas, id }) =>', '"term.seatLaunchState"');
    expect(seatNode).toContain("(yield* model.canvas(canvas)).nodes.get(id as never);");
    // An agent seat starts through the one path the owner commands share,
    // by the stored node's id, in the core (term.startSeat).
    expect(agent).toContain('core.call("term.startSeat", { canvas: input.canvas, seatId: node.id })');
    const startOp = between(readSource(SEAT_NODE_OP), '"term.startSeat": ({ canvas, seatId }) =>', '"term.stopSeat"');
    expect(startOp).toContain("startSeat({ canvas: asCanvasName(canvas), seatId }, seatControl)");
    const control = readSource(SEAT_CONTROL);
    expect(control).toContain("const seats = yield* ActorSeatOccupy;");
    expect(control).toContain("yield* seats.occupy({");
    expect(control).toContain("makeManagedSpawnIntent");
    expect(control).toContain("spawnIntent,");
    for (const body of [start, control]) {
      expect(body).not.toContain("router.createAgentSeat");
      expect(body).not.toContain("firstTypedMessage");
      expect(body).not.toContain("isManagedHarnessInstalled");
      expect(body).not.toMatch(/input\??\.(?:node|harness|agentKey|bindingId|hostId|launch)/u);
    }
    expect(geography).toContain("await router.create({ bindingId: node.bindingId, hostId: node.host,");
    expect(geography).not.toContain("ActorSeatOccupy");
  });

  it("refuses actor fields on raw terminals and incomplete agent identities", () => {
    const decode = Schema.decodeUnknownSync(Node, { onExcessProperty: "error" });
    expect(decode(terminal("raw"))).toMatchObject({ kind: "terminal", bindingId: "terminal-raw" });
    expect(() => decode({ ...terminal("raw"), harness: "codex", agentKey: `${THIS_MACHINE}:actor` })).toThrow();
    const { harness: _harness, ...withoutHarness } = seat("actor");
    const { bindingId: _binding, ...withoutBinding } = seat("actor");
    expect(() => decode(withoutHarness)).toThrow();
    expect(() => decode(withoutBinding)).toThrow();
  });
});
