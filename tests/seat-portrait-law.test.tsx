// @vitest-environment jsdom
/**
 * Seat portrait law (AGENTS.md): a seat, wherever it is named as a chip or a
 * mark, wears its portrait, never a glyph. This test is the lock: it fails
 * if a seat chip or mark renders without a portrait or with the robot, and
 * if the visuals table names a glyph for seats again.
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { ResourceChip, ResourceGlyphMark } from "../src/renderer/components/ui";
import { mentionMark } from "../src/renderer/components/ui/ResourceChip";
import { PostText } from "../src/renderer/components/tasks/TaskThread";
import { RESOURCE_KIND_VISUAL } from "../src/renderer/lib/resource-visuals";
import { mentionLink } from "../src/shared/mention";
import { asNodeId } from "../src/shared/physics/schema";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

let host: HTMLDivElement;
let root: Root;
const render = (node: React.ReactNode) => act(() => root.render(node));

beforeEach(() => {
  host = document.createElement("div");
  document.body.appendChild(host);
  root = createRoot(host);
});

afterEach(() => {
  act(() => root.unmount());
  host.remove();
});

/** A seat drawn right: one portrait image, no glyph, no robot. */
const expectPortrait = (scope: Element | null): string => {
  expect(scope).not.toBeNull();
  const portrait = scope!.querySelector('[data-testid="seat-portrait-mark"] .agent-portrait img.agent-portrait__face:not(.agent-portrait__face--prev)');
  expect(portrait).not.toBeNull();
  expect(scope!.querySelector(".lucide-bot")).toBeNull();
  expect(scope!.querySelector(".resource-chip__glyph")).toBeNull();
  return portrait!.getAttribute("src") ?? "";
};

describe("seat portrait law", () => {
  it("a seat chip wears its portrait in every state: plain, openable, queued, missing", () => {
    for (const state of [{}, { onOpen: () => undefined }, { pending: true }, { missing: true }]) {
      render(<ResourceChip kind="seat" seat="agent-01" label="product-feed" {...state} />);
      expectPortrait(host.querySelector(".resource-chip"));
    }
  });

  it("the portrait is the seat's identity, and a seat with none here is drawn from its name", () => {
    render(<ResourceChip kind="seat" seat="agent-01" label="product-feed" />);
    const byId = expectPortrait(host.querySelector(".resource-chip"));
    render(<ResourceChip kind="seat" label="product-feed" />);
    const byName = expectPortrait(host.querySelector(".resource-chip"));
    expect(byName).not.toBe(byId);
    render(<ResourceChip kind="seat" seat="product-feed" label="product-feed" />);
    expect(expectPortrait(host.querySelector(".resource-chip"))).toBe(byName);
  });

  it("a seat mark in a list is the same portrait, and a seat mention's mark carries its node", () => {
    render(<ResourceGlyphMark kind="seat" seat="agent-01" />);
    expectPortrait(host);
    expect(mentionMark({ kind: "seat", nodeId: asNodeId("agent-01") })).toEqual({ kind: "seat", seat: "agent-01" });
  });

  it("a seat mentioned in a task or artifact comment wears its node's portrait, and a gone one its name's", () => {
    const seatOf = (text: string) => {
      render(<PostText text={text} nodeKindOf={(id) => (id === "agent-01" ? "agent" : undefined)} onOpen={() => undefined} />);
      return expectPortrait(host.querySelector(".resource-chip"));
    };
    const live = seatOf(mentionLink({ kind: "seat", nodeId: asNodeId("agent-01") }, "@product-feed", "factory"));
    render(<ResourceChip kind="seat" seat="agent-01" label="product-feed" />);
    expect(live).toBe(expectPortrait(host.querySelector(".resource-chip")));
    const gone = seatOf(mentionLink({ kind: "seat", nodeId: asNodeId("agent-02") }, "@Xan", "factory"));
    render(<ResourceChip kind="seat" label="Xan" />);
    expect(gone).toBe(expectPortrait(host.querySelector(".resource-chip")));
  });

  it("other kinds keep their glyph and never a portrait", () => {
    render(<ResourceChip kind="task" number={42} label="fix tabs" />);
    expect(host.querySelector(".resource-chip__glyph")).not.toBeNull();
    expect(host.querySelector('[data-testid="seat-portrait-mark"]')).toBeNull();
  });

  it("no glyph is named for seats, and the chip never imports the robot", () => {
    expect(RESOURCE_KIND_VISUAL.seat).not.toHaveProperty("glyph");
    const chip = readFileSync(join(__dirname, "../src/renderer/components/ui/ResourceChip.tsx"), "utf8");
    expect(chip).not.toMatch(/\bBot\b/);
  });
});
