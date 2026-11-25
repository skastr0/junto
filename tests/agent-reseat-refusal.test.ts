// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { asCanvasName } from "../src/shared/model";
import { reseatSeats } from "../src/window/lib/agent-reseat";
import { state$ } from "../src/window/lib/state";
import { newSeat } from "../src/window/lib/model-factories";
import { modelStore } from "../src/window/lib/use-model";

/**
 * A re-seat stops each old process, but only once the canvas has taken the
 * commands: a canvas that refuses, here or in main, leaves every picked seat
 * running on its old harness, nothing stopped.
 */
describe("reseatSeats: a canvas that takes no edits stops no seat", () => {
  const terminalKill = vi.fn(async () => undefined);
  const terminalGet = vi.fn(async () => undefined);

  beforeEach(() => {
    terminalKill.mockClear();
    terminalGet.mockClear();
    (window as unknown as { junto: unknown }).junto = { terminalKill, terminalGet };
  });

  afterEach(() => {
    delete (window as unknown as { junto?: unknown }).junto;
  });

  it("leaves every picked seat's process alone and reports each as refused", async () => {
    const a = newSeat({ x: 0, y: 0, z: 1 }, { harness: "claude", host: "studio", cwd: "/p/a", label: "a" });
    const b = newSeat({ x: 0, y: 0, z: 2 }, { harness: "codex", host: "studio", cwd: "/p/b", label: "b" });
    // The store holds "factory", but the window has another canvas open: "factory" takes no edit.
    state$.canvasName.set("elsewhere");
    const release = modelStore.adopt({ canvas: asCanvasName("factory"), seq: 0, nodes: [a, b], wires: [] });
    try {
      const outcome = await reseatSeats("factory", [a.id, b.id], { harness: "grok" });
      expect(terminalKill).not.toHaveBeenCalled();
      expect(outcome).toEqual({
        moved: [],
        unchanged: [],
        failed: [
          { id: a.id, message: "the canvas is not open for edits" },
          { id: b.id, message: "the canvas is not open for edits" },
        ],
      });
      const nodes = modelStore.canvasOf("factory").nodes;
      expect(nodes.get(a.id)).toMatchObject({ harness: "claude", bindingId: a.bindingId });
      expect(nodes.get(b.id)).toMatchObject({ harness: "codex", bindingId: b.bindingId });
    } finally {
      release();
    }
  });

  const seatsOnFactory = () => {
    const a = newSeat({ x: 0, y: 0, z: 1 }, { harness: "claude", host: "studio", cwd: "/p/a", label: "a" });
    const b = newSeat({ x: 0, y: 0, z: 2 }, { harness: "codex", host: "studio", cwd: "/p/b", label: "b" });
    return { a, b, rows: [a, b] };
  };
  /** Main, as far as a re-seat goes: it takes or refuses the command, and a re-read gives back `rows`. */
  const mainAnswers = (rows: ReadonlyArray<unknown>, say: (command: { readonly id: string }) => Promise<{ seq: number }>) => {
    (window as unknown as { junto: unknown }).junto = {
      terminalKill,
      terminalGet,
      modelCommand: say,
      modelOpen: async () => ({ canvas: "factory", seq: 0, nodes: rows, wires: [] }),
      onModelChanged: () => () => undefined,
    };
  };

  it("a refusal from main stops nothing and leaves each seat on its old binding", async () => {
    const { a, b, rows } = seatsOnFactory();
    mainAnswers(rows, async () => {
      throw new Error("main says no");
    });
    state$.canvasName.set("factory");
    const release = modelStore.adopt({ canvas: asCanvasName("factory"), seq: 0, nodes: [a, b], wires: [] });
    try {
      const outcome = await reseatSeats("factory", [a.id, b.id], { harness: "grok" });
      expect(terminalKill).not.toHaveBeenCalled();
      expect(outcome).toEqual({
        moved: [],
        unchanged: [],
        failed: [
          { id: a.id, message: "main says no" },
          { id: b.id, message: "main says no" },
        ],
      });
    } finally {
      release();
    }
  });

  it("once main has taken the commands each old binding is stopped, and only the old one", async () => {
    const { a, b, rows } = seatsOnFactory();
    const order: string[] = [];
    const said: Array<{ readonly id: string; readonly bindingId: string }> = [];
    mainAnswers(rows, async (command) => {
      order.push("say");
      // The seats go as one Batch of a Reseat each.
      const batch = command as unknown as { readonly _tag: string; readonly steps?: ReadonlyArray<never> };
      said.push(...((batch._tag === "Batch" ? batch.steps : [command]) as typeof said));
      return { seq: 1 };
    });
    terminalKill.mockImplementation(async () => {
      order.push("kill");
      return undefined;
    });
    state$.canvasName.set("factory");
    const release = modelStore.adopt({ canvas: asCanvasName("factory"), seq: 0, nodes: [a, b], wires: [] });
    try {
      const outcome = await reseatSeats("factory", [a.id, b.id], { harness: "grok" });
      expect(outcome.moved).toEqual([a.id, b.id]);
      // Said before any stop.
      expect(order).toEqual(["say", "kill", "kill"]);
      expect(said).toHaveLength(2);
      const killed = terminalKill.mock.calls.map((call) => (call as unknown as [string, string])[0]);
      expect(killed.sort()).toEqual([a.bindingId, b.bindingId].sort());
      // The binding said is never the one stopped: the late stop cannot reach the new process.
      for (const command of said) expect(killed).not.toContain(command.bindingId);
      for (const seat of [a, b]) {
        const command = said.find((one) => one.id === seat.id);
        expect(command?.bindingId).not.toBe(seat.bindingId);
      }
    } finally {
      release();
      terminalKill.mockImplementation(async () => undefined);
    }
  });
});
