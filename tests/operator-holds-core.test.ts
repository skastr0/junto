/**
 * The operator's holds reach the core (0.11.7).
 *
 * The window says which terminals it shows, and when the operator typed into
 * one. Everything that asks is in the core, where the seats and their views
 * run: the cache cut that ends an idle seat's session (seat-sessions/
 * operator-offboard-live.ts), the clock a key warms, and the Hold frame a
 * peer's view carries to the seat's own machine. Main kept the map, so its
 * reports never reached the cut and a seat the operator was watching could be
 * offboarded under their hands.
 *
 * This drives the real boundary: main's ipcMain handler, the core operation it
 * calls, and the holds the core reads. One process cannot hold two maps, so the
 * split is also pinned in the source: main keeps none.
 */
import { EventEmitter } from "node:events";
import { readFileSync } from "node:fs";
import { Layer, ManagedRuntime } from "effect";
import { afterEach, describe, expect, it } from "vitest";
import type { IpcMain, IpcMainInvokeEvent, WebContents } from "electron";
import { IPC_CHANNELS } from "../src/shared/ipc";
import { runCoreOp, type CoreClient } from "../src/main/core-process/client";
import { coreOperatorHolds } from "../src/main/core-process/ops/seat-holds";
import "../src/main/core-process/ops/seat-holds";
import { operatorHolds, subscribeOperatorTyped } from "../src/main/junto/term/operator-holds";
import { registerOperatorHoldsIpc } from "../src/main/junto/term/operator-holds-ipc";

const source = (relative: string): string =>
  readFileSync(new URL(`../${relative}`, import.meta.url), "utf8");

let nextWindowId = 9_400;
const runtimes: Array<ManagedRuntime.ManagedRuntime<never, never>> = [];

afterEach(async () => {
  for (const runtime of runtimes.splice(0)) await runtime.dispose();
});

const wired = () => {
  const runtime = ManagedRuntime.make(Layer.empty);
  runtimes.push(runtime as never);
  // The core's side of the port, in this process: the operations run on its runtime.
  const core: CoreClient = {
    call: (async (name: string, input: unknown) => {
      const answer = await runCoreOp(runtime as never, name, input);
      if (!answer.ok) throw new Error(answer.failure.message);
      return answer.value;
    }) as CoreClient["call"],
  };
  const handlers = new Map<string, (event: IpcMainInvokeEvent, arg: unknown) => unknown>();
  registerOperatorHoldsIpc(
    { handle: (channel: string, listener: (event: IpcMainInvokeEvent, arg: unknown) => unknown) => { handlers.set(channel, listener); } } as unknown as Pick<IpcMain, "handle">,
    coreOperatorHolds(core),
  );
  const sender = Object.assign(new EventEmitter(), { id: nextWindowId++ }) as unknown as WebContents & EventEmitter;
  const event = { sender } as IpcMainInvokeEvent;
  const send = async (channel: string, arg: unknown): Promise<void> => {
    await handlers.get(channel)?.(event, arg);
  };
  return {
    core,
    show: (ids: unknown) => send(IPC_CHANNELS.seatSurfacesOpen, ids),
    type: (id: unknown) => send(IPC_CHANNELS.seatOperatorTyped, id),
    sender,
  };
};

describe("the operator's holds in the core", () => {
  it("holds the seats a window shows, at the cut that asks", async () => {
    const { show } = wired();
    await show(["hold-shown-a", "hold-shown-b"]);
    const now = Date.now();
    expect(operatorHolds("hold-shown-a", now)).toBe(true);
    expect(operatorHolds("hold-shown-b", now)).toBe(true);
    // A later list replaces the window's earlier one: a seat it stops showing is let go.
    await show(["hold-shown-a"]);
    expect(operatorHolds("hold-shown-b", Date.now())).toBe(false);
    expect(operatorHolds("hold-shown-a", Date.now())).toBe(true);
  });

  it("warms the clock of a seat the operator types into", async () => {
    const { type } = wired();
    const warmed: string[] = [];
    const off = subscribeOperatorTyped((bindingId) => warmed.push(bindingId));
    try {
      await type("hold-typed");
      expect(warmed).toEqual(["hold-typed"]);
      expect(operatorHolds("hold-typed", Date.now())).toBe(true);
    } finally {
      off();
    }
  });

  it("drops every hold a window had when it reloads or closes", async () => {
    const first = wired();
    await first.show(["hold-reloaded"]);
    await first.type("hold-reloaded-typed");
    first.sender.emit("did-start-navigation", {}, "app://junto", false, true);
    expect(operatorHolds("hold-reloaded", Date.now())).toBe(false);
    expect(operatorHolds("hold-reloaded-typed", Date.now())).toBe(false);

    const second = wired();
    await second.show(["hold-closed"]);
    second.sender.emit("destroyed");
    expect(operatorHolds("hold-closed", Date.now())).toBe(false);
  });

  it("refuses a report that is not binding ids", async () => {
    const { show, type } = wired();
    await show("hold-not-a-list");
    await show([42, "", "hold-valid"]);
    await type(42);
    await type("");
    expect(operatorHolds("hold-valid", Date.now())).toBe(true);
    expect(operatorHolds("", Date.now())).toBe(false);
  });

  it("keeps no map in main: the reports go to the core, which keeps them", () => {
    const ipc = source("src/main/junto/ipc.ts");
    expect(ipc).toContain("coreOperatorHolds(core)");
    expect(ipc).not.toContain('from "./term/operator-holds"');
    // The window's half imports no map, and the map's module registers no IPC.
    expect(source("src/main/junto/term/operator-holds-ipc.ts")).not.toContain("makeOperatorHolds");
    expect(source("src/main/junto/term/operator-holds.ts")).not.toContain("IpcMain");
  });
});
