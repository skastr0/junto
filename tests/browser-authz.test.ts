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
} from "../src/main/junto/browser/authz";
import { resolveBrowserCallerFromProcess } from "../src/main/junto/browser/process-bind";
import {
  makeProcessIdentityMap,
  admitProcessIdentity,
} from "../src/main/junto/process-identity";
import type { Socket } from "node:net";

const text = (
  id: string,
  kind: "agent" | "task" | "terminal",
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
    ...(kind === "terminal"
      ? { terminal: { bindingId: "local:shell-1" } }
      : {}),
    ...(kind === "agent" || kind === "terminal"
      ? { terminal: { bindingId: extra?.bindingId ?? "term-bind-1", harness: "claude" as const } }
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
      text("term", "agent", "local:term"),
      page("p1"),
      page("p2"),
      text("tasks", "task"),
    ],
    [
      { id: "e1", fromNode: "agent", toNode: "p1", ether: { verb: "navigates" } },
      { id: "e3", fromNode: "term", toNode: "p1", ether: { verb: "navigates" } },
    ],
  );

  it("resolves the agent seat via physics actors; raw terminals are geography", () => {
    const agent = resolveBrowserCaller(board, "work", "agent");
    expect(agent.ok).toBe(true);
    if (agent.ok) {
      expect(agent.principal.kind).toBe("agent");
      expect(agent.principal.agentKey).toBe("local:default");
    }


    const term = resolveBrowserCaller(board, "work", "term");
    expect(term.ok).toBe(true);
    if (term.ok) {
      expect(term.principal.kind).toBe("agent");
      expect(term.principal.bindingId).toBe("term-bind-1");
    }

    // page and task are sinks — not browser callers
    expect(resolveBrowserCaller(board, "work", "p1").ok).toBe(false);
    expect(resolveBrowserCaller(board, "work", "tasks").ok).toBe(false);
  });

  it("classifies caller kinds via physics role, not an ACL set", () => {
    expect(isBrowserCallerKind("agent")).toBe(true);
    // A raw user-opened terminal is geography, not a caller.
    expect(isBrowserCallerKind("terminal")).toBe(false);
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
      "junto://canvas/work?node=p1",
    ]);
    expect(callerMayAccessPage(board, "agent", "p2")).toBe(false);
  });

  it("admits the agent seat as browser caller when edged to a page", () => {
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
    [{ id: "e1", fromNode: "agent", toNode: "p1", ether: { verb: "navigates" } }],
  );

  it("maps a process principal to edge-reachable pages", () => {
    const resolved = resolveBrowserCallerFromProcess(board, "work", {
      agentKey: "local:default",
    });
    expect(resolved.ok).toBe(true);
    if (resolved.ok) {
      expect(resolved.principal.nodeId).toBe("agent");
      expect(resolved.pageRefs).toEqual(["junto://canvas/work?node=p1"]);
    }
  });

  it("requires every supplied process anchor to match the current actor seat", () => {
    const exact = resolveBrowserCallerFromProcess(board, "work", {
      nodeId: "agent",
      agentKey: "local:default",
      bindingId: "term-bind-1",
    });
    expect(exact.ok).toBe(true);

    const staleAgent = resolveBrowserCallerFromProcess(board, "work", {
      nodeId: "agent",
      agentKey: "local:retired",
      bindingId: "term-bind-1",
    });
    expect(staleAgent).toMatchObject({ ok: false, denial: "not_found" });

    const staleBinding = resolveBrowserCallerFromProcess(board, "work", {
      nodeId: "agent",
      agentKey: "local:default",
      bindingId: "retired-binding",
    });
    expect(staleBinding).toMatchObject({ ok: false, denial: "not_found" });
  });

  it("denies when no edge to a page", () => {
    const isolated = doc([text("agent", "agent", "local:default"), page("p1")], []);
    const resolved = resolveBrowserCallerFromProcess(isolated, "work", {
      agentKey: "local:default",
    });
    expect(resolved.ok).toBe(false);
    if (!resolved.ok) expect(resolved.denial).toBe("not_connected");
  });

  it("admits an agent process principal edged to a page — role decides, not a kind ACL", () => {
    const terminalBoard = doc(
      [text("term", "agent", "local:term", { bindingId: "bind-xyz" }), page("p1")],
      [{ id: "e1", fromNode: "term", toNode: "p1", ether: { verb: "navigates" } }],
    );
    const resolved = resolveBrowserCallerFromProcess(terminalBoard, "work", {
      bindingId: "bind-xyz",
      canvasName: "work",
      nodeId: "term",
    });
    expect(resolved.ok).toBe(true);
    if (resolved.ok) {
      expect(resolved.principal.nodeId).toBe("term");
      expect(resolved.principal.kind).toBe("agent");
      expect(resolved.pageRefs).toEqual(["junto://canvas/work?node=p1"]);
    }
  });

  it("resolves an agent principal by bindingId with no node anchor", () => {
    const terminalBoard = doc(
      [text("term", "agent", "local:term", { bindingId: "bind-xyz" }), page("p1")],
      [{ id: "e1", fromNode: "term", toNode: "p1", ether: { verb: "navigates" } }],
    );
    const resolved = resolveBrowserCallerFromProcess(terminalBoard, "work", {
      bindingId: "bind-xyz",
    });
    expect(resolved.ok).toBe(true);
    if (resolved.ok) expect(resolved.principal.nodeId).toBe("term");
  });

  it("refuses a terminal principal whose binding matches no terminal node", () => {
    const terminalBoard = doc(
      [text("term", "agent", "local:term", { bindingId: "bind-xyz" }), page("p1")],
      [{ id: "e1", fromNode: "term", toNode: "p1", ether: { verb: "navigates" } }],
    );
    const resolved = resolveBrowserCallerFromProcess(terminalBoard, "work", {
      bindingId: "some-other-binding",
    });
    expect(resolved.ok).toBe(false);
    if (!resolved.ok) expect(resolved.denial).toBe("not_found");
  });

});

describe("process identity map", () => {
  it("admits peer PID and ancestor walk", () => {
    const map = makeProcessIdentityMap();
    expect(map.bind(process.pid, { agentKey: "local:default" })).toBe(true);
    const fakeSocket = {} as Socket;
    const ok = admitProcessIdentity(fakeSocket, map, () => process.pid);
    expect(ok.ok).toBe(true);
    if (ok.ok) expect(ok.principal.agentKey).toBe("local:default");

    const unbound = admitProcessIdentity(fakeSocket, map, () => 999_999);
    expect(unbound.ok).toBe(false);
    map.clear();
  });
});
