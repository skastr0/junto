import { reseatCommand, reseatSeat } from "../src/renderer/lib/agent-reseat";
import { state$ } from "../src/renderer/lib/state";
import { modelStore } from "../src/renderer/lib/use-model";
import { asCanvasName } from "../src/shared/model";
import { afterEach, describe, expect, it, vi } from "vitest";
import { newSeat } from "../src/renderer/lib/model-factories";
import { note } from "./support/model-nodes";
import {
  readSkipReseatConfirm,
  reseatChoicesFromConfiguration,
  seatLaunchCwd,
  writeSkipReseatConfirm,
} from "../src/renderer/lib/agent-reseat";

describe("reseatChoicesFromConfiguration", () => {
  it("maps cascade picks into seat options", () => {
    expect(
      reseatChoicesFromConfiguration({
        harness: "hermes",
        profile: "worker",
        model: "m",
        effort: "high",
      }),
    ).toEqual({
      harness: "hermes",
      profile: "worker",
      model: "m",
      effort: "high",
    });
  });
});

describe("skip reseat confirm preference", () => {
  afterEach(() => {
    writeSkipReseatConfirm(false);
  });

  it("defaults off and persists when set", () => {
    const store = new Map<string, string>();
    vi.stubGlobal("localStorage", {
      getItem: (k: string) => store.get(k) ?? null,
      setItem: (k: string, v: string) => {
        store.set(k, v);
      },
      removeItem: (k: string) => {
        store.delete(k);
      },
    });
    expect(readSkipReseatConfirm()).toBe(false);
    writeSkipReseatConfirm(true);
    expect(readSkipReseatConfirm()).toBe(true);
    writeSkipReseatConfirm(false);
    expect(readSkipReseatConfirm()).toBe(false);
    vi.unstubAllGlobals();
  });
});

/**
 * The re-seat that reads the seat from the node store and says one command.
 * It is what the bottom bar and the agent editor call; no document node goes
 * in or comes out.
 */
describe("reseatSeat: a re-seat said as one command", () => {
  const seatRow = () => {
    const row = newSeat({ x: 120, y: 240, z: 3 }, { harness: "claude", host: "studio", cwd: "/Users/me/Projects/junto", label: "cli-identity" });
    const fresh = row;
    return { fresh, row };
  };

  it("the command names the new agent, a fresh binding and how it launches, and nothing else", () => {
    const { row } = seatRow();
    const command = reseatCommand("factory", row, { harness: "grok", model: "big", effort: "high" });
    expect(command._tag).toBe("Reseat");
    expect(command.id).toBe(row.id);
    expect(command.harness).toBe("grok");
    expect(command.agentKey).toBe("studio:grok");
    expect(command.host).toBe(row.host);
    expect(command.bindingId).not.toBe(row.bindingId);
    // The working directory the seat was launched in is kept.
    expect(command.launch?.cwd).toBe("/Users/me/Projects/junto");
    expect(seatLaunchCwd(row)).toBe("/Users/me/Projects/junto");
    // The session is main's to mint and record: none rides in the launch.
    expect(command.launch?.argv).not.toContain("--session-id");
    // A Reseat has no field for a name, a place or an overseer mark.
    expect(Object.keys(command).sort()).toEqual(["_tag", "agentKey", "bindingId", "canvas", "harness", "host", "id", "launch"]);
  });

  it("re-seats the seat the store holds: another agent in the same seat, name and place kept", async () => {
    const { fresh, row } = seatRow();
    state$.canvasName.set("factory");
    const release = modelStore.adopt({ canvas: asCanvasName("factory"), seq: 0, nodes: [fresh], wires: [] });
    try {
      const before = modelStore.canvasOf("factory").nodes.get(row.id);
      const result = await reseatSeat("factory", row.id, { harness: "grok" });
      expect(result).toEqual({ ok: true });
      const after = modelStore.canvasOf("factory").nodes.get(row.id);
      expect(after).toMatchObject({
        kind: "agent", harness: "grok", agentKey: "studio:grok", label: "cli-identity",
        x: before?.x, y: before?.y, width: before?.width, height: before?.height,
      });
      expect(after?.kind === "agent" ? after.bindingId : undefined).not.toBe(row.bindingId);
      expect(after).not.toHaveProperty("sessionId");
    } finally {
      release();
    }
  });

  it("refuses a node that is not a seat, and one that is not there", async () => {
    state$.canvasName.set("factory");
    const release = modelStore.adopt({ canvas: asCanvasName("factory"), seq: 0, nodes: [note("n")], wires: [] });
    try {
      expect(await reseatSeat("factory", "n", { harness: "grok" })).toEqual({ ok: false, message: "not an agent seat" });
      expect(await reseatSeat("factory", "gone", { harness: "grok" })).toEqual({ ok: false, message: "not an agent seat" });
    } finally {
      release();
    }
  });
});
