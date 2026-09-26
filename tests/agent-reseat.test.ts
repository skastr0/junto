import { afterEach, describe, expect, it, vi } from "vitest";
import {
  buildManagedAgentSeat,
  makeManagedAgentNode,
  reseatManagedAgentNode,
} from "../src/renderer/lib/node-factories";
import {
  readSkipReseatConfirm,
  reseatChoicesFromConfiguration,
  seatLaunchCwd,
  writeSkipReseatConfirm,
} from "../src/renderer/lib/agent-reseat";
import { reseatPopPositionStyle } from "../src/renderer/components/rts/AgentReseatControl";

describe("buildManagedAgentSeat / reseatManagedAgentNode", () => {
  it("builds the same seat fields for create and re-seat", () => {
    const created = makeManagedAgentNode(10, 20, {
      harness: "codex",
      host: "local",
      model: "gpt-5.6",
    });
    const fields = buildManagedAgentSeat({
      harness: "codex",
      host: "local",
      model: "gpt-5.6",
    });
    expect(created.ether?.terminal?.harness).toBe(fields.ether.terminal?.harness);
    expect(created.ether?.entity?.kind).toBe("agent");
    expect(fields.ether.entity?.name).toContain("codex");
  });

  it("preserves node id and geometry while minting a new binding", () => {
    const original = makeManagedAgentNode(40, 60, {
      harness: "codex",
      host: "local",
    });
    const priorBinding = original.ether?.terminal?.bindingId;
    expect(priorBinding).toBeTruthy();

    const next = reseatManagedAgentNode(original, {
      harness: "claude",
      model: "sonnet",
    });

    expect(next.id).toBe(original.id);
    expect(next.x).toBe(original.x);
    expect(next.y).toBe(original.y);
    expect(next.ether?.terminal?.harness).toBe("claude");
    expect(next.ether?.terminal?.bindingId).toBeTruthy();
    expect(next.ether?.terminal?.bindingId).not.toBe(priorBinding);
    expect(next.ether?.host).toBe("local");
    expect(next.text.toLowerCase()).toContain("claude");
  });

  it("preserves launch cwd when reseating with prior path", () => {
    const original = makeManagedAgentNode(0, 0, {
      harness: "codex",
      host: "local",
      cwd: "/Users/me/Projects/junto",
    });
    expect(seatLaunchCwd(original)).toBe("/Users/me/Projects/junto");
    const next = reseatManagedAgentNode(
      original,
      reseatChoicesFromConfiguration(
        { harness: "claude", model: "sonnet" },
        seatLaunchCwd(original),
      ),
    );
    expect(next.ether?.terminal?.launch?.cwd).toBe("/Users/me/Projects/junto");
    expect(next.ether?.terminal?.harness).toBe("claude");
  });

  it("refuses non-agent nodes", () => {
    expect(() =>
      reseatManagedAgentNode(
        {
          id: "n1",
          type: "text",
          text: "note",
          x: 0,
          y: 0,
          width: 100,
          height: 40,
        },
        { harness: "codex" },
      ),
    ).toThrow(/agent node/);
  });
});

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

describe("reseatPopPositionStyle", () => {
  it("opens upward with fixed layer above the canvas", () => {
    const style = reseatPopPositionStyle(
      { left: 100, top: 700, right: 126, bottom: 726, width: 26, height: 26, x: 100, y: 700, toJSON: () => ({}) },
      { width: 1200, height: 800 },
    );
    expect(style.position).toBe("fixed");
    expect(style.zIndex).toBe(10001);
    expect(style.left).toBe(100);
    // bottom = viewportHeight - anchor.top + gap
    expect(style.bottom).toBe(800 - 700 + 8);
  });

  it("clamps left edge when the key is near the right edge", () => {
    const style = reseatPopPositionStyle(
      { left: 1100, top: 700, right: 1126, bottom: 726, width: 26, height: 26, x: 1100, y: 700, toJSON: () => ({}) },
      { width: 1200, height: 800 },
    );
    expect(Number(style.left) + Number(style.width)).toBeLessThanOrEqual(1200 - 8);
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
