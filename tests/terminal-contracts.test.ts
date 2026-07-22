import { describe, expect, it } from "vitest";
import { Schema } from "effect";
import {
  CanvasDoc,
  EtherTerminal,
  resolveTerminalOnDelete,
  type CanvasNode,
} from "../src/shared/canvas";
import {
  resolveTerminalBinding,
  isTerminalNode,
  xtermCapabilities,
  ghosttyCapabilities,
} from "../src/shared/terminal";
import { resolveNodeHostId, isExecutableEntityKind } from "../src/shared/station";

const decodeTerminal = Schema.decodeUnknownSync(EtherTerminal);
const decodeDoc = Schema.decodeUnknownSync(CanvasDoc);

describe("EtherTerminal schema", () => {
  it("decodes bindingId + optional launch", () => {
    const t = decodeTerminal({
      bindingId: "01JTESTBINDING000000000000",
      label: "forge",
      onDelete: "detach",
      launch: { kind: "harness", argv: ["claude"], cwd: "/tmp" },
    });
    expect(t.bindingId).toBe("01JTESTBINDING000000000000");
    expect(t.launch?.kind).toBe("harness");
    expect(resolveTerminalOnDelete(t)).toBe("detach");
  });

  it("defaults onDelete to detach when omitted", () => {
    expect(resolveTerminalOnDelete(decodeTerminal({ bindingId: "x" }))).toBe("detach");
    expect(resolveTerminalOnDelete(undefined)).toBe("detach");
  });

  it("round-trips inside a canvas node", () => {
    const doc = decodeDoc({
      nodes: [
        {
          id: "n1",
          type: "text",
          text: "claude",
          x: 0,
          y: 0,
          width: 200,
          height: 80,
          ether: {
            entity: { kind: "terminal" },
            host: "local",
            terminal: { bindingId: "01JABC", launch: { kind: "shell" } },
          },
        },
      ],
      edges: [],
    });
    const node = doc.nodes[0] as CanvasNode;
    expect(node.ether?.terminal?.bindingId).toBe("01JABC");
  });
});

describe("resolveTerminalBinding", () => {
  it("resolves native terminal nodes", () => {
    const node = {
      id: "n1",
      type: "text" as const,
      text: "t",
      x: 0,
      y: 0,
      width: 1,
      height: 1,
      ether: {
        entity: { kind: "terminal" },
        host: "remote-a",
        terminal: {
          bindingId: "bind-1",
          launch: { kind: "command" as const, argv: ["zsh"] },
        },
      },
    } satisfies CanvasNode;
    const b = resolveTerminalBinding(node);
    expect(b?.kind).toBe("native");
    if (b?.kind === "native") {
      expect(b.bindingId).toBe("bind-1");
      expect(b.hostId).toBe("remote-a");
      expect(b.launch?.kind).toBe("command");
    }
    expect(isTerminalNode(node)).toBe(true);
    expect(resolveNodeHostId(node)).toBe("remote-a");
  });

  it("resolves legacy herdr without collapsing into terminal", () => {
    const node = {
      id: "n2",
      type: "text" as const,
      text: "h",
      x: 0,
      y: 0,
      width: 1,
      height: 1,
      ether: {
        entity: { kind: "herdr" },
        herdr: { host: "local", paneId: "p1", terminalId: "t1" },
      },
    } satisfies CanvasNode;
    const b = resolveTerminalBinding(node);
    expect(b?.kind).toBe("herdr");
    if (b?.kind === "herdr") {
      expect(b.herdr.paneId).toBe("p1");
      expect(b.onDelete).toBe("detach");
    }
  });

  it("does not invent a binding without bindingId", () => {
    const node = {
      id: "n3",
      type: "text" as const,
      text: "t",
      x: 0,
      y: 0,
      width: 1,
      height: 1,
      ether: { entity: { kind: "terminal" } },
    } satisfies CanvasNode;
    expect(resolveTerminalBinding(node)).toBeUndefined();
  });
});

describe("station + capabilities", () => {
  it("treats terminal as executable kind", () => {
    expect(isExecutableEntityKind("terminal")).toBe(true);
  });

  it("exposes honest capability presets", () => {
    expect(xtermCapabilities().presentation).toBe("xterm");
    expect(ghosttyCapabilities().graphics).toBe(true);
  });
});
