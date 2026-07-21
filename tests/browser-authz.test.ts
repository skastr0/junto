import { describe, expect, it } from "vitest";
import type { CanvasDoc } from "../src/shared/canvas";
import {
  areConnected,
  callerMayAccessPage,
  connectedPageNodeIds,
  connectedPageRefs,
  resolveBrowserCaller,
} from "../src/main/vellum/browser/authz";
import {
  makeProcessBindMap,
  principalKey,
  resolveProcessBoundCaller,
  resolveProcessBoundCallerByPid,
} from "../src/main/vellum/browser/process-bind";

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
      expect(agent.principal.auditOwnerId).toBe("edge:work/agent");
    }

    const herdr = resolveBrowserCaller(board, "work", "herdr");
    expect(herdr.ok).toBe(true);
    if (herdr.ok) {
      expect(herdr.principal.kind).toBe("herdr");
      expect(herdr.principal.paneId).toBe("pane-1");
    }

    expect(resolveBrowserCaller(board, "work", "p1").ok).toBe(false);
    expect(resolveBrowserCaller(board, "work", "tasks").ok).toBe(false);
    expect(resolveBrowserCaller(board, "work", "missing").ok).toBe(false);
  });

  it("lists only edge-connected page nodes", () => {
    expect(areConnected(board, "agent", "p1")).toBe(true);
    expect(areConnected(board, "agent", "p2")).toBe(false);
    expect(connectedPageNodeIds(board, "agent")).toEqual(["p1"]);
    expect(connectedPageNodeIds(board, "herdr")).toEqual(["p2"]);
    expect(connectedPageRefs(board, "work", "agent")).toEqual([
      "vellum://canvas/work?node=p1",
    ]);
    expect(callerMayAccessPage(board, "agent", "p1")).toBe(true);
    expect(callerMayAccessPage(board, "agent", "p2")).toBe(false);
    expect(callerMayAccessPage(board, "agent", "tasks")).toBe(false);
  });
});

describe("process-bind", () => {
  const board = doc(
    [text("agent", "agent", "local:default"), page("p1")],
    [{ id: "e1", fromNode: "agent", toNode: "p1" }],
  );

  it("binds nodeRef callers and optional PID reinforcement", () => {
    const map = makeProcessBindMap();
    const ref = "vellum://canvas/work?node=agent";
    const unbound = resolveProcessBoundCaller(board, ref);
    expect(unbound.ok).toBe(true);
    if (unbound.ok) expect(unbound.binding).toBe("node_ref");

    map.bind(4242, principalKey("work", "agent"));
    const reinforced = resolveProcessBoundCaller(board, ref, {
      peerPid: 4242,
      processMap: map,
    });
    expect(reinforced.ok).toBe(true);
    if (reinforced.ok) expect(reinforced.binding).toBe("node_ref+pid");

    map.bind(9999, principalKey("work", "other"));
    const mismatch = resolveProcessBoundCaller(board, ref, {
      peerPid: 9999,
      processMap: map,
    });
    expect(mismatch.ok).toBe(false);
    if (!mismatch.ok) expect(mismatch.denial).toBe("pid_mismatch");
  });

  it("requires PID bind when configured", () => {
    const map = makeProcessBindMap();
    const ref = "vellum://canvas/work?node=agent";
    const missing = resolveProcessBoundCaller(board, ref, {
      processMap: map,
      requirePidBind: true,
    });
    expect(missing.ok).toBe(false);
    if (!missing.ok) expect(missing.denial).toBe("pid_unbound");

    map.bind(7, principalKey("work", "agent"));
    const ok = resolveProcessBoundCaller(board, ref, {
      peerPid: 7,
      processMap: map,
      requirePidBind: true,
    });
    expect(ok.ok).toBe(true);
  });

  it("resolves by PID alone when map is populated", () => {
    const map = makeProcessBindMap();
    map.bind(11, principalKey("work", "agent"));
    const byPid = resolveProcessBoundCallerByPid(board, "work", 11, map);
    expect(byPid.ok).toBe(true);
    if (byPid.ok) {
      expect(byPid.binding).toBe("pid");
      expect(byPid.principal.nodeId).toBe("agent");
    }
  });
});
