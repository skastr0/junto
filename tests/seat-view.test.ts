/**
 * Opening a seat on a named view: the ask a seat's surface reads, and the one
 * call that makes it (`openSeatOn`).
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Node } from "../src/shared/model";
import { note, seat, terminal } from "./support/model-nodes";

const world = vi.hoisted(() => ({ nodes: new Map<string, unknown>() }));
vi.mock("../src/window/lib/use-model", () => ({
  nodeAt: (canvas: string, id: string) => (canvas === "factory" ? world.nodes.get(id) : undefined),
}));
vi.mock("../src/window/lib/terminal-actions", () => ({
  openTerminal: vi.fn(async () => undefined),
}));

import { answerSeatViewAsk, openSeatOn, seatViewAsked$ } from "../src/window/lib/seat-view";
import { openTerminal } from "../src/window/lib/terminal-actions";

const opened = vi.mocked(openTerminal);
const put = (...nodes: Node[]): void => {
  for (const node of nodes) world.nodes.set(node.id, node);
};

beforeEach(() => {
  world.nodes.clear();
  opened.mockClear();
  seatViewAsked$.set({});
});
afterEach(() => {
  seatViewAsked$.set({});
});

describe("openSeatOn", () => {
  it("asks for the view, then opens the seat as any open does", async () => {
    put(seat("seat-1"));
    await openSeatOn("factory", "seat-1", "threads");
    expect(seatViewAsked$["seat-1"].peek()).toBe("threads");
    expect(opened.mock.calls).toEqual([["factory", "seat-1"]]);
  });

  it("asks for Terminal as plainly as for Threads", async () => {
    put(seat("seat-1"));
    await openSeatOn("factory", "seat-1", "terminal");
    expect(seatViewAsked$["seat-1"].peek()).toBe("terminal");
  });

  it("leaves alone what has no seat view: a plain terminal, a note, a node that is gone, another canvas", async () => {
    put(terminal("shell-1"), note("note-1"), seat("seat-1"));
    await openSeatOn("factory", "shell-1", "threads");
    await openSeatOn("factory", "note-1", "threads");
    await openSeatOn("factory", "gone", "threads");
    await openSeatOn("elsewhere", "seat-1", "threads");
    expect(seatViewAsked$.peek()).toEqual({});
    expect(opened).not.toHaveBeenCalled();
  });

  it("is answered once: the surface that took the ask leaves nothing for the next open", () => {
    seatViewAsked$["seat-1"].set("threads");
    answerSeatViewAsk("seat-1");
    expect(seatViewAsked$["seat-1"].peek()).toBeUndefined();
    // Answering nothing is nothing.
    answerSeatViewAsk("seat-1");
    expect(seatViewAsked$.peek()).toEqual({});
  });
});
