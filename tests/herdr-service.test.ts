import { describe, expect, it, vi } from "vitest";
import type { CliResult } from "../src/main/vellum/adapters/exec";
import { isKnownHerdrHost, listHerdrHosts } from "../src/main/vellum/herdr/hosts";
import {
  parseCliEnvelope,
  parseCreateIds,
  parsePaneList,
  parseProcessInfo,
  parseSessionList,
  parseWorkspaceList,
} from "../src/main/vellum/herdr/parse";
import { HerdrService, type HerdrRunner } from "../src/main/vellum/herdr/service";

const ok = (stdout: string): CliResult => ({ ok: true, stdout });
const fail = (error: string): CliResult => ({ ok: false, stdout: "", error });

describe("herdr hosts", () => {
  it("exposes local from the default registry (remotes are user-authored)", () => {
    expect(listHerdrHosts().map((h) => h.id)).toContain("local");
    expect(listHerdrHosts().every((h) => h.id.length > 0)).toBe(true);
  });

  it("recognizes only registry herdr hosts", () => {
    expect(isKnownHerdrHost("local")).toBe(true);
    expect(isKnownHerdrHost("evil-host")).toBe(false);
    expect(isKnownHerdrHost("-oProxyCommand=x")).toBe(false);
  });
});

// Note: isKnownHerdrHost is enforced at HerdrService + stream open.

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

  it("parses agent session, foreground cwd, scroll, and revision", () => {
    expect(
      parsePaneList({
        panes: [
          {
            pane_id: "wN:p5",
            workspace_id: "wN",
            tab_id: "wN:t4",
            terminal_id: "term_1",
            cwd: "/proj",
            foreground_cwd: "/proj/sub",
            agent: "claude",
            agent_status: "idle",
            agent_session: {
              agent: "claude",
              kind: "id",
              source: "herdr:claude",
              value: "23910b7d-f4b4",
            },
            focused: false,
            revision: 3,
            scroll: {
              max_offset_from_bottom: 723,
              offset_from_bottom: 12,
              viewport_rows: 73,
            },
          },
        ],
      }),
    ).toEqual([
      {
        paneId: "wN:p5",
        workspaceId: "wN",
        tabId: "wN:t4",
        terminalId: "term_1",
        cwd: "/proj",
        foregroundCwd: "/proj/sub",
        agent: "claude",
        agentStatus: "idle",
        agentSession: {
          agent: "claude",
          kind: "id",
          source: "herdr:claude",
          value: "23910b7d-f4b4",
        },
        focused: false,
        revision: 3,
        scroll: { maxOffsetFromBottom: 723, offsetFromBottom: 12, viewportRows: 73 },
      },
    ]);
  });

  it("parses foreground process info", () => {
    expect(
      parseProcessInfo({
        process_info: {
          pane_id: "wN:p5",
          shell_pid: 32962,
          foreground_processes: [
            { name: "claude", cmdline: "claude", pid: 33060 },
            { cmdline: "raindrop workshop mcp", pid: 33073 },
            "garbage",
          ],
        },
      }),
    ).toEqual([
      { name: "claude", cmdline: "claude", pid: 33060 },
      { cmdline: "raindrop workshop mcp", pid: 33073 },
    ]);
    expect(parseProcessInfo({})).toEqual([]);
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

  it("enriches pane meta with labels, agent session, and processes", async () => {
    const runner: HerdrRunner = async (_host, args) => {
      if (args[0] === "pane" && args[1] === "get") {
        return ok(
          JSON.stringify({
            id: "cli:pane:get",
            result: {
              pane: {
                pane_id: "w1:p1",
                workspace_id: "w1",
                tab_id: "w1:t4",
                terminal_id: "term_1",
                cwd: "/proj",
                foreground_cwd: "/proj/sub",
                agent: "claude",
                agent_status: "idle",
                agent_session: { agent: "claude", kind: "id", source: "herdr:claude", value: "abc-123" },
                revision: 2,
                scroll: { max_offset_from_bottom: 10, offset_from_bottom: 0, viewport_rows: 40 },
              },
              type: "pane_info",
            },
          }),
        );
      }
      if (args[0] === "pane" && args[1] === "read") {
        return ok(JSON.stringify({ id: "r", result: { text: "ready.\n" } }));
      }
      if (args[0] === "workspace" && args[1] === "list") {
        return ok(
          JSON.stringify({
            id: "cli:workspace:list",
            result: { workspaces: [{ workspace_id: "w1", label: "api-work" }] },
          }),
        );
      }
      if (args[0] === "tab" && args[1] === "list") {
        return ok(
          JSON.stringify({
            id: "cli:tab:list",
            result: { tabs: [{ tab_id: "w1:t4", workspace_id: "w1", label: "editor" }] },
          }),
        );
      }
      if (args[0] === "pane" && args[1] === "process-info") {
        return ok(
          JSON.stringify({
            id: "cli:pane:process_info",
            result: {
              process_info: {
                pane_id: "w1:p1",
                foreground_processes: [{ name: "claude", cmdline: "claude", pid: 33060 }],
              },
            },
          }),
        );
      }
      return fail("unexpected");
    };

    const svc = new HerdrService(runner);
    const meta = await svc.getPaneMeta("local", null, "w1:p1");
    expect(meta.ok).toBe(true);
    if (meta.ok) {
      expect(meta.data.workspaceLabel).toBe("api-work");
      expect(meta.data.tabLabel).toBe("editor");
      expect(meta.data.agentSession?.value).toBe("abc-123");
      expect(meta.data.foregroundCwd).toBe("/proj/sub");
      expect(meta.data.revision).toBe(2);
      expect(meta.data.scroll?.maxOffsetFromBottom).toBe(10);
      expect(meta.data.processes).toEqual([{ name: "claude", cmdline: "claude", pid: 33060 }]);
      expect(meta.data.preview).toBe("ready.");
    }
  });

  it("still returns meta when enrichments fail", async () => {
    const runner: HerdrRunner = async (_host, args) => {
      if (args[0] === "pane" && args[1] === "get") {
        return ok(
          JSON.stringify({
            id: "cli:pane:get",
            result: {
              pane: { pane_id: "w1:p1", workspace_id: "w1", tab_id: "w1:t4", cwd: "/proj" },
              type: "pane_info",
            },
          }),
        );
      }
      // read / workspace list / tab list / process-info all fail.
      return fail("boom");
    };

    const svc = new HerdrService(runner);
    const meta = await svc.getPaneMeta("local", null, "w1:p1");
    expect(meta.ok).toBe(true);
    if (meta.ok) {
      expect(meta.data.cwd).toBe("/proj");
      expect(meta.data.workspaceLabel).toBeUndefined();
      expect(meta.data.tabLabel).toBeUndefined();
      expect(meta.data.processes).toBeUndefined();
      expect(meta.data.preview).toBeUndefined();
    }
  });

  it("maps unreachable host failures", async () => {
    const { setHostsSnapshot } = await import("../src/main/vellum/hosts/snapshot");
    const { defaultRemoteHostsDocument } = await import("../src/shared/remote-hosts");
    setHostsSnapshot([
      ...defaultRemoteHostsDocument().hosts,
      {
        id: "studio",
        label: "studio",
        kind: "remote",
        sshEndpoint: "studio",
        capabilities: ["herdr"],
      },
    ]);
    const runner: HerdrRunner = async () => fail("ssh: ConnectTimeout");
    const svc = new HerdrService(runner);
    const res = await svc.listWorkspaces("studio");
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.code).toBe("timeout");
  });

  it("rejects unknown hosts at the service boundary", async () => {
    const runner: HerdrRunner = async () => ok("{}");
    const svc = new HerdrService(runner);
    const res = await svc.listWorkspaces("attacker.example");
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.code).toBe("invalid");
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

  it("ensureServer shares one startup flight for concurrent default-session callers", async () => {
    let startCalls = 0;
    let releaseStart: (() => void) | undefined;
    const startReady = new Promise<void>((resolve) => {
      releaseStart = resolve;
    });
    const runner: HerdrRunner = async (_host, args) => {
      if (args[0] === "status") return ok(JSON.stringify({ server: { running: false } }));
      return fail("unexpected");
    };
    const starter = async () => {
      startCalls += 1;
      await startReady;
      return ok("");
    };
    const svc = new HerdrService(runner, () => undefined, starter);

    const callers = [
      svc.ensureServer("local"),
      svc.ensureServer("local", null),
      svc.ensureServer("local", ""),
    ];
    await vi.waitFor(() => expect(startCalls).toBe(1));
    releaseStart?.();

    await expect(Promise.all(callers)).resolves.toEqual(
      Array.from({ length: 3 }, () => ({ ok: true, data: { running: true, started: true } })),
    );
    expect(startCalls).toBe(1);
  });

  it("ensureServer clears a failed startup flight so a later call retries", async () => {
    let startCalls = 0;
    const runner: HerdrRunner = async (_host, args) => {
      if (args[0] === "status") return ok(JSON.stringify({ server: { running: false } }));
      return fail("unexpected");
    };
    const starter = async () => {
      startCalls += 1;
      return startCalls === 1 ? fail("server did not become ready") : ok("");
    };
    const svc = new HerdrService(runner, () => undefined, starter);

    await expect(svc.ensureServer("local", "ops")).resolves.toMatchObject({ ok: false, code: "failed" });
    await expect(svc.ensureServer("local", "ops")).resolves.toEqual({
      ok: true,
      data: { running: true, started: true },
    });
    expect(startCalls).toBe(2);
  });

  it("ensureServer keeps pending status and startup on their captured endpoint", async () => {
    const { setHostsSnapshot } = await import("../src/main/vellum/hosts/snapshot");
    const { defaultRemoteHostsDocument } = await import("../src/shared/remote-hosts");
    const baseHosts = defaultRemoteHostsDocument().hosts;
    const withEndpoint = (endpoint: string) => [
      ...baseHosts,
      { id: "studio", label: "studio", kind: "remote" as const, endpoint, capabilities: ["herdr" as const] },
    ];
    setHostsSnapshot(withEndpoint("studio-a"));

    let releaseOldStatus: (() => void) | undefined;
    const oldStatusReady = new Promise<void>((resolve) => {
      releaseOldStatus = resolve;
    });
    const statusEndpoints: string[] = [];
    const startedEndpoints: string[] = [];
    const runner: HerdrRunner = async (_host, args, _session, _timeout, route) => {
      if (args[0] === "status") {
        const endpoint = route?.endpoint ?? "missing";
        statusEndpoints.push(endpoint);
        if (endpoint === "studio-a") await oldStatusReady;
        return ok(JSON.stringify({ server: { running: false } }));
      }
      return fail("unexpected");
    };
    const starter = async (_host: string, _session?: string | null, route?: { readonly endpoint: string | null }) => {
      startedEndpoints.push(route?.endpoint ?? "missing");
      return ok("");
    };
    const svc = new HerdrService(runner, () => undefined, starter);

    try {
      const oldFlight = svc.ensureServer("studio");
      await vi.waitFor(() => expect(statusEndpoints).toEqual(["studio-a"]));

      setHostsSnapshot(withEndpoint("studio-b"));
      const newFlight = svc.ensureServer("studio");
      await expect(newFlight).resolves.toEqual({ ok: true, data: { running: true, started: true } });
      expect(statusEndpoints).toEqual(["studio-a", "studio-b"]);
      expect(startedEndpoints).toEqual(["studio-b"]);

      releaseOldStatus?.();
      await expect(oldFlight).resolves.toEqual({ ok: true, data: { running: true, started: true } });
      expect(startedEndpoints).toEqual(["studio-b", "studio-a"]);
    } finally {
      setHostsSnapshot(baseHosts);
    }
  });

  it("markPaneSeen runs agent focus and returns agent_status", async () => {
    const runner: HerdrRunner = async (_host, args) => {
      expect(args).toEqual(["agent", "focus", "w1:p1"]);
      return ok(
        JSON.stringify({
          id: "cli:agent:focus",
          result: {
            type: "agent_info",
            agent: { pane_id: "w1:p1", agent_status: "idle", agent: "claude" },
          },
        }),
      );
    };
    const svc = new HerdrService(runner);
    const res = await svc.markPaneSeen("local", null, "w1:p1");
    expect(res).toEqual({ ok: true, data: { paneId: "w1:p1", agentStatus: "idle" } });
  });

  it("cuts late commands and retains an admitted runner until its exact settlement", async () => {
    vi.useFakeTimers();
    let release!: (result: CliResult) => void;
    const admitted = new Promise<CliResult>((resolve) => {
      release = resolve;
    });
    const runner = vi.fn<HerdrRunner>(() => admitted);
    const svc = new HerdrService(
      runner,
      () => undefined,
      undefined,
      { shutdownDrainTimeoutMs: 25 },
    );
    try {
      const operation = svc.listSessions("local");
      svc.beginShutdown();
      await expect(svc.ensureServer("local")).resolves.toMatchObject({
        ok: false,
        message: "Herdr service is shutting down",
      });
      expect(runner).toHaveBeenCalledOnce();

      const first = svc.drainOnQuit();
      expect(svc.drainOnQuit()).toBe(first);
      await vi.advanceTimersByTimeAsync(25);
      await expect(first).resolves.toMatchObject({ clean: false, retained: 1 });

      release(ok(JSON.stringify({ sessions: [] })));
      await expect(operation).resolves.toEqual({ ok: true, data: [] });
      await expect(svc.drainOnQuit()).resolves.toMatchObject({ clean: true, retained: 0 });
    } finally {
      vi.clearAllTimers();
      vi.useRealTimers();
    }
  });

});
