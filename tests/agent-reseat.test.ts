import { nodeOfDocument } from "../src/shared/model/from-document";
import { reseatCommand, reseatSeat } from "../src/renderer/lib/agent-reseat";
import { state$ } from "../src/renderer/lib/state";
import { modelStore } from "../src/renderer/lib/use-model";
import { holdCanvas } from "./support/hold-canvas";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  buildManagedAgentSeat,
  makeManagedAgentNode,
  reseatManagedAgentNode,
} from "../src/renderer/lib/node-factories";
import type { TextNode } from "../src/shared/canvas";
import {
  readSkipReseatConfirm,
  reseatChoicesFromConfiguration,
  seatLaunchCwd,
  writeSkipReseatConfirm,
} from "../src/renderer/lib/agent-reseat";

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
  });

  it("leaves the session of a pinning harness to main: none on the node, none in the launch", () => {
    // A fresh seat of a pinning harness carries the session it will resume.
    const fresh = makeManagedAgentNode(0, 0, { harness: "claude", host: "local" });
    const freshTerminal = fresh.ether?.terminal;
    expect(typeof freshTerminal?.sessionId).toBe("string");
    expect(freshTerminal?.launch?.argv).toContain("--session-id");

    // Re-seated, the new agent is started by main, which mints and records
    // its session; one made here would ride in the launch and be recorded nowhere.
    for (const harness of ["claude", "grok"] as const) {
      const next = reseatManagedAgentNode(fresh, { harness });
      const terminal = next.ether?.terminal;
      expect(terminal?.harness).toBe(harness);
      expect(terminal?.sessionId).toBeUndefined();
      expect(terminal?.launch?.argv).not.toContain("--session-id");
      expect(terminal?.bindingId).not.toBe(freshTerminal?.bindingId);
    }
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
 * The seat's name is the operator's. A re-seat changes what runs in the seat
 * (harness, model, effort, mode, binding) and nothing else: once, re-seating
 * cli-identity from Muse to Grok renamed the card "Grok - grok-4.7 - high".
 * The overseer's reseat is held to the same rule in tests/overseer-native.test.ts.
 */
describe.each([
  ["from the canvas", (node: TextNode, harness: "claude" | "grok") => reseatManagedAgentNode(node, { harness, model: "big", effort: "high" })],
] as const)("a re-seat %s keeps the seat's name", (_how, reseat) => {
  const named = (name: string, over: Partial<TextNode> = {}): TextNode => {
    const node = makeManagedAgentNode(0, 0, { harness: "codex", host: "local", model: "gpt-5.6" });
    return {
      ...node,
      text: name,
      ...over,
      ether: { ...node.ether, terminal: { ...node.ether!.terminal!, label: name.split("\n")[0]! }, ...over.ether },
    };
  };

  it("an operator-given name stays exactly as it was, on the card and on the terminal", () => {
    const next = reseat(named("cli-identity"), "grok");
    expect(next.text).toBe("cli-identity");
    expect(next.ether?.terminal?.label).toBe("cli-identity");
    expect(next.ether?.terminal?.harness).toBe("grok");
  });

  it("the default name from creation stays too: it names the seat, not the harness in it", () => {
    const created = makeManagedAgentNode(0, 0, { harness: "codex", host: "local", model: "gpt-5.6" });
    expect(created.text).toBe("Codex - gpt-5.6");
    const next = reseat(created, "claude");
    expect(next.text).toBe("Codex - gpt-5.6");
    expect(next.ether?.terminal?.label).toBe("Codex - gpt-5.6");
    expect(next.ether?.terminal?.harness).toBe("claude");
  });

  it("every line of the card's text stays, not only the first", () => {
    const next = reseat(named("cli-identity\nowns the login flow"), "grok");
    expect(next.text).toBe("cli-identity\nowns the login flow");
    expect(next.ether?.terminal?.label).toBe("cli-identity");
  });

  it("a seat whose terminal carried no label is labelled by its name, never by the harness", () => {
    const base = named("cli-identity");
    const { label: _label, ...terminal } = base.ether!.terminal!;
    const next = reseat({ ...base, ether: { ...base.ether, terminal } }, "grok");
    expect(next.text).toBe("cli-identity");
    expect(next.ether?.terminal?.label).toBe("cli-identity");
  });

  it("what runs in the seat does change: harness, binding, launch", () => {
    const before = named("cli-identity");
    const next = reseat(before, "grok");
    expect(next.ether?.terminal?.harness).toBe("grok");
    expect(next.ether?.terminal?.bindingId).not.toBe(before.ether?.terminal?.bindingId);
    expect(next.ether?.terminal?.launch?.argv?.join(" ")).toContain("grok");
    expect(next.ether?.entity).toEqual({ kind: "agent", name: "local:grok" });
  });

  it("reseating preserves the overseer mark without carrying mail", () => {
    const before = named("cli-identity", { ether: { overseer: true } as TextNode["ether"] });
    const next = reseat(before, "grok");
    expect(next.ether?.overseer).toBe(true);
    expect(next.ether).not.toHaveProperty("messages");
  });
});

/**
 * The re-seat that reads the seat from the node store and says one command.
 * It is what the bottom bar and the agent editor call; no document node goes
 * in or comes out.
 */
describe("reseatSeat: a re-seat said as one command", () => {
  const seatRow = () => {
    const fresh = makeManagedAgentNode(120, 240, { harness: "claude", host: "local", cwd: "/Users/me/Projects/junto", label: "cli-identity" });
    const row = nodeOfDocument("factory", fresh, 3);
    if (row?.kind !== "agent") throw new Error("not a seat");
    return { fresh, row };
  };

  it("the command names the new agent, a fresh binding and how it launches, and nothing else", () => {
    const { row } = seatRow();
    const command = reseatCommand("factory", row, { harness: "grok", model: "big", effort: "high" });
    expect(command._tag).toBe("Reseat");
    expect(command.id).toBe(row.id);
    expect(command.harness).toBe("grok");
    expect(command.agentKey).toBe("local:grok");
    expect(command.host).toBe(row.host);
    expect(command.bindingId).not.toBe(row.bindingId);
    // The working directory the seat was launched in is kept.
    expect(command.launch?.cwd).toBe("/Users/me/Projects/junto");
    // The session is main's to mint and record: none rides in the launch.
    expect(command.launch?.argv).not.toContain("--session-id");
    // A Reseat has no field for a name, a place or an overseer mark.
    expect(Object.keys(command).sort()).toEqual(["_tag", "agentKey", "bindingId", "canvas", "harness", "host", "id", "launch"]);
  });

  it("re-seats the seat the store holds: another agent in the same seat, name and place kept", async () => {
    const { fresh, row } = seatRow();
    state$.canvasName.set("factory");
    const release = holdCanvas("factory", [fresh]);
    try {
      const before = modelStore.canvasOf("factory").nodes.get(row.id);
      const result = await reseatSeat("factory", row.id, { harness: "grok" });
      expect(result).toEqual({ ok: true });
      const after = modelStore.canvasOf("factory").nodes.get(row.id);
      expect(after).toMatchObject({
        kind: "agent", harness: "grok", agentKey: "local:grok", label: "cli-identity",
        x: before?.x, y: before?.y, width: before?.width, height: before?.height,
      });
      expect(after?.kind === "agent" ? after.bindingId : undefined).not.toBe(row.bindingId);
      expect(after?.kind === "agent" ? after.sessionId : "none").toBeUndefined();
    } finally {
      release();
    }
  });

  it("refuses a node that is not a seat, and one that is not there", async () => {
    state$.canvasName.set("factory");
    const note = { id: "n", type: "text", text: "note", x: 0, y: 0, width: 200, height: 80 } as TextNode;
    const release = holdCanvas("factory", [note]);
    try {
      expect(await reseatSeat("factory", "n", { harness: "grok" })).toEqual({ ok: false, message: "not an agent seat" });
      expect(await reseatSeat("factory", "gone", { harness: "grok" })).toEqual({ ok: false, message: "not an agent seat" });
    } finally {
      release();
    }
  });
});
