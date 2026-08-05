import { describe, expect, it } from "vitest";
import type { CanvasNode } from "../src/shared/canvas";
import { nodeSurfaceKind } from "../src/renderer/lib/activate-node-surface";

const agentWithTerminal = (id = "agent-1"): CanvasNode => ({
  id,
  type: "text",
  text: "Grok",
  x: 0,
  y: 0,
  width: 200,
  height: 100,
  ether: {
    entity: { kind: "agent", name: "local:grok" },
    terminal: {
      bindingId: "bind-agent-1",
      hostId: "local",
      launch: { kind: "shell" },
      harness: "grok",
    },
  },
});

const bareAgent = (): CanvasNode => ({
  id: "agent-bare",
  type: "text",
  text: "Unbound",
  x: 0,
  y: 0,
  width: 200,
  height: 100,
  ether: { entity: { kind: "agent", name: "local:x" } },
});

const note = (): CanvasNode => ({
  id: "note-1",
  type: "text",
  text: "just a note",
  x: 0,
  y: 0,
  width: 200,
  height: 80,
});

const region = (): CanvasNode => ({
  id: "region-1",
  type: "group",
  label: "Lane",
  x: 0,
  y: 0,
  width: 400,
  height: 300,
});

const tasks = (): CanvasNode => ({
  id: "tasks-1",
  type: "text",
  text: "tasks",
  x: 0,
  y: 0,
  width: 200,
  height: 100,
  ether: { entity: { kind: "task" } },
});

describe("nodeSurfaceKind", () => {
  it("opens managed terminal for bound agent seats", () => {
    expect(nodeSurfaceKind(agentWithTerminal())).toBe("terminal");
  });

  it("has no surface for unbound agents while ACP chat is hidden", () => {
    expect(nodeSurfaceKind(bareAgent())).toBeNull();
  });

  it("ignores notes and regions", () => {
    expect(nodeSurfaceKind(note())).toBeNull();
    expect(nodeSurfaceKind(region())).toBeNull();
  });

  it("opens work sinks", () => {
    expect(nodeSurfaceKind(tasks())).toBe("work");
  });
});
