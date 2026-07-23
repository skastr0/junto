import { describe, expect, it } from "vitest";
import type { CanvasDoc } from "../src/shared/canvas";
import {
  areConnected,
  callerMayAccessPage,
  connectedPageNodeIds,
  connectedPageRefs,
  isBrowserCallerKind,
  isBrowserCallerNode,
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
  kind: "agent" | "herdr" | "task" | "terminal",
  name?: string,
  extra?: { readonly bindingId?: string },
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
    ...(kind === "terminal"
      ? { terminal: { bindingId: extra?.bindingId ?? "term-bind-1" } }
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

const group = (
  id: string,
  x: number,
  y: number,
  width: number,
  height: number,
): CanvasDoc["nodes"][number] => ({
  id,
  type: "group",
  x,
  y,
  width,
  height,
  label: id,
});

const doc = (nodes: CanvasDoc["nodes"], edges: CanvasDoc["edges"] = []): CanvasDoc => ({
  nodes,
  edges,
});

describe("browser edge authz", () => {
  const board = doc(
    [
      text("agent", "agent", "local:default"),
      text("herdr", "herdr"),
      text("term", "terminal"),
      page("p1"),
      page("p2"),
      text("tasks", "task"),
    ],
    [
      { id: "e1", fromNode: "agent", toNode: "p1" },
      { id: "e2", fromNode: "p2", toNode: "herdr" },
      { id: "e3", fromNode: "term", toNode: "p1" },
    ],
  );

  it("resolves agent, herdr, and terminal callers via physics actors", () => {
    const agent = resolveBrowserCaller(board, "work", "agent");
    expect(agent.ok).toBe(true);
    if (agent.ok) {
      expect(agent.principal.kind).toBe("agent");
      expect(agent.principal.agentKey).toBe("local:default");
    }

    const herdr = resolveBrowserCaller(board, "work", "herdr");
    expect(herdr.ok).toBe(true);
    if (herdr.ok) expect(herdr.principal.kind).toBe("herdr");

    const term = resolveBrowserCaller(board, "work", "term");
    expect(term.ok).toBe(true);
    if (term.ok) {
      expect(term.principal.kind).toBe("terminal");
      expect(term.principal.bindingId).toBe("term-bind-1");
    }

    // page and task are sinks — not browser callers
    expect(resolveBrowserCaller(board, "work", "p1").ok).toBe(false);
    expect(resolveBrowserCaller(board, "work", "tasks").ok).toBe(false);
  });

  it("classifies caller kinds via physics role, not an ACL set", () => {
    expect(isBrowserCallerKind("agent")).toBe(true);
    expect(isBrowserCallerKind("herdr")).toBe(true);
    expect(isBrowserCallerKind("terminal")).toBe(true);
    expect(isBrowserCallerKind("page")).toBe(false);
    expect(isBrowserCallerKind("task")).toBe(false);
    expect(isBrowserCallerKind(undefined)).toBe(false);

    const agentNode = board.nodes.find((n) => n.id === "agent")!;
    const pageNode = board.nodes.find((n) => n.id === "p1")!;
    expect(isBrowserCallerNode(agentNode)).toBe(true);
    expect(isBrowserCallerNode(pageNode)).toBe(false);
  });

  it("lists only edge-connected page nodes admitted for browser.automate", () => {
    expect(areConnected(board, "agent", "p1")).toBe(true);
    expect(connectedPageNodeIds(board, "agent")).toEqual(["p1"]);
    expect(connectedPageRefs(board, "work", "agent")).toEqual([
      "vellum://canvas/work?node=p1",
    ]);
    expect(callerMayAccessPage(board, "agent", "p2")).toBe(false);
  });

  it("admits terminal as browser caller when edged to a page", () => {
    expect(callerMayAccessPage(board, "term", "p1")).toBe(true);
    expect(connectedPageNodeIds(board, "term")).toEqual(["p1"]);
    expect(callerMayAccessPage(board, "term", "p2")).toBe(false);
  });

  it("denies region-only co-membership for browser (no edge)", () => {
    const regional = doc(
      [
        group("g1", -20, -20, 500, 200),
        text("agent", "agent", "local:default"),
        page("p1"),
      ],
      [],
    );
    // Centers (50,20) and (250,20) sit inside the group — region peers only.
    expect(callerMayAccessPage(regional, "agent", "p1")).toBe(false);
    expect(connectedPageNodeIds(regional, "agent")).toEqual([]);
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

  it("denies a terminal process principal even when edged to a page", () => {
    const terminalBoard = doc(
      [text("term", "terminal", undefined, { bindingId: "bind-xyz" }), page("p1")],
      [{ id: "e1", fromNode: "term", toNode: "p1" }],
    );
    const resolved = resolveBrowserCallerFromProcess(terminalBoard, "work", {
      kind: "terminal",
      bindingId: "bind-xyz",
      canvasName: "work",
      nodeId: "term",
    });
    expect(resolved.ok).toBe(false);
    if (!resolved.ok) {
      expect(resolved.denial).toBe("caller_wrong_kind");
      expect(resolved.message).toMatch(/live agent or herdr process/i);
    }
  });

  it("maps a live herdr process principal when edged to a page", () => {
    const herdrBoard = doc(
      [text("herdr", "herdr"), page("p1")],
      [{ id: "e1", fromNode: "herdr", toNode: "p1" }],
    );
    const resolved = resolveBrowserCallerFromProcess(herdrBoard, "work", {
      kind: "herdr",
      paneId: "pane-1",
      canvasName: "work",
      nodeId: "herdr",
    });
    expect(resolved.ok).toBe(true);
    if (resolved.ok) {
      expect(resolved.principal.kind).toBe("herdr");
      expect(resolved.principal.paneId).toBe("pane-1");
      expect(resolved.pageRefs).toEqual(["vellum://canvas/work?node=p1"]);
    }
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
