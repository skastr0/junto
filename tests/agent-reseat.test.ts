import { afterEach, describe, expect, it, vi } from "vitest";
import {
  buildManagedAgentSeat,
  makeManagedAgentNode,
  reseatManagedAgentNode,
} from "../src/renderer/lib/node-factories";
import { reseatManagedAgentNode as overseerReseat } from "../src/main/junto/overseer/reseat";
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
 * The canvas path and the overseer's own path are held to the same rule.
 */
describe.each([
  ["from the canvas", (node: TextNode, harness: "claude" | "grok") => reseatManagedAgentNode(node, { harness, model: "big", effort: "high" })],
  ["by the overseer", (node: TextNode, harness: "claude" | "grok") => overseerReseat(node, { harness, host: "local", model: "big", effort: "high" })],
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

  it("the rest of the seat stays: its overseer mark and its mailbox", () => {
    const mail = { items: [{ messageId: "01A", role: "user" as const, parts: [{ kind: "text" as const, text: "hello" }] }] };
    const before = named("cli-identity", { ether: { overseer: true, messages: mail } as TextNode["ether"] });
    const next = reseat(before, "grok");
    expect(next.ether?.overseer).toBe(true);
    expect(next.ether?.messages).toEqual(mail);
  });
});
