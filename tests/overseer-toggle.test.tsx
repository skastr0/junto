import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { Node } from "../src/shared/model";
import { seat, note } from "./support/model-nodes";
import { EMPTY_SETTINGS, state$ } from "../src/renderer/lib/state";
import { modelStore } from "../src/renderer/lib/use-model";
import { OverseerToggleKey } from "../src/renderer/components/rts/OverseerToggle";

const managed = (overseer = false) => seat("seat", { label: "worker", overseer });

const seed = (node: Node): string => {
  modelStore.canvas$("Workshop").nodes.set({ [node.id]: node });
  modelStore.canvas$("Workshop").nodeIds.set([node.id]);
  return node.id;
};

beforeEach(() => {
  state$.settings.set(EMPTY_SETTINGS);
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

  it("hides on a node that is not a seat", () => {
    expect(renderToStaticMarkup(<OverseerToggleKey nodeId={seed(note("note"))} />)).toBe("");
  });
});
