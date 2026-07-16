import { describe, expect, it } from "vitest";
import type { CliResult } from "../src/main/vellum/adapters/exec";
import { herdrArgv, HERDR_HOSTS } from "../src/main/vellum/herdr/hosts";
import {
  parseCliEnvelope,
  parseCreateIds,
  parsePaneList,
  parseSessionList,
  parseWorkspaceList,
} from "../src/main/vellum/herdr/parse";
import { HerdrService, type HerdrRunner } from "../src/main/vellum/herdr/service";

const ok = (stdout: string): CliResult => ({ ok: true, stdout });
const fail = (error: string): CliResult => ({ ok: false, stdout: "", error });

describe("herdr hosts", () => {
  it("exposes local + remote-a P0 hosts", () => {
    expect(HERDR_HOSTS.map((h) => h.id)).toEqual(["local", "remote-a"]);
  });

  it("builds local argv without ssh", () => {
    const { command, argv } = herdrArgv("local", ["pane", "list"]);
    expect(command).toBe("herdr");
    expect(argv).toEqual(["pane", "list"]);
  });

  it("wraps remote in ssh BatchMode", () => {
    const { command, argv } = herdrArgv("remote-a", ["workspace", "list"], "ops");
    expect(command).toBe("ssh");
    expect(argv).toEqual([
      "-o",
      "ConnectTimeout=6",
      "-o",
      "BatchMode=yes",
      "remote-a",
      "herdr",
      "--session",
      "ops",
      "workspace",
      "list",
    ]);
  });
});

describe("herdr parse", () => {
  it("parses envelope result and error", () => {
    expect(parseCliEnvelope('{"id":"x","result":{"panes":[]}}')).toEqual({
      ok: true,
      result: { panes: [] },
    });
    expect(parseCliEnvelope('{"id":"x","error":{"code":"pane_not_found","message":"missing"}}')).toEqual({
      ok: false,
      code: "pane_not_found",
      message: "missing",
    });
  });

  it("parses session / workspace / pane lists", () => {
    expect(
      parseSessionList({
        sessions: [{ name: "default", default: true, running: true }],
      }),
    ).toEqual([{ name: "default", default: true, running: true }]);

    expect(
      parseWorkspaceList({
        type: "workspace_list",
        workspaces: [{ workspace_id: "w11", label: "vellum", pane_count: 2 }],
      }),
    ).toEqual([{ workspaceId: "w11", label: "vellum", paneCount: 2 }]);

    expect(
      parsePaneList({
        panes: [
          {
            pane_id: "w11:pA",
            workspace_id: "w11",
            tab_id: "w11:t4",
            terminal_id: "term_1",
            cwd: "/tmp",
            agent: "grok",
            agent_status: "working",
          },
        ],
      }),
    ).toEqual([
      {
        paneId: "w11:pA",
        workspaceId: "w11",
        tabId: "w11:t4",
        terminalId: "term_1",
        cwd: "/tmp",
        agent: "grok",
        agentStatus: "working",
      },
    ]);
  });

  it("extracts create ids from CLI JSON", () => {
    expect(
      parseCreateIds({
        type: "workspace_created",
        workspace: { workspace_id: "w16" },
        tab: { tab_id: "w16:t1" },
        root_pane: { pane_id: "w16:p1", terminal_id: "term_x" },
      }),
    ).toEqual({
      workspaceId: "w16",
      tabId: "w16:t1",
      paneId: "w16:p1",
      terminalId: "term_x",
    });
  });
});

describe("HerdrService with mock runner", () => {
  it("lists hierarchy without live ssh", async () => {
    const calls: string[][] = [];
    const runner: HerdrRunner = async (_host, args) => {
      calls.push([...args]);
      if (args[0] === "workspace" && args[1] === "list") {
        return ok(
          JSON.stringify({
            id: "cli:workspace:list",
            result: {
              type: "workspace_list",
              workspaces: [{ workspace_id: "w1", label: "demo" }],
            },
          }),
        );
      }
      if (args[0] === "pane" && args[1] === "list") {
        return ok(
          JSON.stringify({
            id: "cli:pane:list",
            result: {
              panes: [
                {
                  pane_id: "w1:p1",
                  workspace_id: "w1",
                  terminal_id: "term_1",
                  cwd: "/proj",
                  agent: "codex",
                  agent_status: "idle",
                },
              ],
            },
          }),
        );
      }
      if (args[0] === "pane" && args[1] === "get") {
        return ok(
          JSON.stringify({
            id: "cli:pane:get",
            result: {
              pane: {
                pane_id: "w1:p1",
                terminal_id: "term_1",
                cwd: "/proj",
                agent: "codex",
                agent_status: "idle",
              },
              type: "pane_info",
            },
          }),
        );
      }
      if (args[0] === "pane" && args[1] === "read") {
        return ok(JSON.stringify({ id: "r", result: { text: "ready.\n" } }));
      }
      return fail("unexpected");
    };

    const svc = new HerdrService(runner);
    const workspaces = await svc.listWorkspaces("local");
    expect(workspaces.ok && workspaces.data[0]?.workspaceId).toBe("w1");

    const panes = await svc.listPanes("local");
    expect(panes.ok && panes.data[0]?.paneId).toBe("w1:p1");
    expect(panes.ok && panes.data[0]?.agent).toBe("codex");

    const meta = await svc.getPaneMeta("local", null, "w1:p1");
    expect(meta.ok && meta.data.cwd).toBe("/proj");
    expect(meta.ok && meta.data.agentStatus).toBe("idle");
    expect(meta.ok && meta.data.preview).toBe("ready.");
    expect(calls.length).toBeGreaterThan(0);
  });

  it("maps unreachable host failures", async () => {
    const runner: HerdrRunner = async () => fail("ssh: ConnectTimeout");
    const svc = new HerdrService(runner);
    const res = await svc.listWorkspaces("remote-a");
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.code).toBe("timeout");
  });

  it("create flows parse ids from JSON", async () => {
    const runner: HerdrRunner = async (_host, args) => {
      if (args[0] === "workspace" && args[1] === "create") {
        return ok(
          JSON.stringify({
            id: "cli:workspace:create",
            result: {
              workspace: { workspace_id: "w9" },
              tab: { tab_id: "w9:t1" },
              root_pane: { pane_id: "w9:p1", terminal_id: "term_9" },
            },
          }),
        );
      }
      if (args[0] === "tab" && args[1] === "create") {
        return ok(
          JSON.stringify({
            id: "cli:tab:create",
            result: {
              tab: { tab_id: "w9:t2" },
              root_pane: { pane_id: "w9:p2", terminal_id: "term_10" },
            },
          }),
        );
      }
      if (args[0] === "pane" && args[1] === "split") {
        return ok(
          JSON.stringify({
            id: "cli:pane:split",
            result: { pane: { pane_id: "w9:p3", terminal_id: "term_11", tab_id: "w9:t2", workspace_id: "w9" } },
          }),
        );
      }
      return fail("unexpected");
    };
    const svc = new HerdrService(runner);
    const ws = await svc.createWorkspace("local", null, { cwd: "/tmp", label: "scratch" });
    expect(ws.ok && ws.data.workspaceId).toBe("w9");
    const tab = await svc.createTab("local", null, { workspaceId: "w9", label: "2" });
    expect(tab.ok && tab.data.tabId).toBe("w9:t2");
    const pane = await svc.createPane("local", null, { paneId: "w9:p2", direction: "right" });
    expect(pane.ok && pane.data.paneId).toBe("w9:p3");
  });

  it("ensureServer short-circuits when status reports running", async () => {
    const runner: HerdrRunner = async (_host, args) => {
      if (args[0] === "status") {
        return ok(JSON.stringify({ server: { status: "running", running: true } }));
      }
      return fail("unexpected");
    };
    const svc = new HerdrService(runner);
    const res = await svc.ensureServer("local");
    expect(res).toEqual({ ok: true, data: { running: true, started: false } });
  });
});
