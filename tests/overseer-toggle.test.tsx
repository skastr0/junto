import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { CanvasNode } from "../src/shared/canvas";
import { managedAgentEther } from "./helpers/managed-agent-ether";
import { EMPTY_SETTINGS, state$ } from "../src/renderer/lib/state";
import { modelStore } from "../src/renderer/lib/use-model";
import { canvasFromDocument } from "../src/shared/model/from-document";
import { OverseerToggleKey } from "../src/renderer/components/rts/OverseerToggle";

const managed = (overseer?: boolean): CanvasNode =>
  ({
    id: "seat",
    type: "text",
    text: "worker",
    x: 0,
    y: 0,
    width: 240,
    height: 96,
    ether: overseer
      ? { ...managedAgentEther("local:worker"), overseer: true }
      : managedAgentEther("local:worker"),
  }) as CanvasNode;

const seed = (node: CanvasNode): string => {
  const canvas = canvasFromDocument("Workshop", { nodes: [node], edges: [] });
  modelStore.canvas$("Workshop").nodes.set(Object.fromEntries(canvas.nodes));
  modelStore.canvas$("Workshop").nodeIds.set([...canvas.nodes.keys()]);
  return node.id;
};

beforeEach(() => {
  state$.settings.set(EMPTY_SETTINGS);
  state$.settings.station.role.set("command-center");
  state$.canvasName.set("Workshop");
});

afterEach(() => {
  state$.settings.set(EMPTY_SETTINGS);
  state$.canvasName.set("");
  modelStore.canvas$("Workshop").nodes.set({});
  modelStore.canvas$("Workshop").nodeIds.set([]);
});

describe("OverseerToggleKey", () => {
  it("grants from the kind strip, not the card", () => {
    const html = renderToStaticMarkup(<OverseerToggleKey nodeId={seed(managed())} />);
    expect(html).toContain('data-testid="rts-overseer"');
    expect(html).toContain('data-overseer="false"');
    expect(html).toContain('aria-label="Grant overseer"');
    expect(html).not.toContain("OVERSEER");
  });

  it("shows revoke when the seat is already overseer", () => {
    const html = renderToStaticMarkup(<OverseerToggleKey nodeId={seed(managed(true))} />);
    expect(html).toContain('data-overseer="true"');
    expect(html).toContain('aria-label="Revoke overseer"');
    expect(html).toContain("var(--color-indigo)");
    expect(html).not.toContain("var(--color-amber)");
    expect(html).not.toContain("var(--color-crimson)");
  });

  it("hides on non-agent nodes and Remote stations", () => {
    const note: CanvasNode = {
      ...managed(),
      ether: undefined,
    };
    expect(renderToStaticMarkup(<OverseerToggleKey nodeId={seed(note)} />)).toBe("");
    state$.settings.station.role.set("remote");
    expect(renderToStaticMarkup(<OverseerToggleKey nodeId={seed(managed())} />)).toBe("");
  });
});
