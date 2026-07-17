import { describe, expect, it } from "vitest";
import {
  HERDR_PICK_WINDOW_MS,
  initialHerdrPickGuard,
  pickFromClick,
  pickFromPointer,
  type HerdrPickGuardState,
} from "../src/renderer/lib/herdr-pick-guard";

const W = HERDR_PICK_WINDOW_MS;

describe("herdr pick guard — pointerdown drives selection", () => {
  it("runs a fresh pointer pick and records the press time", () => {
    const d = pickFromPointer(initialHerdrPickGuard, "a", 1000);
    expect(d.run).toBe(true);
    expect(d.state.lastPointerAt).toBe(1000);
    expect(d.state.last).toEqual({ key: "a", at: 1000 });
  });

  it("suppresses a rapid repeat pick of the same row (double-tap)", () => {
    const first = pickFromPointer(initialHerdrPickGuard, "a", 1000);
    const second = pickFromPointer(first.state, "a", 1000 + W - 1);
    expect(second.run).toBe(false);
    const third = pickFromPointer(first.state, "a", 1000 + W);
    expect(third.run).toBe(true); // window elapsed
  });

  it("allows an immediate pick of a *different* row", () => {
    const first = pickFromPointer(initialHerdrPickGuard, "a", 1000);
    const second = pickFromPointer(first.state, "b", 1010);
    expect(second.run).toBe(true);
  });
});

describe("herdr pick guard — the trailing click of a mouse press is suppressed", () => {
  it("drops the click that follows a pointerdown within the window", () => {
    // Real mouse press: pointerdown advances, list swaps, trailing click lands
    // on a *different* key — must be dropped.
    const press = pickFromPointer(initialHerdrPickGuard, "a", 1000);
    const trailingClick = pickFromClick(press.state, "b", 1050);
    expect(trailingClick.run).toBe(false);
  });

  it("lets a click through once the pointer window has elapsed", () => {
    const press = pickFromPointer(initialHerdrPickGuard, "a", 1000);
    const laterClick = pickFromClick(press.state, "b", 1000 + W);
    expect(laterClick.run).toBe(true);
  });
});

describe("herdr pick guard — keyboard picks still fire", () => {
  it("runs a keyboard click with no preceding pointerdown", () => {
    const d = pickFromClick(initialHerdrPickGuard, "a", 1000);
    expect(d.run).toBe(true);
  });

  it("does not poison the pointer timestamp, so back-to-back keyboard picks both fire", () => {
    // The regression this guards: two keyboard (Enter/Space) picks on different
    // rows within the window must BOTH run — a keyboard pick must not set
    // lastPointerAt or the second would be swallowed as a trailing click.
    const first = pickFromClick(initialHerdrPickGuard, "a", 1000);
    expect(first.run).toBe(true);
    expect(first.state.lastPointerAt).toBe(0); // untouched by a keyboard pick

    const second = pickFromClick(first.state, "b", 1100); // 100ms later, new row
    expect(second.run).toBe(true);
  });

  it("still coalesces a same-row double-Enter", () => {
    const first = pickFromClick(initialHerdrPickGuard, "a", 1000);
    const repeat = pickFromClick(first.state, "a", 1000 + W - 1);
    expect(repeat.run).toBe(false);
  });
});

describe("herdr pick guard — window boundary", () => {
  it("treats exactly the window edge as elapsed (strict <)", () => {
    const state: HerdrPickGuardState = { lastPointerAt: 1000, last: { key: "a", at: 1000 } };
    expect(pickFromClick(state, "b", 1000 + W).run).toBe(true);
    expect(pickFromClick(state, "b", 1000 + W - 1).run).toBe(false);
  });
});
