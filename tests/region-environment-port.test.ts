/**
 * The screen's port bound to the app: a bridge that lacks a method answers in
 * words, a failure never repeats what was thrown (an IPC error can quote its
 * arguments, and one of them is a secret), the report is asked for only after
 * the canvas is saved, and a restart is the renderer's one seat restart.
 */
import { afterEach, describe, expect, it, vi } from "vitest";
import type { CanvasNode } from "../src/shared/canvas";

const bridge: { current: Record<string, unknown> | undefined } = { current: undefined };
vi.mock("../src/renderer/lib/junto-api", () => ({ getJuntoApi: () => bridge.current }));

const { regionEnvironmentPort } = await import("../src/renderer/lib/region-environment-port");

const seat = { id: "seat-1", type: "text", text: "planner", x: 0, y: 0, width: 1, height: 1 } as CanvasNode;
const region = { id: "region-1", type: "group", label: "R", x: 0, y: 0, width: 1, height: 1 } as CanvasNode;

const rig = (restart: { ok: true; restarted: boolean } | { ok: false; message: string } = { ok: true, restarted: true }) => {
  const order: string[] = [];
  const restarted: string[] = [];
  const port = regionEnvironmentPort({
    canvasName: () => "factory",
    flushSave: async () => {
      order.push("saved");
    },
    findNode: (id) => [seat, region].find((node) => node.id === id),
    restartSeat: async (node) => {
      restarted.push(node.id);
      return restart;
    },
  });
  return { port, order, restarted };
};

afterEach(() => {
  bridge.current = undefined;
});

describe("regionEnvironmentPort", () => {
  it("says what it cannot do when the bridge has no such method, or there is no bridge", async () => {
    const { port } = rig();
    expect(await port.report("r1")).toEqual({ ok: false, message: "This build of Junto cannot do that yet." });
    bridge.current = {};
    expect(await port.saveSecret({ regionId: "r1", name: "K", value: "v" })).toEqual({
      ok: false,
      message: "This build of Junto cannot do that yet.",
    });
  });

  it("stores a secret through the bridge as given", async () => {
    const saveSecret = vi.fn(async () => ({ ok: true as const, secretId: "sec-1" }));
    const removeSecret = vi.fn(async () => ({ ok: true as const }));
    bridge.current = { regionEnvSaveSecret: saveSecret, regionEnvRemoveSecret: removeSecret };
    const { port } = rig();
    expect(await port.saveSecret({ regionId: "r1", name: "K", value: "v" })).toEqual({ ok: true, secretId: "sec-1" });
    expect(saveSecret).toHaveBeenCalledWith({ regionId: "r1", name: "K", value: "v" });
    expect(await port.removeSecret("sec-1")).toEqual({ ok: true });
    expect(removeSecret).toHaveBeenCalledWith("sec-1");
  });

  it("asks for the report and the stale seats by canvas, only after the canvas is saved", async () => {
    const { port, order } = rig();
    bridge.current = {
      regionEnvReport: async (canvasName: string, regionId: string) => {
        order.push(`report:${canvasName}:${regionId}`);
        return { ok: true as const, report: [] };
      },
      regionEnvStaleSeats: async (canvasName: string, regionId: string) => {
        order.push(`stale:${canvasName}:${regionId}`);
        return { ok: true as const, seats: [] };
      },
    };
    expect(await port.report("r1")).toEqual({ ok: true, report: [] });
    expect(await port.staleSeats("r1")).toEqual({ ok: true, seats: [] });
    // Main answers from the saved document: an edit must be on disk first.
    expect(order).toEqual(["saved", "report:factory:r1", "saved", "stale:factory:r1"]);
  });

  it("restarts a seat with the one seat restart, on the node the canvas has", async () => {
    const { port, restarted } = rig();
    expect(await port.restartSeat("seat-1")).toEqual({ ok: true });
    expect(restarted).toEqual(["seat-1"]);
  });

  it("a seat that is not running is not a failure; a refusal keeps its words", async () => {
    expect(await rig({ ok: true, restarted: false }).port.restartSeat("seat-1")).toEqual({ ok: true });
    expect(await rig({ ok: false, message: "The seat is mid-turn." }).port.restartSeat("seat-1")).toEqual({
      ok: false,
      message: "The seat is mid-turn.",
    });
  });

  it("does not restart something that is not a seat, or is gone", async () => {
    const { port, restarted } = rig();
    const gone = { ok: false, message: "That seat is no longer on the canvas." };
    expect(await port.restartSeat("region-1")).toEqual(gone);
    expect(await port.restartSeat("nope")).toEqual(gone);
    expect(restarted).toEqual([]);
  });

  it("never repeats a thrown error, which could quote the secret it was given", async () => {
    bridge.current = {
      regionEnvSaveSecret: async (input: { value: string }) => {
        throw new Error(`invoke failed with args ${JSON.stringify(input)}`);
      },
    };
    const result = await rig().port.saveSecret({ regionId: "r1", name: "K", value: "hunter2" });
    expect(result).toEqual({ ok: false, message: "Junto could not complete that. Try again." });
    expect(JSON.stringify(result)).not.toContain("hunter2");
  });
});
