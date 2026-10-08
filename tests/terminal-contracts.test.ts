import { terminalBindingOf } from "../src/shared/terminal";
import { note, seat, terminal } from "./support/model-nodes";
import { describe, expect, it } from "vitest";
import { Schema } from "effect";
import {
  CanvasDoc,
  EtherTerminal,
  resolveTerminalOnDelete,
  type CanvasNode,
} from "./fixtures/frozen-canvas-types";
import { xtermCapabilities } from "../src/shared/terminal";
import { resolveNodeHostId } from "../src/main/junto/station/frozen-node-host";

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

describe("a document terminal node", () => {
  it("runs on the host it names", () => {
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
    expect(resolveNodeHostId(node)).toBe("remote-a");
  });

});

describe("station + capabilities", () => {
  it("exposes honest capability presets", () => {
    expect(xtermCapabilities().presentation).toBe("xterm");
  });
});

describe("the binding of a node as the model holds it", () => {
  it("a seat and a raw terminal have one, and nothing else does", () => {
    const worker = seat("worker", { host: "remote-a" as never, bindingId: "bind-w" as never, harness: "codex" });
    expect(terminalBindingOf(worker)).toEqual({
      kind: "native",
      hostId: "remote-a",
      bindingId: "bind-w",
      onDelete: "detach",
      label: "worker",
      harness: "codex",
      agentKey: "local:worker",
    });
    const shell = terminal("shell");
    expect(terminalBindingOf(shell)).toMatchObject({ kind: "native", bindingId: shell.bindingId, hostId: shell.host });
    expect(terminalBindingOf(shell)?.harness).toBeUndefined();
    expect(terminalBindingOf(note("n"))).toBeUndefined();
    expect(terminalBindingOf(undefined)).toBeUndefined();
  });
});
