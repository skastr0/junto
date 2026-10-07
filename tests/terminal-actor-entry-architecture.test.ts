import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
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

const between = (source: string, start: string, end: string): string => {
  const from = source.indexOf(start);
  const to = source.indexOf(end, from + start.length);
  expect(from, `${start} missing`).toBeGreaterThanOrEqual(0);
  expect(to, `${end} missing after ${start}`).toBeGreaterThan(from);
  return source.slice(from, to);
};

describe("terminal actor entry", () => {
  it("carries only the stored canvas and node identity plus resume choice", () => {
    const source = readSource(IPC_CONTRACT);
    const body = between(
      source,
      "readonly modelStart: (input: {",
      "}) => Promise<TerminalSessionSummary>",
    );

    expect(body).toMatch(/readonly canvas: string;/u);
    expect(body).toMatch(/readonly id: string;/u);
    expect(body).toMatch(/readonly resume\?: boolean;/u);
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
      'import { actorDeliverySurfaceOf } from "@shared/actor-surface";',
    );
    expect(actor).toContain("const surface = actorDeliverySurfaceOf(node);");
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
      'const agentSeat = node.ether?.entity?.kind === "agent";',
    );
    expect(source).toContain(
      "const actorSurface = agentSeat ? actorDeliverySurfaceOf(node) : undefined;",
    );
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
    const geography = between(start, 'if (node.kind === "terminal") {', 'const { ensureSeatSessionId }');
    expect(start).toContain("const node = await readSeat(input?.canvas, input?.id);");
    expect(source).toContain('node?.kind !== "agent" && node?.kind !== "terminal"');
    expect(source).toContain("return current.nodes.get(id as never);");
    expect(start).toContain("const seats = yield* ActorSeatOccupy;");
    expect(start).toContain("yield* seats.occupy({");
    expect(start).toContain("makeManagedSpawnIntent");
    expect(start).toContain("spawnIntent,");
    expect(start).not.toContain("router.createAgentSeat");
    expect(start).not.toContain("firstTypedMessage");
    expect(start).not.toContain("isManagedHarnessInstalled");
    expect(start).not.toMatch(/input\??\.(?:node|harness|agentKey|bindingId|hostId|launch)/u);
    expect(geography).toContain("return router.create({");
    expect(geography).not.toContain("ActorSeatOccupy");
  });

  it("refuses actor fields on raw terminals and incomplete agent identities", () => {
    const decode = Schema.decodeUnknownSync(Node, { onExcessProperty: "error" });
    expect(decode(terminal("raw"))).toMatchObject({ kind: "terminal", bindingId: "terminal-raw" });
    expect(() => decode({ ...terminal("raw"), harness: "codex", agentKey: "local:actor" })).toThrow();
    const { harness: _harness, ...withoutHarness } = seat("actor");
    const { bindingId: _binding, ...withoutBinding } = seat("actor");
    expect(() => decode(withoutHarness)).toThrow();
    expect(() => decode(withoutBinding)).toThrow();
  });
});
