import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { CanvasNode } from "../src/shared/canvas";
import { managedAgentEther } from "./helpers/managed-agent-ether";
import { EMPTY_SETTINGS, state$ } from "../src/renderer/lib/state";
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

beforeEach(() => {
  state$.settings.set(EMPTY_SETTINGS);
  state$.settings.station.role.set("command-center");
  state$.canvasName.set("Workshop");
});

afterEach(() => {
  state$.settings.set(EMPTY_SETTINGS);
  state$.canvasName.set("");
});

describe("OverseerToggleKey", () => {
  it("grants from the kind strip, not the card", () => {
    const html = renderToStaticMarkup(<OverseerToggleKey node={managed()} />);
    expect(html).toContain('data-testid="rts-overseer"');
    expect(html).toContain('data-overseer="false"');
    expect(html).toContain('aria-label="Grant overseer"');
    expect(html).not.toContain("OVERSEER");
  });

  it("shows revoke when the seat is already overseer", () => {
    const html = renderToStaticMarkup(<OverseerToggleKey node={managed(true)} />);
    expect(html).toContain('data-overseer="true"');
    expect(html).toContain('aria-label="Revoke overseer"');
    expect(html).toContain("var(--color-indigo)");
    expect(html).not.toContain("var(--color-amber)");
    expect(html).not.toContain("var(--color-crimson)");
  });

  it("hides on ordinary unmanaged agents and Remote stations", () => {
    const edge: CanvasNode = {
      ...managed(),
      ether: { entity: { kind: "agent", name: "edge" } },
    };
    expect(renderToStaticMarkup(<OverseerToggleKey node={edge} />)).toBe("");
    state$.settings.station.role.set("remote");
    expect(renderToStaticMarkup(<OverseerToggleKey node={managed()} />)).toBe("");
  });
});
