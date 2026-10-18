/**
 * The operator holds a seat while a window shows its terminal and for a short
 * grace after a key into it. Holds are per window and per binding, and a
 * window that closes, crashes or reloads drops all of its own.
 */
import { EventEmitter } from "node:events";
import { describe, expect, it } from "vitest";
import type { IpcMain, IpcMainInvokeEvent, WebContents } from "electron";
import { makeOperatorHolds, registerOperatorHoldsIpc } from "../src/main/junto/term/operator-holds";
import { IPC_CHANNELS } from "../src/shared/ipc";
import { OPERATOR_TYPED_REPORT_MS, OPERATOR_TYPING_GRACE_MS } from "../src/shared/operator-hold";
import { openSurfaceBindingIds } from "../src/renderer/lib/agent-seat-state";

const T0 = Date.UTC(2026, 9, 18, 12, 0);

const clocked = () => {
  let now = T0;
  const holds = makeOperatorHolds(() => now);
  return { holds, at: (ms: number) => { now = T0 + ms; return now; } };
};

describe("operator holds", () => {
  it("holds a seat while any window shows it, and lets go when none does", () => {
    const { holds } = clocked();
    holds.surfaces(1, ["b1", "b2"]);
    holds.surfaces(2, ["b1"]);
    expect(holds.holds("b1", T0)).toBe(true);
    expect(holds.holds("b3", T0)).toBe(false);
    holds.surfaces(1, ["b2"]);
    expect(holds.holds("b1", T0)).toBe(true);
    holds.surfaces(2, []);
    expect(holds.holds("b1", T0)).toBe(false);
    expect(holds.holds("b2", T0)).toBe(true);
  });

  it("holds for the grace after the last key, on the injected clock", () => {
    const { holds, at } = clocked();
    at(0);
    holds.typed(1, "b1");
    expect(holds.holds("b1", T0 + OPERATOR_TYPING_GRACE_MS - 1)).toBe(true);
    expect(holds.holds("b1", T0 + OPERATOR_TYPING_GRACE_MS)).toBe(false);
    at(10_000);
    holds.typed(1, "b1");
    expect(holds.holds("b1", T0 + OPERATOR_TYPING_GRACE_MS)).toBe(true);
    expect(holds.holds("b1", T0 + 10_000 + OPERATOR_TYPING_GRACE_MS)).toBe(false);
  });

  it("says when a hold ends: never while shown, the latest key's grace when only typed", () => {
    const { holds, at } = clocked();
    expect(holds.hold("b1", T0)).toBeUndefined();
    at(0);
    holds.typed(1, "b1");
    at(5_000);
    holds.typed(2, "b1");
    expect(holds.hold("b1", T0 + 6_000)).toEqual({ until: T0 + 5_000 + OPERATOR_TYPING_GRACE_MS });
    holds.surfaces(1, ["b1"]);
    expect(holds.hold("b1", T0 + 6_000)).toEqual({});
    holds.surfaces(1, []);
    expect(holds.hold("b1", T0 + 5_000 + OPERATOR_TYPING_GRACE_MS)).toBeUndefined();
  });

  it("drops every hold of a window that goes, typing included, and only that window's", () => {
    const { holds } = clocked();
    holds.surfaces(1, ["b1"]);
    holds.typed(1, "b2");
    holds.surfaces(2, ["b3"]);
    holds.dropWindow(1);
    expect(holds.holds("b1", T0)).toBe(false);
    expect(holds.holds("b2", T0)).toBe(false);
    expect(holds.holds("b3", T0)).toBe(true);
  });

  it("reports well inside the grace, so a hold never lapses mid-typing", () => {
    expect(OPERATOR_TYPED_REPORT_MS * 2).toBeLessThan(OPERATOR_TYPING_GRACE_MS);
  });
});

type Listener = (event: IpcMainInvokeEvent, ...args: unknown[]) => unknown;

const wired = () => {
  const handlers = new Map<string, Listener>();
  const ipc = { handle: (channel: string, listener: Listener) => { handlers.set(channel, listener); } };
  const { holds } = clocked();
  registerOperatorHoldsIpc(ipc as unknown as Pick<IpcMain, "handle">, holds);
  const window = (id: number) => {
    const sender = Object.assign(new EventEmitter(), { id }) as unknown as WebContents & EventEmitter;
    const event = { sender } as IpcMainInvokeEvent;
    return {
      sender,
      show: (ids: unknown) => handlers.get(IPC_CHANNELS.seatSurfacesOpen)?.(event, ids),
      type: (id: unknown) => handlers.get(IPC_CHANNELS.seatOperatorTyped)?.(event, id),
    };
  };
  return { holds, window };
};

describe("operator holds over IPC", () => {
  it("a window's report holds its seats until it reloads", () => {
    const { holds, window } = wired();
    const one = window(1);
    one.show(["b1"]);
    one.type("b2");
    expect(holds.holds("b1", T0)).toBe(true);
    // An in-place or subframe navigation is not a reload.
    one.sender.emit("did-start-navigation", {}, "app://x#y", true, true);
    one.sender.emit("did-start-navigation", {}, "app://frame", false, false);
    expect(holds.holds("b1", T0)).toBe(true);
    one.sender.emit("did-start-navigation", {}, "app://x", false, true);
    expect(holds.holds("b1", T0)).toBe(false);
    expect(holds.holds("b2", T0)).toBe(false);
    // The reloaded document reports again on the same window.
    one.show(["b1"]);
    expect(holds.holds("b1", T0)).toBe(true);
  });

  it("a window that crashes or closes drops its holds", () => {
    const { holds, window } = wired();
    const one = window(1);
    const two = window(2);
    one.show(["b1"]);
    two.show(["b2"]);
    one.sender.emit("render-process-gone", {}, {});
    expect(holds.holds("b1", T0)).toBe(false);
    two.sender.emit("destroyed");
    expect(holds.holds("b2", T0)).toBe(false);
  });

  it("ignores reports that are not binding ids", () => {
    const { holds, window } = wired();
    const one = window(1);
    one.show("b1");
    one.type(42);
    one.type("");
    one.show(["b1", 7, ""]);
    expect(holds.holds("b1", T0)).toBe(true);
    expect(holds.holds("", T0)).toBe(false);
  });
});

describe("open surface bindings", () => {
  it("joins a node's own binding and the inventory join, once each, sorted", () => {
    const open = {
      n1: { id: "n1", kind: "agent", bindingId: "b2" },
      n2: { id: "n2", kind: "note" },
    } as unknown as Parameters<typeof openSurfaceBindingIds>[0];
    expect(openSurfaceBindingIds(open, { n1: "b2", n2: "b1", n3: "b9" })).toEqual(["b1", "b2"]);
  });
});
