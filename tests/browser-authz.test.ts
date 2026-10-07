import { describe, expect, it } from "vitest";
import { asNodeId, type Canvas, type Node, type Wire } from "../src/shared/model";
import { canvasOf, page as pageNode, region, seat, taskBoard, wire } from "./support/model-nodes";
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

const at = { x: 0, y: 0, width: 100, height: 40 };

const agent = (id: string, agentKey: string, bindingId = "term-bind-1"): Node =>
  seat(id, { ...at, agentKey, bindingId: bindingId as never });

const page = (id: string, url = "https://example.com/"): Node =>
  pageNode(id, { ...at, x: 200, url, profile: "personal" });

const navigates = (id: string, from: string, to: string) => wire(id, from, to, "navigates");

const doc = (nodes: ReadonlyArray<Node>, wires: ReadonlyArray<Wire> = []): Canvas =>
  canvasOf(nodes, wires, "work");

describe("browser edge authz", () => {
  const board = doc(
    [
      agent("agent", "local:default"),
      agent("term", "local:term"),
      page("p1"),
      page("p2"),
      taskBoard("tasks", at),
    ],
    [
      navigates("e1", "agent", "p1"),
      navigates("e3", "term", "p1"),
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

    expect(isBrowserCallerNode(board.nodes.get(asNodeId("agent"))!)).toBe(true);
    expect(isBrowserCallerNode(board.nodes.get(asNodeId("p1"))!)).toBe(false);
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
        region("g1", { x: -20, y: -20, width: 500, height: 200 }, { label: "g1" }),
        agent("agent", "local:default"),
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
    [agent("agent", "local:default"), page("p1")],
    [navigates("e1", "agent", "p1")],
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
    const isolated = doc([agent("agent", "local:default"), page("p1")], []);
    const resolved = resolveBrowserCallerFromProcess(isolated, "work", {
      agentKey: "local:default",
    });
    expect(resolved.ok).toBe(false);
    if (!resolved.ok) expect(resolved.denial).toBe("not_connected");
  });

  it("admits an agent process principal edged to a page — role decides, not a kind ACL", () => {
    const terminalBoard = doc(
      [agent("term", "local:term", "bind-xyz"), page("p1")],
      [navigates("e1", "term", "p1")],
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
      [agent("term", "local:term", "bind-xyz"), page("p1")],
      [navigates("e1", "term", "p1")],
    );
    const resolved = resolveBrowserCallerFromProcess(terminalBoard, "work", {
      bindingId: "bind-xyz",
    });
    expect(resolved.ok).toBe(true);
    if (resolved.ok) expect(resolved.principal.nodeId).toBe("term");
  });

  it("refuses a terminal principal whose binding matches no terminal node", () => {
    const terminalBoard = doc(
      [agent("term", "local:term", "bind-xyz"), page("p1")],
      [navigates("e1", "term", "p1")],
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
