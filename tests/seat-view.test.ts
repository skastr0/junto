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
import { terminalGrid$ } from "../src/window/lib/terminal-grid-state";
import { dropTerminalView, terminal$ } from "../src/window/lib/terminal-state";

const opened = vi.mocked(openTerminal);
const put = (...nodes: Node[]): void => {
  for (const node of nodes) world.nodes.set(node.id, node);
};

beforeEach(() => {
  world.nodes.clear();
  opened.mockClear();
  seatViewAsked$.set({});
  terminal$.openByNodeId.set({});
  terminal$.gridOwnedByNodeId.set({});
  terminalGrid$.nodeIds.set([]);
});
afterEach(() => {
  seatViewAsked$.set({});
  terminal$.openByNodeId.set({});
  terminal$.gridOwnedByNodeId.set({});
  terminalGrid$.nodeIds.set([]);
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

  it("ends with the seat's view: an ask nothing took is gone when that view closes, so the next open starts on the setting", async () => {
    const one = seat("seat-1");
    const two = seat("seat-2");
    put(one, two);
    // Both open, as a grid holds them: no surface offers the two views.
    terminal$.openByNodeId.set({ "seat-1": one, "seat-2": two });
    await openSeatOn("factory", "seat-1", "threads");
    expect(seatViewAsked$["seat-1"].peek()).toBe("threads");

    // Another seat's view closing is not this one's.
    dropTerminalView("seat-2");
    expect(seatViewAsked$["seat-1"].peek()).toBe("threads");

    // Its own view closes before any surface took the ask.
    dropTerminalView("seat-1");
    expect(seatViewAsked$.peek()).toEqual({});
  });

  it("waits through the open it was made with: a closed seat's ask is there when its view opens", async () => {
    const one = seat("seat-1");
    put(one);
    opened.mockImplementationOnce(async () => {
      terminal$.openByNodeId["seat-1"].set(one);
    });
    await openSeatOn("factory", "seat-1", "threads");
    expect(seatViewAsked$["seat-1"].peek()).toBe("threads");
  });

  it("opens a seat the grid shows out of the grid: the grid closes, the seat stays open on the view, the other cells go", async () => {
    const one = seat("seat-1");
    const two = seat("seat-2");
    put(one, two);
    terminal$.openByNodeId.set({ "seat-1": one, "seat-2": two });
    terminal$.gridOwnedByNodeId.set({ "seat-1": true, "seat-2": true });
    terminalGrid$.nodeIds.set(["seat-1", "seat-2"]);
    // The real open takes the seat out of the grid's hands as it joins the workbench.
    opened.mockImplementationOnce(async () => {
      terminal$.gridOwnedByNodeId["seat-1"].delete();
    });
    await openSeatOn("factory", "seat-1", "threads");
    expect(terminalGrid$.nodeIds.peek()).toEqual([]);
    expect(terminal$.openByNodeId.peek()["seat-1"]).toBe(one);
    expect(terminal$.openByNodeId.peek()["seat-2"]).toBeUndefined();
    expect(seatViewAsked$["seat-1"].peek()).toBe("threads");
  });

  it("leaves the grid alone when the seat is not one of its cells", async () => {
    const one = seat("seat-1");
    const two = seat("seat-2");
    put(one, two);
    terminal$.openByNodeId.set({ "seat-2": two });
    terminalGrid$.nodeIds.set(["seat-2"]);
    await openSeatOn("factory", "seat-1", "threads");
    expect(terminalGrid$.nodeIds.peek()).toEqual(["seat-2"]);
  });
});
