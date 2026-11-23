import { reseatCommand, reseatSeat } from "../src/window/lib/agent-reseat";
import { state$ } from "../src/window/lib/state";
import { modelStore } from "../src/window/lib/use-model";
import { asCanvasName } from "../src/shared/model";
import { afterEach, describe, expect, it, vi } from "vitest";
import { newSeat } from "../src/window/lib/model-factories";
import { note } from "./support/model-nodes";
import {
  readSkipReseatConfirm,
  reseatChoicesFromConfiguration,
  reseatOutcomeLine,
  reseatPickLabel,
  reseatSeats,
  seatLaunchCwd,
  seatRunsPick,
  writeSkipReseatConfirm,
} from "../src/window/lib/agent-reseat";
import { recoverDocumentLaunchChoices } from "../src/shared/launch-choices";

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

  it("keeps the permission mode and the extra arguments", () => {
    expect(
      reseatChoicesFromConfiguration({
        harness: "claude",
        model: "opus",
        permissionMode: "plan",
        extraArgs: ["--verbose"],
      }),
    ).toEqual({ harness: "claude", model: "opus", permissionMode: "plan", extraArgs: ["--verbose"] });
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

/**
 * Several seats re-seated onto one pick, as one act: a seat already on that
 * exact pick is left alone, a node that is not a seat fails, and every other
 * seat moves.
 */
describe("reseatSeats: one pick for many seats", () => {
  const seatAt = (label: string, choices: Omit<Parameters<typeof newSeat>[1], "host">) =>
    newSeat({ x: 0, y: 0, z: 1 }, { host: "studio", cwd: `/Users/me/Projects/${label}`, label, ...choices });

  it("moves every seat not already on the pick, in one act, and counts the rest", async () => {
    const onClaude = seatAt("a", { harness: "claude" });
    const onCodex = seatAt("b", { harness: "codex", model: "gpt-5" });
    const already = seatAt("c", { harness: "claude", model: "opus", effort: "xhigh", permissionMode: "plan" });
    state$.canvasName.set("factory");
    const release = modelStore.adopt({
      canvas: asCanvasName("factory"),
      seq: 0,
      nodes: [onClaude, onCodex, already, note("n")],
      wires: [],
    });
    try {
      const pick = { harness: "claude", model: "opus", effort: "xhigh", permissionMode: "plan" } as const;
      expect(seatRunsPick(already, pick)).toBe(true);
      const outcome = await reseatSeats("factory", [onClaude.id, onCodex.id, already.id, "n"], pick);
      expect(outcome).toEqual({
        moved: [onClaude.id, onCodex.id],
        unchanged: [already.id],
        failed: [{ id: "n", message: "not an agent seat" }],
      });
      const nodes = modelStore.canvasOf("factory").nodes;
      for (const seat of [onClaude, onCodex]) {
        const after = nodes.get(seat.id);
        expect(after?.kind).toBe("agent");
        if (after?.kind !== "agent") continue;
        expect(after.harness).toBe("claude");
        expect(after.label).toBe(seat.label);
        expect(after.launch?.cwd).toBe(seat.launch?.cwd);
        expect(after.bindingId).not.toBe(seat.bindingId);
        // Every dial of the pick reaches the launch, permission mode included.
        expect(recoverDocumentLaunchChoices("claude", after.launch)).toMatchObject({
          model: "opus",
          effort: "xhigh",
          permissionMode: "plan",
        });
      }
      // The seat already on the pick keeps its binding: its process was not touched.
      const kept = nodes.get(already.id);
      expect(kept?.kind === "agent" ? kept.bindingId : undefined).toBe(already.bindingId);
    } finally {
      release();
    }
  });

  it("a seat on the same harness with another dial is not on the pick", () => {
    const seat = seatAt("d", { harness: "claude", model: "opus" });
    expect(seatRunsPick(seat, { harness: "claude", model: "opus" })).toBe(true);
    expect(seatRunsPick(seat, { harness: "claude", model: "opus", effort: "high" })).toBe(false);
    expect(seatRunsPick(seat, { harness: "claude" })).toBe(false);
    expect(seatRunsPick(seat, { harness: "codex", model: "opus" })).toBe(false);
  });
});

describe("reseat lines the operator reads", () => {
  it("a pick reads as its harness and each dial it sets", () => {
    expect(reseatPickLabel({ harness: "claude", model: "opus", effort: "xhigh" })).toBe("Claude Code, opus, xhigh");
    expect(reseatPickLabel({ harness: "codex" })).toBe("Codex");
  });

  it("a re-seat of several says how many moved, how many were on it, and which failed", () => {
    const names: Record<string, string> = { a: "cli-lead", b: "cli-skill" };
    const nameOf = (id: string) => names[id] ?? id;
    expect(reseatOutcomeLine({ moved: ["x", "y", "z"], unchanged: ["w"], failed: [] }, nameOf)).toBe(
      "3 re-seated, 1 already on it",
    );
    expect(
      reseatOutcomeLine({ moved: ["x"], unchanged: [], failed: [{ id: "a", message: "not an agent seat" }] }, nameOf),
    ).toBe("1 re-seated, 1 failed: cli-lead (not an agent seat)");
    expect(reseatOutcomeLine({ moved: [], unchanged: ["a", "b"], failed: [] }, nameOf)).toBe("2 already on it");
  });
});
