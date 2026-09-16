import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { actorDeliverySurfaceOf } from "../src/shared/actor-surface";
import type { CanvasNode } from "../src/shared/canvas";
import { resolveTerminalBinding } from "../src/shared/terminal";

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

const baseNode = (kind: string): CanvasNode => ({
  id: `node-${kind}`,
  type: "text",
  text: kind,
  x: 0,
  y: 0,
  width: 200,
  height: 80,
  ether: { entity: { kind } },
});

describe("terminal actor entry", () => {
  it("carries the canvas node instead of loose actor authority fields", () => {
    const source = readSource(IPC_CONTRACT);
    const body = between(
      source,
      "export interface TerminalCreateInput {",
      "\n}",
    );

    expect(body).toMatch(/readonly node: CanvasNode;/u);
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
    const createAt = actor.indexOf("api.terminalCreate({");

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
    const createAt = actor.indexOf("api.terminalCreate({");

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
      "const api = getJuntoApi() as VellumCommandTerminalApi | undefined;",
      'const label = node.type === "text" ? node.text : "terminal";',
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

  it("Main enters ActorSeatOccupy and never infers actors from optionals", () => {
    const source = readSource(MAIN_ENTRY);
    const create = between(
      source,
      "IPC_CHANNELS.terminalCreate,",
      "IPC_CHANNELS.managedTerminalModels",
    );
    const actor = between(
      create,
      'if (entityKind === "agent") {',
      '\n\n      if (entityKind === "terminal") {',
    );
    const geography = between(
      create,
      'if (entityKind === "terminal") {',
      "\n\n      return deny(",
    );

    expect(actor).toContain("const surface = actorDeliverySurfaceOf(node);");
    expect(actor).toContain("const seats = yield* ActorSeatOccupy;");
    expect(actor).toContain("yield* seats.occupy({");
    expect(actor).not.toContain("router.createAgentSeat");
    expect(actor).toContain("makeManagedSpawnIntent");
    expect(actor).toContain("spawnIntent,");
    expect(actor).not.toContain("launchForManagedSpawn(");
    expect(actor).not.toContain("firstTypedMessage");
    expect(create).not.toContain("isManagedHarnessInstalled");
    expect(create).not.toMatch(
      /input\??\.(?:harness|agentKey|bindingId|hostId|launch)/u,
    );
    expect(geography).toContain("return router.create({");
    expect(geography).not.toContain("ActorSeatOccupy");
  });

  it("kind, not stray terminal optionals, discriminates actor from geography", () => {
    const raw: CanvasNode = {
      ...baseNode("terminal"),
      ether: {
        entity: { kind: "terminal", name: "local:not-an-actor" },
        terminal: { bindingId: "raw-1", harness: "codex" },
      },
    };
    expect(actorDeliverySurfaceOf(raw)).toBeUndefined();
    expect(resolveTerminalBinding(raw)).toMatchObject({
      kind: "native",
      bindingId: "raw-1",
    });

    const incompleteActor: CanvasNode = {
      ...baseNode("agent"),
      ether: {
        entity: { kind: "agent", name: "local:actor" },
        terminal: { bindingId: "actor-1" },
      },
    };
    expect(actorDeliverySurfaceOf(incompleteActor)).toBeUndefined();
    expect(resolveTerminalBinding(incompleteActor)).toBeUndefined();
  });
});
