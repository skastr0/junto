import { describe, expect, it } from "vitest";
import type { CanvasDoc } from "../src/shared/canvas";
import {
  areConnected,
  callerMayAccessPage,
  connectedPageNodeIds,
  connectedPageRefs,
  resolveBrowserCaller,
} from "../src/main/vellum/browser/authz";
import { resolveBrowserCallerFromProcess } from "../src/main/vellum/browser/process-bind";
import {
  makeProcessIdentityMap,
  admitProcessIdentity,
} from "../src/main/vellum/process-identity";
import type { Socket } from "node:net";

const text = (
  id: string,
  kind: "agent" | "herdr" | "task",
  name?: string,
): CanvasDoc["nodes"][number] => ({
  id,
  type: "text",
  text: name ?? id,
  x: 0,
  y: 0,
  width: 100,
  height: 40,
  ether: {
    entity: {
      kind,
      ...(kind === "agent" && name !== undefined ? { name } : {}),
    },
    ...(kind === "herdr"
      ? { herdr: { host: "local", paneId: "pane-1" } }
      : {}),
  },
});

const page = (id: string, url = "https://example.com/"): CanvasDoc["nodes"][number] => ({
  id,
  type: "link",
  url,
  x: 200,
  y: 0,
  width: 100,
  height: 40,
  ether: { entity: { kind: "page" }, browser: { profile: "personal" } },
});

const doc = (nodes: CanvasDoc["nodes"], edges: CanvasDoc["edges"] = []): CanvasDoc => ({
  nodes,
  edges,
});

describe("browser edge authz", () => {
  const board = doc(
    [text("agent", "agent", "local:default"), text("herdr", "herdr"), page("p1"), page("p2"), text("tasks", "task")],
    [
      { id: "e1", fromNode: "agent", toNode: "p1" },
      { id: "e2", fromNode: "p2", toNode: "herdr" },
    ],
  );

  it("resolves agent and herdr callers only", () => {
    const agent = resolveBrowserCaller(board, "work", "agent");
    expect(agent.ok).toBe(true);
    if (agent.ok) {
      expect(agent.principal.kind).toBe("agent");
      expect(agent.principal.agentKey).toBe("local:default");
    }
    expect(resolveBrowserCaller(board, "work", "p1").ok).toBe(false);
  });

  it("lists only edge-connected page nodes", () => {
    expect(areConnected(board, "agent", "p1")).toBe(true);
    expect(connectedPageNodeIds(board, "agent")).toEqual(["p1"]);
    expect(connectedPageRefs(board, "work", "agent")).toEqual([
      "vellum://canvas/work?node=p1",
    ]);
    expect(callerMayAccessPage(board, "agent", "p2")).toBe(false);
  });
});

describe("process-bind (browser canvas resolution)", () => {
  const board = doc(
    [text("agent", "agent", "local:default"), page("p1")],
    [{ id: "e1", fromNode: "agent", toNode: "p1" }],
  );

  it("maps a process principal to edge-reachable pages", () => {
    const resolved = resolveBrowserCallerFromProcess(board, "work", {
      kind: "agent",
      agentKey: "local:default",
    });
    expect(resolved.ok).toBe(true);
    if (resolved.ok) {
      expect(resolved.principal.nodeId).toBe("agent");
      expect(resolved.pageRefs).toEqual(["vellum://canvas/work?node=p1"]);
    }
  });

  it("denies when no edge to a page", () => {
    const isolated = doc([text("agent", "agent", "local:default"), page("p1")], []);
    const resolved = resolveBrowserCallerFromProcess(isolated, "work", {
      kind: "agent",
      agentKey: "local:default",
    });
    expect(resolved.ok).toBe(false);
    if (!resolved.ok) expect(resolved.denial).toBe("not_connected");
  });
});

describe("process identity map", () => {
  it("admits peer PID and ancestor walk", () => {
    const map = makeProcessIdentityMap();
    expect(map.bind(process.pid, { kind: "agent", agentKey: "local:default" })).toBe(true);
    const fakeSocket = {} as Socket;
    const ok = admitProcessIdentity(fakeSocket, map, () => process.pid);
    expect(ok.ok).toBe(true);
    if (ok.ok) expect(ok.principal.agentKey).toBe("local:default");

    const unbound = admitProcessIdentity(fakeSocket, map, () => 999_999);
    expect(unbound.ok).toBe(false);
    map.clear();
  });
});
